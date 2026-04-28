import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';

function AutoRefreshIndicator({ lastUpdated }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.round((Date.now() - lastUpdated.getTime()) / 1000);
  const label = secs < 5 ? 'just now' : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  return (
    <div style={{ textAlign: 'center', color: '#555', fontSize: 12, marginBottom: 12 }}>
      🔄 Updated {label}
    </div>
  );
}
import { db } from '../firebase';
import {
  collection, doc, getDocs, getDoc, updateDoc, setDoc, addDoc, deleteDoc,
  query, where, onSnapshot, Timestamp, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import PodCard from '../components/PodCard';
import { exportTodayXLSX, exportAllXLSX, exportPerPO, exportReconciliation, exportExceptionsXLSX, exportBillingXLSX } from '../utils/export';
import { logAudit } from '../utils/audit';

export default function Dashboard() {
  const [job, setJob] = useState(null);
  const [podData, setPodData] = useState({});
  const [presenceRaw, setPresenceRaw] = useState({});
  const [presence, setPresence] = useState({});
  const presenceRef = useRef({});
  const [operatorStats, setOperatorStats] = useState({});
  const [allScans, setAllScans] = useState([]);
  const [allExceptions, setAllExceptions] = useState([]);
  const allScansRef = useRef([]);
  const allExceptionsRef = useRef([]);
  const [shifts, setShifts] = useState([]);
  const [showExceptions, setShowExceptions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(Notification?.permission === 'granted');
  const [podNotes, setPodNotes] = useState({});
  const [messageInputs, setMessageInputs] = useState({});
  const [showPanel, setShowPanel] = useState(''); // '' | 'exceptions' | 'shifts' | 'leaderboard' | 'hourly' | 'manifest' | 'bols'
  const [manifestData, setManifestData] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selectedExceptions, setSelectedExceptions] = useState(new Set());
  const [viewingPhoto, setViewingPhoto] = useState(null);
  const [bols, setBols] = useState([]);
  const [showBilling, setShowBilling] = useState(false);
  const [pendingPOUploads, setPendingPOUploads] = useState([]);
  const [addingPO, setAddingPO] = useState(null);
  const [billingWeek, setBillingWeek] = useState(() => {
    // Default to last Monday
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
    return d.toISOString().slice(0, 10);
  });
  const [allJobScans, setAllJobScans] = useState([]);
  const [poAlertsDismissed, setPOAlertsDismissed] = useState(new Set());
  const poAlertsNotifiedRef = useRef(new Set());

  // Load active job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const d = snap.docs[0];
        const picked = { id: d.id, ...d.data() };
        if (picked) {
          setJob(picked);
          // Load manifest for completion tracking
          getDocs(collection(db, 'jobs', picked.id, 'manifest')).then((ms) => {
            const cache = {};
            ms.forEach((m) => { cache[m.id] = m.data().poName; });
            setManifestData(cache);
          });
        } else setJob(null);
      } else setJob(null);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Load pending PO uploads
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'po-uploads'), where('status', '==', 'pending')), (snap) => {
      setPendingPOUploads(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  // Presence – store raw snapshots
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'presence'), (snap) => {
      const data = {};
      snap.forEach((d) => { data[d.id] = d.data(); });
      setPresenceRaw(data);
    });
    return unsub;
  }, []);

  // Re-evaluate presence online status every 10s
  useEffect(() => {
    const evaluate = () => {
      const evaluated = {};
      Object.entries(presenceRaw).forEach(([id, p]) => {
        const lastSeen = p.lastSeen?.toDate?.();
        const isRecent = lastSeen && (Date.now() - lastSeen.getTime() < 60000);
        evaluated[id] = { ...p, online: p.online && isRecent };
      });
      setPresence(evaluated);
      presenceRef.current = evaluated;
    };
    evaluate();
    const interval = setInterval(evaluate, 10000);
    return () => clearInterval(interval);
  }, [presenceRaw]);

  // Today's scans
  useEffect(() => {
    if (!job) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(collection(db, 'scans'), where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today)));
    const unsub = onSnapshot(q, (snap) => {
      const scans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllScans(scans);
      allScansRef.current = scans;
      setLastUpdated(new Date());
      const pods = {};
      const opStats = {};
      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;
      for (const podId of job.meta.pods || []) {
        const podScans = scans.filter((s) => s.podId === podId);
        const standardScans = podScans.filter((s) => s.type === 'standard');
        const autoExc = podScans.filter((s) => s.type === 'exception' && s.source !== 'manual');
        const manualScans = podScans.filter((s) => s.source === 'manual');
        const recentStandard = podScans.filter((s) => {
          const ts = s.timestamp?.toDate?.(); return ts && ts.getTime() > fifteenMinAgo && s.type === 'standard';
        });
        const scanners = [...new Set(podScans.map((s) => s.scannerId).filter(Boolean))];
        const minutes = Math.min(15, (now - today.getTime()) / 60000);
        const pace = minutes > 0 && recentStandard.length > 0
          ? Math.round((recentStandard.length / Math.min(15, minutes)) * 60) : 0;
        const targetPerHour = Math.round((job.meta.dailyTarget || 22000) / (job.meta.workingHours || 8) / (job.meta.pods?.length || 5));
        pods[podId] = { id: podId, scanCount: standardScans.length,
          exceptionCount: autoExc.length, manualCount: manualScans.length, pace, targetPerHour, scanners };
        const byOp = {};
        for (const s of podScans) { if (s.scannerId) byOp[s.scannerId] = (byOp[s.scannerId] || 0) + 1; }
        opStats[podId] = byOp;
      }
      setPodData(pods);
      setOperatorStats(opStats);

      // Push alert: check for idle pods (no scans in 5 min from online pods)
      if (notificationsEnabled) {
        for (const podId of job.meta.pods || []) {
          const pr = presenceRef.current[podId]; if (!pr?.online) continue;
          const podScans = scans.filter((s) => s.podId === podId);
          const last = podScans.sort((a, b) => (b.timestamp?.toDate?.()?.getTime() || 0) - (a.timestamp?.toDate?.()?.getTime() || 0))[0];
          if (last) {
            const ts = last.timestamp?.toDate?.();
            if (ts && (Date.now() - ts.getTime()) > 300000) {
              try { new Notification(`Pod ${podId} idle`, { body: `No scans for 5+ minutes`, tag: `idle_${podId}` }); } catch {}
            }
          }
        }
      }
    });
    return unsub;
  }, [job, notificationsEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Exceptions
  useEffect(() => {
    if (!job) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(collection(db, 'exceptions'), where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today)));
    const unsub = onSnapshot(q, (snap) => {
      const exs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllExceptions(exs);
      allExceptionsRef.current = exs;
    });
    return unsub;
  }, [job]);

  // Shifts
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'shifts'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setShifts(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [job]);

  // BOLs
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'bols'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setBols(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')));
    });
    return unsub;
  }, [job]);

  // All job scans (full job progress)
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'scans'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setAllJobScans(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [job]);

  // Auto-export scheduling
  useEffect(() => {
    if (!job) return;
    let exported = false;
    const interval = setInterval(async () => {
      if (exported) return;
      try {
        const schedDoc = await getDoc(doc(db, 'config', 'schedule'));
        if (!schedDoc.exists() || !schedDoc.data().enabled) return;
        const targetTime = schedDoc.data().time || '17:00';
        const now = new Date();
        const [h, m] = targetTime.split(':').map(Number);
        if (now.getHours() === h && now.getMinutes() === m) {
          exported = true;
          exportTodayXLSX(allScansRef.current, allExceptionsRef.current, job.meta);
        }
      } catch {}
    }, 60000);
    return () => clearInterval(interval);
  }, [job]);

  // Enable notifications
  const enableNotifications = async () => {
    try {
      const perm = await Notification.requestPermission();
      setNotificationsEnabled(perm === 'granted');
    } catch {}
  };

  // Send message to pod
  const sendMessage = async (podId) => {
    const msg = messageInputs[podId]?.trim();
    if (!msg) return;
    try {
      await setDoc(doc(db, 'presence', podId), { message: msg }, { merge: true });
      setMessageInputs({ ...messageInputs, [podId]: '' });
      logAudit('send_message', { podId, message: msg });
    } catch {}
  };

  // Save pod note
  const saveNote = async (podId, note) => {
    setPodNotes({ ...podNotes, [podId]: note });
    try { await setDoc(doc(db, 'presence', podId), { notes: note }, { merge: true }); } catch {}
  };

  // Delete exception
  const removeException = async (exId) => {
    if (!confirm('Remove this exception? It will be removed from customer view too.')) return;
    try {
      await deleteDoc(doc(db, 'exceptions', exId));
      logAudit('delete_exception', { exceptionId: exId });
    } catch {}
  };

  // Bulk delete exceptions
  const bulkDelete = async () => {
    if (selectedExceptions.size === 0) return;
    if (!confirm(`Remove ${selectedExceptions.size} exception(s)? They will be removed from customer view too.`)) return;
    const ids = [...selectedExceptions];
    for (const exId of ids) {
      try { await deleteDoc(doc(db, 'exceptions', exId)); } catch {}
    }
    logAudit('bulk_delete_exceptions', { count: ids.length });
    setSelectedExceptions(new Set());
  };

  // Add customer PO upload to active job
  const addPOToJob = async (upload) => {
    if (!job) return alert('No active job');
    if (!confirm(`Add ${(upload.poNames || []).join(', ')} (${(upload.isbnCount || 0).toLocaleString()} ISBNs) to the current job?`)) return;
    setAddingPO(upload.id);
    try {
      // Read ISBNs from po-upload manifest
      const snap = await getDocs(collection(db, 'po-uploads', upload.id, 'manifest'));
      const BATCH_SIZE = 400;
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        docs.slice(i, i + BATCH_SIZE).forEach((d) => {
          batch.set(doc(db, 'jobs', job.id, 'manifest', d.id), d.data());
        });
        await batch.commit();
      }
      // Assign colors for new POs (use customer-chosen colors if available)
      const existingColors = job.poColors || {};
      const newColors = { ...existingColors };
      let colorIdx = Object.keys(existingColors).length;
      const DEFAULT_CLR = ['#EF4444','#3B82F6','#EAB308','#22C55E','#F97316','#A855F7','#EC4899','#14B8A6','#92400E','#CA8A04'];
      const savedColors = upload.poColors || {};
      (upload.poNames || []).forEach((po) => {
        if (!newColors[po]) { newColors[po] = savedColors[po] || DEFAULT_CLR[colorIdx % DEFAULT_CLR.length]; colorIdx++; }
      });
      await setDoc(doc(db, 'jobs', job.id), { poColors: newColors }, { merge: true });
      // Mark upload as added
      await updateDoc(doc(db, 'po-uploads', upload.id), { status: 'added', jobId: job.id, addedAt: serverTimestamp() });
      // Refresh manifest cache
      const ms = await getDocs(collection(db, 'jobs', job.id, 'manifest'));
      const cache = {};
      ms.forEach((m) => { cache[m.id] = m.data().poName; });
      setManifestData(cache);
      logAudit('add_po_to_job', { uploadId: upload.id, poNames: upload.poNames, jobId: job.id });
    } catch (err) {
      alert('Failed to add PO: ' + err.message);
    }
    setAddingPO(null);
  };

  // Toggle exception selection
  const toggleException = (exId) => {
    setSelectedExceptions((prev) => {
      const next = new Set(prev);
      if (next.has(exId)) next.delete(exId); else next.add(exId);
      return next;
    });
  };

  // Export exceptions for customer
  const handleExportExceptions = () => {
    if (!job) return;
    exportExceptionsXLSX(allScans, allExceptions, job.meta);
  };

  // Combined exception log — merged and sorted newest-first for live feed
  const combinedExceptions = useMemo(() => {
    const auto = allScans.filter((s) => s.type === 'exception').map((s) => ({
      id: s.id, kind: 'auto', isbn: s.isbn, podId: s.podId, scannerId: s.scannerId,
      label: s.poName === 'EXCEPTIONS' ? 'NOT IN MANIFEST' : s.source === 'manual' ? 'MANUAL ENTRY' : 'EXCEPTION',
      title: null, photo: null, timestamp: s.timestamp,
    }));
    const manual = allExceptions.map((ex) => ({
      id: ex.id, kind: 'manual', isbn: ex.isbn || '', podId: ex.podId, scannerId: ex.scannerId,
      label: ex.reason, title: ex.title || null, photo: ex.photo || null, timestamp: ex.timestamp,
    }));
    return [...auto, ...manual].sort((a, b) => {
      const ta = a.timestamp?.toDate?.()?.getTime() || 0;
      const tb = b.timestamp?.toDate?.()?.getTime() || 0;
      return tb - ta;
    });
  }, [allScans, allExceptions]);

  // Leaderboard
  const leaderboard = useMemo(() => {
    const byOp = {};
    for (const s of allScans) { if (s.scannerId) byOp[s.scannerId] = (byOp[s.scannerId] || 0) + 1; }
    return Object.entries(byOp).sort((a, b) => b[1] - a[1]).map(([name, count], i) => ({ name, count, rank: i + 1 }));
  }, [allScans]);

  // Hourly breakdown
  const hourlyData = useMemo(() => {
    const hours = {};
    for (const s of allScans) {
      const d = s.timestamp?.toDate?.(); if (!d) continue;
      hours[d.getHours()] = (hours[d.getHours()] || 0) + 1;
    }
    const arr = [];
    for (let h = 6; h <= 22; h++) arr.push({ hour: h, count: hours[h] || 0 });
    return arr;
  }, [allScans]);
  const maxHourly = Math.max(1, ...hourlyData.map((d) => d.count));

  // Manifest completion
  const manifestCompletion = useMemo(() => {
    if (!Object.keys(manifestData).length) return null;
    const scannedIsbns = new Set(allScans.filter((s) => s.type === 'standard').map((s) => s.isbn));
    const total = Object.keys(manifestData).length;
    const found = [...Object.keys(manifestData)].filter((isbn) => scannedIsbns.has(isbn)).length;
    // By PO
    const byPO = {};
    for (const [isbn, po] of Object.entries(manifestData)) {
      if (!byPO[po]) byPO[po] = { total: 0, found: 0 };
      byPO[po].total++;
      if (scannedIsbns.has(isbn)) byPO[po].found++;
    }
    return { total, found, pct: Math.round((found / total) * 100), byPO };
  }, [manifestData, allScans]);

  // Total job progress
  const jobProgress = useMemo(() => {
    const standard = allJobScans.filter((s) => s.type === 'standard');
    const exceptionScans = allJobScans.filter((s) => s.type === 'exception');
    const totalScanned = standard.length;
    const totalExceptions = exceptionScans.length;
    const totalExpected = Object.keys(manifestData).length || null;
    const byPO = {};
    for (const s of standard) {
      const po = s.poName || 'Unassigned';
      if (!byPO[po]) byPO[po] = { scanned: 0, expected: 0 };
      byPO[po].scanned++;
    }
    if (totalExpected) {
      const poExpected = {};
      for (const po of Object.values(manifestData)) {
        poExpected[po] = (poExpected[po] || 0) + 1;
      }
      for (const [po, count] of Object.entries(poExpected)) {
        if (!byPO[po]) byPO[po] = { scanned: 0, expected: 0 };
        byPO[po].expected = count;
      }
    }
    const pct = totalExpected ? Math.round((totalScanned / totalExpected) * 100) : null;
    return { totalScanned, totalExceptions, totalExpected, pct, byPO };
  }, [allJobScans, manifestData]);

  // Labor efficiency
  const laborMetrics = useMemo(() => {
    if (!shifts.length) return null;
    let totalHours = 0;
    for (const s of shifts) {
      if (s.startTime && s.endTime) {
        const start = s.startTime.toDate ? s.startTime.toDate() : new Date(s.startTime);
        const end = s.endTime.toDate ? s.endTime.toDate() : new Date(s.endTime);
        totalHours += (end - start) / 3600000;
      }
    }
    return { totalHours: totalHours.toFixed(1), scansPerHour: totalHours > 0 ? Math.round(allScans.length / totalHours) : 0 };
  }, [shifts, allScans]);

  // PO Completion Alerts
  const poAlerts = useMemo(() => {
    if (!manifestCompletion?.byPO) return [];
    const alerts = [];
    for (const [po, data] of Object.entries(manifestCompletion.byPO)) {
      const pct = data.total > 0 ? Math.round((data.found / data.total) * 100) : 0;
      if (pct >= 95) {
        alerts.push({ po, pct, found: data.found, total: data.total, complete: pct >= 100 });
      }
    }
    return alerts.sort((a, b) => b.pct - a.pct);
  }, [manifestCompletion]);

  // Push browser notification for PO completion milestones
  useEffect(() => {
    if (!notificationsEnabled || !poAlerts.length) return;
    for (const alert of poAlerts) {
      const key = `${alert.po}_${alert.complete ? '100' : '95'}`;
      if (!poAlertsNotifiedRef.current.has(key)) {
        poAlertsNotifiedRef.current.add(key);
        try {
          new Notification(`PO ${alert.po} — ${alert.pct}%`, {
            body: alert.complete ? `✅ Complete! ${alert.found}/${alert.total} scanned` : `Almost done: ${alert.found}/${alert.total} scanned`,
            tag: `po_${alert.po}_${alert.pct}`,
          });
        } catch {}
      }
    }
  }, [poAlerts, notificationsEnabled]);

  // Exception trend (hourly exception rate)
  const exceptionTrend = useMemo(() => {
    const hours = {};
    const scanHours = {};
    for (const s of allScans) {
      const d = s.timestamp?.toDate?.(); if (!d) continue;
      const h = d.getHours();
      scanHours[h] = (scanHours[h] || 0) + 1;
      if (s.type === 'exception') hours[h] = (hours[h] || 0) + 1;
    }
    for (const ex of allExceptions) {
      const d = ex.timestamp?.toDate?.(); if (!d) continue;
      const h = d.getHours();
      hours[h] = (hours[h] || 0) + 1;
    }
    const arr = [];
    for (let h = 6; h <= 22; h++) {
      const excCount = hours[h] || 0;
      const totalCount = scanHours[h] || 0;
      const rate = totalCount > 0 ? Math.round((excCount / totalCount) * 100) : 0;
      arr.push({ hour: h, exceptions: excCount, total: totalCount, rate });
    }
    return arr;
  }, [allScans, allExceptions]);

  // Totals
  const totalScans = Object.values(podData).reduce((sum, p) => sum + p.scanCount, 0);
  const totalManual = Object.values(podData).reduce((sum, p) => sum + (p.manualCount || 0), 0);
  const totalAutoExceptions = Object.values(podData).reduce((sum, p) => sum + p.exceptionCount, 0);
  const totalExceptions = totalAutoExceptions + allExceptions.length;
  const totalPace = Object.values(podData).reduce((sum, p) => sum + p.pace, 0);
  const dailyTarget = job?.meta?.dailyTarget || 22000;
  const remaining = Math.max(0, dailyTarget - (totalScans + totalAutoExceptions + totalManual));
  const estHoursLeft = totalPace > 0 ? (remaining / totalPace).toFixed(1) : '—';

  const handleExportToday = async () => {
    if (!job) return; setExporting(true);
    try { exportTodayXLSX(allScans, allExceptions, job.meta); } catch (err) { alert('Export failed: ' + err.message); }
    setExporting(false);
  };
  const handleExportAll = async () => {
    if (!job) return; setExporting(true);
    try {
      const scanSnap = await getDocs(query(collection(db, 'scans'), where('jobId', '==', job.id)));
      const scans = scanSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const excSnap = await getDocs(query(collection(db, 'exceptions'), where('jobId', '==', job.id)));
      const excs = excSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      exportAllXLSX(scans, excs, job.meta);
      if (job.meta.mode === 'multi') {
        exportPerPO(scans, excs, job.meta);
      }
    } catch (err) { alert('Export failed: ' + err.message); }
    setExporting(false);
  };
  const handleExportReconciliation = () => {
    if (!job || !Object.keys(manifestData).length) return;
    exportReconciliation(allScans, manifestData, job.meta);
  };

  const handleBillingExport = async () => {
    if (!job) return;
    setExporting(true);
    try {
      const weekStart = new Date(billingWeek + 'T00:00:00');
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const q1 = query(collection(db, 'scans'), where('jobId', '==', job.id),
        where('timestamp', '>=', Timestamp.fromDate(weekStart)),
        where('timestamp', '<', Timestamp.fromDate(weekEnd)));
      const q2 = query(collection(db, 'exceptions'), where('jobId', '==', job.id),
        where('timestamp', '>=', Timestamp.fromDate(weekStart)),
        where('timestamp', '<', Timestamp.fromDate(weekEnd)));
      const [scanSnap, excSnap] = await Promise.all([getDocs(q1), getDocs(q2)]);
      const scans = scanSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const excs = excSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const standardCount = scans.filter((s) => s.type === 'standard' && s.source !== 'manual').length;
      const exceptionCount = scans.filter((s) => s.type === 'exception' || s.source === 'manual').length + excs.length;
      const totalAmount = standardCount * 0.40 + exceptionCount * 0.60;
      const { buf, fileName } = exportBillingXLSX(scans, excs, job.meta, weekStart, weekEnd);
      // Convert to base64 for Firestore storage
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      // Save to billing-reports collection for Customer Portal access
      await addDoc(collection(db, 'billing-reports'), {
        jobId: job.id,
        jobName: job.meta.name || 'Unknown',
        weekStart: Timestamp.fromDate(weekStart),
        weekEnd: Timestamp.fromDate(weekEnd),
        standardCount,
        exceptionCount,
        totalUnits: standardCount + exceptionCount,
        totalAmount,
        fileName,
        fileData: base64,
        createdAt: serverTimestamp(),
      });
      logAudit('billing_export', { weekStart: weekStart.toISOString(), weekEnd: weekEnd.toISOString(), scans: scans.length, exceptions: excs.length });
    } catch (err) { alert('Billing export failed: ' + err.message); }
    setExporting(false);
    setShowBilling(false);
  };

  // ─── Daily Summary (save to Firestore for email integration) ───
  const generateDailySummary = async () => {
    if (!job) return;
    const today = new Date().toLocaleDateString();
    const standardCount = allScans.filter((s) => s.type === 'standard' && s.source !== 'manual').length;
    const manualCount = allScans.filter((s) => s.source === 'manual').length;
    const exceptionCount = allScans.filter((s) => s.type === 'exception').length + allExceptions.length;

    // PO progress
    const poProgress = {};
    if (manifestCompletion?.byPO) {
      for (const [po, d] of Object.entries(manifestCompletion.byPO)) {
        poProgress[po] = { scanned: d.found, total: d.total, pct: d.total > 0 ? Math.round((d.found / d.total) * 100) : 0 };
      }
    }

    // Labor
    let laborHours = 0;
    for (const s of shifts) {
      if (s.startTime && s.endTime) {
        const start = s.startTime.toDate ? s.startTime.toDate() : new Date(s.startTime);
        const end = s.endTime.toDate ? s.endTime.toDate() : new Date(s.endTime);
        laborHours += (end - start) / 3600000;
      }
    }

    // Top operators
    const byOp = {};
    for (const s of allScans) { if (s.scannerId) byOp[s.scannerId] = (byOp[s.scannerId] || 0) + 1; }
    const topOperators = Object.entries(byOp).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const summary = {
      jobId: job.id,
      jobName: job.meta.name || 'Unknown',
      date: today,
      totalScans: standardCount + manualCount + exceptionCount,
      standardScans: standardCount,
      manualEntries: manualCount,
      exceptions: exceptionCount,
      dailyTarget: job.meta.dailyTarget || 22000,
      pctOfTarget: Math.round(((standardCount + manualCount + exceptionCount) / (job.meta.dailyTarget || 22000)) * 100),
      poProgress,
      laborHours: parseFloat(laborHours.toFixed(1)),
      scansPerHour: laborHours > 0 ? Math.round(allScans.length / laborHours) : 0,
      topOperators,
      createdAt: serverTimestamp(),
    };

    try {
      await addDoc(collection(db, 'daily-summaries'), summary);
      alert(`✅ Daily summary saved for ${today}. Connect a Firebase email extension to auto-send.`);
      logAudit('daily_summary', { date: today, totalScans: summary.totalScans });
    } catch (err) { alert('Failed to save summary: ' + err.message); }
  };

  if (loading) return <div style={st.container}><p style={st.text}>Loading...</p></div>;
  if (!job) return (
    <div style={st.container}>
      <Link to="/" style={st.backLink}>← Back to Home</Link>
      <h1 style={st.title}>Dashboard</h1>
      <p style={st.text}>No active job. <Link to="/setup" style={{ color: '#3B82F6' }}>Go to Setup</Link></p>
    </div>
  );

  return (
    <div style={st.container}>
      <Link to="/" style={st.backLink}>← Back to Home</Link>

      <div style={st.headerRow}>
        <div>
          <h1 style={st.title}>{job.meta.name}</h1>
          <p style={st.subtitle}>
            {job.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} · Target: {dailyTarget.toLocaleString()}
            {job.meta.location && ` · ${job.meta.location}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={handleExportToday} disabled={exporting} style={{ ...st.exportBtn, opacity: exporting ? 0.5 : 1 }}>
            {exporting ? '...' : '📊 Today'}
          </button>
          <button onClick={handleExportAll} disabled={exporting} style={{ ...st.exportBtn, opacity: exporting ? 0.5 : 1 }}>
            {exporting ? '...' : '📊 All'}
          </button>
          <button onClick={() => setShowBilling(true)} style={{ ...st.exportBtn, borderColor: '#22C55E', color: '#22C55E' }}>💰 Billing</button>
          {manifestCompletion && (
            <button onClick={handleExportReconciliation} style={st.exportBtn}>📋 Reconciliation</button>
          )}
          <button onClick={generateDailySummary} style={{ ...st.exportBtn, borderColor: '#A855F7', color: '#A855F7' }}>📧 Daily Summary</button>
          <Link to="/kiosk" style={{ ...st.exportBtn, textDecoration: 'none' }}>📺 Kiosk</Link>
          <Link to="/setup" style={st.setupLink}>Setup</Link>
        </div>
      </div>

      {/* Billing Export Modal */}
      {showBilling && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 16, padding: 32, maxWidth: 440, width: '100%', border: '2px solid #22C55E' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ color: '#fff', margin: 0, fontSize: 22 }}>💰 Weekly Billing Export</h2>
              <button onClick={() => setShowBilling(false)}
                style={{ background: 'none', border: '1px solid #555', borderRadius: 8, color: '#888', fontSize: 18, width: 36, height: 36, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
            <p style={{ color: '#aaa', fontSize: 14, marginTop: 0, marginBottom: 16 }}>
              Select the week start date (Monday). The export covers 7 days from that date.
            </p>
            <label style={{ color: '#ccc', fontSize: 14, fontWeight: 600, display: 'block', marginBottom: 6 }}>Week starting:</label>
            <input type="date" value={billingWeek}
              onChange={(e) => setBillingWeek(e.target.value)}
              style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #444', backgroundColor: '#0a0a0a', color: '#fff', fontSize: 16, marginBottom: 16, boxSizing: 'border-box' }} />
            <p style={{ color: '#888', fontSize: 13, margin: '0 0 16px' }}>
              📅 {new Date(billingWeek + 'T00:00:00').toLocaleDateString()} – {new Date(new Date(billingWeek + 'T00:00:00').getTime() + 6 * 86400000).toLocaleDateString()}
            </p>
            <p style={{ color: '#666', fontSize: 12, marginBottom: 20, lineHeight: 1.5 }}>
              The XLSX includes: <strong>Billing Summary</strong> (regular scan count + exception count), <strong>Daily Breakdown</strong>, <strong>By Pod</strong>, and <strong>By Operator</strong> sheets. Fill in your rates in the Rate/Amount columns.
            </p>
            <div style={{ backgroundColor: '#14532d', border: '1px solid #22C55E', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#86efac', fontSize: 13 }}>
              📋 This report will also be visible to the customer in their portal.
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={handleBillingExport} disabled={exporting}
                style={{ flex: 1, padding: '14px 20px', borderRadius: 10, border: 'none', backgroundColor: '#22C55E', color: '#fff', fontSize: 16, fontWeight: 700, cursor: exporting ? 'wait' : 'pointer', opacity: exporting ? 0.6 : 1 }}>
                {exporting ? '⏳ Generating...' : '📥 Download Billing XLSX'}
              </button>
              <button onClick={() => setShowBilling(false)}
                style={{ padding: '14px 20px', borderRadius: 10, border: '1px solid #555', backgroundColor: 'transparent', color: '#aaa', fontSize: 14, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Summary bar */}
      <div style={st.summaryRow}>
        <div style={st.summaryItem}>
          <div style={st.summaryValue}>{totalScans.toLocaleString()}</div>
          <div style={st.summaryLabel}>Scanned / {dailyTarget.toLocaleString()}</div>
        </div>
        <div style={st.summaryItem}>
          <div style={{ ...st.summaryValue, color: totalExceptions > 0 ? '#F97316' : '#888' }}>{totalExceptions}</div>
          <div style={st.summaryLabel}>Total Exceptions</div>
        </div>
        <div style={st.summaryItem}>
          <div style={{ ...st.summaryValue, color: totalManual > 0 ? '#3B82F6' : '#888' }}>{totalManual}</div>
          <div style={st.summaryLabel}>Manual Entries</div>
        </div>
        <div style={st.summaryItem}>
          <div style={st.summaryValue}>{totalPace}</div>
          <div style={st.summaryLabel}>Combined Scans/hr</div>
        </div>
        <div style={st.summaryItem}>
          <div style={st.summaryValue}>{estHoursLeft}</div>
          <div style={st.summaryLabel}>Est. Hours Left</div>
        </div>
        {laborMetrics && (
          <div style={st.summaryItem}>
            <div style={{ ...st.summaryValue, color: '#818cf8' }}>{laborMetrics.scansPerHour}</div>
            <div style={st.summaryLabel}>Scans/Labor Hr</div>
          </div>
        )}
        <div style={st.summaryItem}>
          <div style={{ ...st.summaryValue, color: '#F59E0B' }}>{totalScans > 0 ? `${Math.ceil(totalScans / 2000)}–${Math.ceil(totalScans / 1500)}` : '—'}</div>
          <div style={st.summaryLabel}>Est. Gaylords</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={st.progressContainer}>
        <div style={{ ...st.progressBar, width: `${Math.min(100, (totalScans / dailyTarget) * 100)}%` }} />
      </div>

      {/* Auto-refresh indicator */}
      {lastUpdated && (
        <AutoRefreshIndicator lastUpdated={lastUpdated} />
      )}

      {/* Pending PO Uploads — top of dashboard */}
      {pendingPOUploads.length > 0 && (
        <div style={{ backgroundColor: '#1a1a2e', border: '2px solid #3B82F6', borderRadius: 10, padding: 16, marginBottom: 16, animation: 'pulse 2s infinite' }}>
          <p style={{ color: '#93C5FD', fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>
            📦 {pendingPOUploads.length} Customer PO Upload{pendingPOUploads.length > 1 ? 's' : ''} Pending
          </p>
          {pendingPOUploads.map((up) => (
            <div key={up.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #333' }}>
              <div>
                <span style={{ color: '#ccc', fontSize: 14, fontWeight: 600 }}>{(up.poNames || []).join(', ')}</span>
                <span style={{ color: '#888', fontSize: 13, marginLeft: 10 }}>{(up.isbnCount || 0).toLocaleString()} ISBNs</span>
                <span style={{ color: '#666', fontSize: 12, marginLeft: 10 }}>
                  {up.uploadedAt?.toDate?.()?.toLocaleString() || ''}
                </span>
              </div>
              <button onClick={() => addPOToJob(up)} disabled={addingPO === up.id}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', backgroundColor: '#3B82F6', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: addingPO === up.id ? 0.6 : 1 }}>
                {addingPO === up.id ? 'Adding...' : '+ Add to Job'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Notification toggle */}
      {!notificationsEnabled && typeof Notification !== 'undefined' && (
        <button onClick={enableNotifications} style={{ ...st.exportBtn, marginBottom: 16 }}>
          🔔 Enable Push Alerts
        </button>
      )}

      {/* Job Progress */}
      {allJobScans.length > 0 && (
        <div style={{ backgroundColor: '#1a1a1a', borderRadius: 10, padding: 16, border: '1px solid #333', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ color: '#ccc', fontSize: 14, margin: 0 }}>📊 Total Job Progress</h3>
            <span style={{ color: '#22C55E', fontWeight: 700, fontSize: 14 }}>
              {jobProgress.totalScanned.toLocaleString()} scanned
              {jobProgress.totalExpected ? ` / ${jobProgress.totalExpected.toLocaleString()} expected (${jobProgress.pct}%)` : ''}
            </span>
          </div>
          {jobProgress.totalExpected && (
            <div style={{ height: 6, backgroundColor: '#333', borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{ height: '100%', backgroundColor: jobProgress.pct >= 100 ? '#22C55E' : '#3B82F6', width: `${Math.min(100, jobProgress.pct)}%`, borderRadius: 3, transition: 'width 0.5s ease' }} />
            </div>
          )}
          {job.meta.mode === 'multi' && Object.keys(jobProgress.byPO).length > 1 && (
            <div style={{ marginTop: 8 }}>
              {Object.entries(jobProgress.byPO)
                .filter(([po]) => po !== 'EXCEPTIONS' && po !== 'Unassigned')
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([po, data]) => {
                  const poPct = data.expected > 0 ? Math.round((data.scanned / data.expected) * 100) : null;
                  const color = job.poColors?.[po] || '#3B82F6';
                  return (
                    <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }} />
                      <span style={{ color: '#aaa', fontSize: 13, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{po}</span>
                      <div style={{ flex: 1, height: 6, backgroundColor: '#333', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', backgroundColor: poPct !== null && poPct >= 100 ? '#22C55E' : color, width: `${poPct !== null ? Math.min(100, poPct) : 100}%`, borderRadius: 3 }} />
                      </div>
                      <span style={{ color: '#888', fontSize: 12, minWidth: 100, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {data.scanned.toLocaleString()}{data.expected > 0 ? ` / ${data.expected.toLocaleString()}` : ''}
                        {poPct !== null ? ` (${poPct}%)` : ''}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
          {jobProgress.totalExceptions > 0 && (
            <div style={{ marginTop: 8, color: '#F97316', fontSize: 13 }}>
              ⚠ {jobProgress.totalExceptions.toLocaleString()} exception scan{jobProgress.totalExceptions !== 1 ? 's' : ''} (not in manifest)
            </div>
          )}
        </div>
      )}

      {/* Manifest completion */}
      {manifestCompletion && (
        <div style={{ backgroundColor: '#1a1a1a', borderRadius: 10, padding: 16, border: '1px solid #333', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ color: '#ccc', fontSize: 14, margin: 0 }}>📋 Manifest Completion</h3>
            <span style={{ color: '#3B82F6', fontWeight: 700 }}>{manifestCompletion.pct}% ({manifestCompletion.found}/{manifestCompletion.total})</span>
          </div>
          <div style={{ height: 6, backgroundColor: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', backgroundColor: '#3B82F6', width: `${manifestCompletion.pct}%`, borderRadius: 3 }} />
          </div>
          <button onClick={() => setShowPanel(showPanel === 'manifest' ? '' : 'manifest')}
            style={{ background: 'none', border: 'none', color: '#888', fontSize: 12, cursor: 'pointer', marginTop: 8, padding: 0, minHeight: 24 }}>
            {showPanel === 'manifest' ? 'Hide details' : 'Show by PO'}
          </button>
          {showPanel === 'manifest' && (
            <div style={{ marginTop: 8 }}>
              {Object.entries(manifestCompletion.byPO).sort((a, b) => a[0].localeCompare(b[0])).map(([po, data]) => (
                <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: '#aaa', fontSize: 13, minWidth: 100 }}>{po}</span>
                  <div style={{ flex: 1, height: 6, backgroundColor: '#333', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', backgroundColor: data.found === data.total ? '#22C55E' : '#3B82F6', width: `${Math.round((data.found / data.total) * 100)}%` }} />
                  </div>
                  <span style={{ color: '#888', fontSize: 12, minWidth: 60, textAlign: 'right' }}>{data.found}/{data.total}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pod grid */}
      <div style={st.podGrid}>
        {(job.meta.pods || []).map((podId) => {
          const manualExc = allExceptions.filter((e) => e.podId === podId).length;
          const pod = podData[podId] || { id: podId, scanCount: 0, exceptionCount: 0, pace: 0, targetPerHour: 0, scanners: [] };
          return (
          <div key={podId}>
            <PodCard
              pod={{ ...pod, exceptionCount: pod.exceptionCount + manualExc }}
              presence={presence[podId]}
              operatorStats={operatorStats[podId]}
              notes={podNotes[podId] || presence[podId]?.notes || ''}
              onNotesChange={(note) => saveNote(podId, note)}
            />
            {/* Send message */}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input type="text" value={messageInputs[podId] || ''} placeholder="Message to pod..."
                onChange={(e) => setMessageInputs({ ...messageInputs, [podId]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(podId); }}
                style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #333', backgroundColor: '#1a1a1a', color: '#fff', fontSize: 13 }} />
              <button onClick={() => sendMessage(podId)}
                style={{ padding: '6px 12px', borderRadius: 6, border: 'none', backgroundColor: '#3B82F6', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Send
              </button>
            </div>
          </div>
        )})}
      </div>

      {/* PO Completion Alerts */}
      {poAlerts.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {poAlerts.filter((a) => !poAlertsDismissed.has(a.po)).map((a) => (
            <div key={a.po} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderRadius: 10,
              backgroundColor: a.complete ? '#052e16' : '#422006',
              border: `1px solid ${a.complete ? '#22C55E' : '#F59E0B'}`,
            }}>
              <span style={{ fontSize: 20 }}>{a.complete ? '✅' : '⏳'}</span>
              <div style={{ flex: 1 }}>
                <span style={{ color: a.complete ? '#86efac' : '#fde68a', fontWeight: 800, fontSize: 14 }}>
                  {a.po} — {a.pct}%
                </span>
                <span style={{ color: '#999', fontSize: 13, marginLeft: 8 }}>
                  {a.found.toLocaleString()}/{a.total.toLocaleString()} scanned
                  {a.complete ? ' · Ready to close gaylord!' : ' · Almost done'}
                </span>
              </div>
              <button onClick={() => setPOAlertsDismissed((prev) => new Set([...prev, a.po]))}
                style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16, padding: 4 }}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Panel toggles */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24, marginBottom: 12 }}>
        {[
          ['exceptions', `Exceptions (${combinedExceptions.length})`],
          ['leaderboard', '🏆 Leaderboard'],
          ['hourly', '📊 Hourly'],
          ['excTrend', '📈 Exception Trend'],
          ['shifts', '⏱ Shifts'],
          ['bols', `🚛 BOLs (${bols.length})`],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setShowPanel(showPanel === key ? '' : key)}
            style={{ ...st.panelBtn, ...(showPanel === key ? { borderColor: '#3B82F6', color: '#3B82F6' } : {}) }}>
            {label}
          </button>
        ))}
      </div>

      {/* Exceptions panel */}
      {showPanel === 'exceptions' && (
        <div style={st.panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #333' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {selectedExceptions.size > 0 && (
                <button onClick={bulkDelete}
                  style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #EF4444', backgroundColor: 'transparent', color: '#EF4444', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  🗑 Remove Selected ({selectedExceptions.size})
                </button>
              )}
            </div>
            <button onClick={handleExportExceptions}
              style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #3B82F6', backgroundColor: 'transparent', color: '#3B82F6', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              📥 Export for Customer
            </button>
          </div>
          {combinedExceptions.map((ex) => (
            <div key={ex.id} style={st.exRow}>
              {ex.kind === 'manual' && (
                <input type="checkbox" checked={selectedExceptions.has(ex.id)}
                  onChange={() => toggleException(ex.id)}
                  style={{ accentColor: '#3B82F6', cursor: 'pointer', width: 16, height: 16 }} />
              )}
              {ex.photo && (
                <img src={ex.photo} alt="Exception"
                  onClick={() => setViewingPhoto(ex.photo)}
                  style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', border: '1px solid #444', cursor: 'pointer', flexShrink: 0 }} />
              )}
              <span style={st.exTag}>{ex.label}</span>
              <span style={st.exDetail}>
                {ex.isbn ? `ISBN: ${ex.isbn}` : ''}{ex.title ? ` "${ex.title}"` : ''} · Pod {ex.podId} · {ex.scannerId}
              </span>
              <span style={st.exTime}>{ex.timestamp?.toDate?.()?.toLocaleTimeString() || '—'}</span>
              {ex.kind === 'manual' && (
                <button onClick={() => removeException(ex.id)}
                  style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #EF4444', backgroundColor: 'transparent', color: '#EF4444', fontSize: 11, cursor: 'pointer', marginLeft: 8, fontWeight: 600 }}>
                  🗑 Remove
                </button>
              )}
            </div>
          ))}
          {combinedExceptions.length === 0 && <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No exceptions today</p>}
        </div>
      )}

      {/* Photo viewer overlay */}
      {viewingPhoto && (
        <div onClick={() => setViewingPhoto(null)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, cursor: 'pointer', padding: 24 }}>
          <img src={viewingPhoto} alt="Exception photo" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 12, border: '2px solid #444' }} />
        </div>
      )}

      {/* Leaderboard panel */}
      {showPanel === 'leaderboard' && (
        <div style={st.panel}>
          {leaderboard.map((l) => (
            <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #222' }}>
              <span style={{ fontSize: 20, width: 36, textAlign: 'center',
                color: l.rank === 1 ? '#EAB308' : l.rank === 2 ? '#9CA3AF' : l.rank === 3 ? '#D97706' : '#666' }}>
                {l.rank <= 3 ? ['🥇', '🥈', '🥉'][l.rank - 1] : `#${l.rank}`}
              </span>
              <span style={{ flex: 1, color: '#ddd', fontSize: 16, fontWeight: 600 }}>{l.name}</span>
              <span style={{ color: '#fff', fontSize: 18, fontWeight: 800, fontFamily: 'monospace' }}>{l.count.toLocaleString()}</span>
            </div>
          ))}
          {leaderboard.length === 0 && <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No scans yet</p>}
        </div>
      )}

      {/* Hourly panel */}
      {showPanel === 'hourly' && (
        <div style={st.panel}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 140, padding: '0 16px' }}>
            {hourlyData.map((d) => (
              <div key={d.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: 10, color: '#888', marginBottom: 4 }}>{d.count || ''}</div>
                <div style={{
                  width: '100%', maxWidth: 36,
                  height: `${(d.count / maxHourly) * 100}%`, minHeight: d.count > 0 ? 4 : 1,
                  backgroundColor: d.hour === new Date().getHours() ? '#EAB308' : '#3B82F6',
                  borderRadius: '4px 4px 0 0',
                }} />
                <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>{d.hour}h</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shifts panel */}
      {showPanel === 'shifts' && (
        <div style={st.panel}>
          {shifts.sort((a, b) => (b.startTime?.toDate?.()?.getTime() || 0) - (a.startTime?.toDate?.()?.getTime() || 0))
            .slice(0, 20).map((s) => {
              const start = s.startTime?.toDate?.();
              const end = s.endTime?.toDate?.();
              const hours = start && end ? ((end - start) / 3600000).toFixed(1) : 'active';
              return (
                <div key={s.id} style={{ display: 'flex', gap: 12, padding: '10px 16px', borderBottom: '1px solid #222', alignItems: 'center' }}>
                  <span style={{ color: !end ? '#22C55E' : '#888', fontSize: 12, fontWeight: 700 }}>{!end ? '● ACTIVE' : '○ ENDED'}</span>
                  <span style={{ color: '#ddd', fontSize: 14, fontWeight: 600 }}>{s.operatorName}</span>
                  <span style={{ color: '#888', fontSize: 13 }}>Pod {s.podId}</span>
                  <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12 }}>
                    {start?.toLocaleTimeString() || '—'} - {end?.toLocaleTimeString() || 'now'} ({end ? `${hours}h` : 'active'})
                  </span>
                  <span style={{ color: '#666', fontSize: 12 }}>{s.totalScans || 0} scans</span>
                </div>
              );
            })}
          {shifts.length === 0 && <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No shifts recorded</p>}
        </div>
      )}

      {/* BOLs panel */}
      {/* Exception Trend panel */}
      {showPanel === 'excTrend' && (
        <div style={st.panel}>
          <div style={{ padding: '12px 16px' }}>
            <p style={{ color: '#888', fontSize: 13, margin: '0 0 12px' }}>
              Exception rate by hour — spikes may indicate manifest issues, wrong gaylord, or process problems
            </p>
            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 120 }}>
              {exceptionTrend.map((d) => {
                const maxRate = Math.max(1, ...exceptionTrend.map((x) => x.rate));
                const barH = d.total > 0 ? Math.max(4, (d.rate / maxRate) * 100) : 0;
                const isSpike = d.rate > 15;
                return (
                  <div key={d.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ fontSize: 9, color: isSpike ? '#EF4444' : '#888', fontWeight: 700, marginBottom: 2 }}>
                      {d.total > 0 ? `${d.rate}%` : ''}
                    </div>
                    <div style={{
                      width: '80%', height: `${barH}%`, minHeight: d.total > 0 ? 4 : 1,
                      backgroundColor: isSpike ? '#EF4444' : d.rate > 8 ? '#F59E0B' : '#3B82F6',
                      borderRadius: '3px 3px 0 0', transition: 'height 0.3s',
                    }} title={`${d.hour}:00 — ${d.exceptions} exceptions / ${d.total} scans (${d.rate}%)`} />
                    <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{d.hour}h</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 12, justifyContent: 'center' }}>
              <span style={{ fontSize: 11, color: '#3B82F6' }}>● Normal (&lt;8%)</span>
              <span style={{ fontSize: 11, color: '#F59E0B' }}>● Elevated (8-15%)</span>
              <span style={{ fontSize: 11, color: '#EF4444' }}>● Spike (&gt;15%)</span>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
              {exceptionTrend.filter((d) => d.rate > 15 && d.total > 10).map((d) => (
                <div key={d.hour} style={{ backgroundColor: '#2a1010', border: '1px solid #EF4444', borderRadius: 8, padding: '6px 12px', fontSize: 12 }}>
                  <span style={{ color: '#EF4444', fontWeight: 700 }}>⚠ {d.hour}:00</span>
                  <span style={{ color: '#ccc', marginLeft: 6 }}>{d.exceptions} exceptions ({d.rate}% rate)</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showPanel === 'bols' && (
        <div style={st.panel}>
          {bols.map((bol) => (
            <div key={bol.id} style={{ display: 'flex', gap: 12, padding: '10px 16px', borderBottom: '1px solid #222', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>{bol.date}</span>
              {bol.truckId && <span style={{ color: '#888', fontSize: 13 }}>{bol.truckId}</span>}
              <span style={{
                padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                backgroundColor: bol.pickedUp ? '#14532d' : '#422006',
                color: bol.pickedUp ? '#22C55E' : '#EAB308',
              }}>
                {bol.pickedUp ? 'PICKED UP' : 'PENDING'}
              </span>
              <span style={{ color: '#666', fontSize: 12 }}>{bol.fileName}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button onClick={() => {
                  const a = document.createElement('a');
                  a.href = bol.fileData;
                  a.download = bol.fileName;
                  a.click();
                }} style={st.exportBtn}>Download</button>
                <button onClick={() => {
                  const w = window.open('', '_blank');
                  if (bol.fileData.startsWith('data:application/pdf')) {
                    w.document.write(`<iframe src="${bol.fileData}" style="width:100%;height:100%;border:none"></iframe>`);
                  } else {
                    w.document.write(`<img src="${bol.fileData}" style="max-width:100%" />`);
                  }
                }} style={st.exportBtn}>Print</button>
                {!bol.pickedUp && (
                  <button onClick={async () => {
                    await updateDoc(doc(db, 'bols', bol.id), { pickedUp: true });
                  }} style={{ ...st.exportBtn, borderColor: '#22C55E', color: '#22C55E' }}>Mark Picked Up</button>
                )}
                {bol.pickedUp && (
                  <button onClick={async () => {
                    await updateDoc(doc(db, 'bols', bol.id), { pickedUp: false });
                  }} style={{ ...st.exportBtn, borderColor: '#888', color: '#888' }}>Undo</button>
                )}
              </div>
            </div>
          ))}
          {bols.length === 0 && <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No BOLs uploaded</p>}
        </div>
      )}
    </div>
  );
}

const st = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', padding: '16px 20px', fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif", maxWidth: 1100, margin: '0 auto' },
  backLink: { color: '#555', textDecoration: 'none', fontSize: 13, marginBottom: 8, display: 'inline-block', fontWeight: 600 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 },
  title: { fontSize: 'clamp(22px, 4vw, 28px)', fontWeight: 800, margin: 0, letterSpacing: '-0.3px' },
  subtitle: { fontSize: 14, color: 'var(--text-secondary, #666)', marginTop: 4 },
  text: { color: 'var(--text-secondary, #ccc)', fontSize: 14 },
  exportBtn: { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border, #2a2a2a)', backgroundColor: 'var(--bg-card, #161616)', color: 'var(--text-secondary, #aaa)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  setupLink: { padding: '8px 14px', borderRadius: 8, backgroundColor: 'var(--bg-card, #161616)', border: '1px solid var(--border, #222)', color: 'var(--text-secondary, #888)', fontSize: 12, fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center' },
  summaryRow: { display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16 },
  summaryItem: { textAlign: 'center', flex: 1, minWidth: 90 },
  summaryValue: { fontSize: 'clamp(26px, 5vw, 36px)', fontWeight: 800, color: 'var(--text, #f0f0f0)', lineHeight: 1, letterSpacing: '-1px' },
  summaryLabel: { fontSize: 'clamp(10px, 1.5vw, 12px)', color: 'var(--text-secondary, #666)', marginTop: 4, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.3px' },
  progressContainer: { height: 6, backgroundColor: 'var(--bg-input, #1a1a1a)', borderRadius: 3, overflow: 'hidden', marginBottom: 20 },
  progressBar: { height: '100%', backgroundColor: '#22C55E', borderRadius: 3, transition: 'width 0.5s ease' },
  podGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginBottom: 16 },
  panelBtn: { padding: '7px 14px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border, #222)', backgroundColor: 'transparent', color: 'var(--text-secondary, #888)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  panel: { backgroundColor: 'var(--bg-card, #161616)', borderRadius: 12, border: '1px solid var(--border, #222)', maxHeight: 400, overflowY: 'auto', marginBottom: 16 },
  exRow: { display: 'flex', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border, #1e1e1e)', flexWrap: 'wrap' },
  exTag: { padding: '2px 8px', borderRadius: 4, backgroundColor: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', border: '1px solid rgba(239,68,68,0.15)' },
  exDetail: { fontSize: 13, color: 'var(--text-secondary, #bbb)', flex: 1, minWidth: 0 },
  exTime: { fontSize: 11, color: 'var(--text-secondary, #555)', whiteSpace: 'nowrap' },
};
