import React, { useState, useEffect, useMemo } from 'react';
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
  collection, doc, getDocs, getDoc, updateDoc, setDoc,
  query, where, onSnapshot, Timestamp,
} from 'firebase/firestore';
import PodCard from '../components/PodCard';
import { exportTodayXLSX, exportAllXLSX, exportPerPO, downloadBlob, exportReconciliation, exportExceptionsXLSX } from '../utils/export';
import { logAudit } from '../utils/audit';

export default function Dashboard() {
  const [job, setJob] = useState(null);
  const [podData, setPodData] = useState({});
  const [presence, setPresence] = useState({});
  const [operatorStats, setOperatorStats] = useState({});
  const [allScans, setAllScans] = useState([]);
  const [allExceptions, setAllExceptions] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [showExceptions, setShowExceptions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(Notification?.permission === 'granted');
  const [podNotes, setPodNotes] = useState({});
  const [messageInputs, setMessageInputs] = useState({});
  const [showPanel, setShowPanel] = useState(''); // '' | 'exceptions' | 'shifts' | 'leaderboard' | 'hourly' | 'manifest'
  const [manifestData, setManifestData] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selectedExceptions, setSelectedExceptions] = useState(new Set());

  // Load active job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const d = snap.docs[0];
        const data = d.data();
        setJob({ id: d.id, ...data });
        // Load manifest for completion tracking
        if (data.meta.mode === 'multi') {
          getDocs(collection(db, 'jobs', d.id, 'manifest')).then((ms) => {
            const cache = {};
            ms.forEach((m) => { cache[m.id] = m.data().poName; });
            setManifestData(cache);
          });
        }
      } else setJob(null);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Presence
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'presence'), (snap) => {
      const data = {};
      snap.forEach((d) => {
        const p = d.data();
        const lastSeen = p.lastSeen?.toDate?.();
        const isRecent = lastSeen && (Date.now() - lastSeen.getTime() < 60000);
        data[d.id] = { ...p, online: p.online && isRecent };
      });
      setPresence(data);
    });
    return unsub;
  }, []);

  // Today's scans
  useEffect(() => {
    if (!job) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(collection(db, 'scans'), where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today)));
    const unsub = onSnapshot(q, (snap) => {
      const scans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllScans(scans);
      setLastUpdated(new Date());
      const pods = {};
      const opStats = {};
      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;
      for (const podId of job.meta.pods || []) {
        const podScans = scans.filter((s) => s.podId === podId);
        const recentScans = podScans.filter((s) => {
          const ts = s.timestamp?.toDate?.(); return ts && ts.getTime() > fifteenMinAgo;
        });
        const scanners = [...new Set(podScans.map((s) => s.scannerId).filter(Boolean))];
        const minutes = Math.min(15, (now - today.getTime()) / 60000);
        const pace = minutes > 0 && recentScans.length > 0
          ? Math.round((recentScans.length / Math.min(15, minutes)) * 60) : 0;
        const targetPerHour = Math.round((job.meta.dailyTarget || 22000) / (job.meta.workingHours || 8) / (job.meta.pods?.length || 5));
        pods[podId] = { id: podId, scanCount: podScans.length,
          exceptionCount: podScans.filter((s) => s.type === 'exception').length, pace, targetPerHour, scanners };
        const byOp = {};
        for (const s of podScans) { if (s.scannerId) byOp[s.scannerId] = (byOp[s.scannerId] || 0) + 1; }
        opStats[podId] = byOp;
      }
      setPodData(pods);
      setOperatorStats(opStats);

      // Push alert: check for idle pods (no scans in 5 min from online pods)
      if (notificationsEnabled) {
        for (const podId of job.meta.pods || []) {
          const pr = presence[podId]; if (!pr?.online) continue;
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
  }, [job, notificationsEnabled, presence]);

  // Exceptions
  useEffect(() => {
    if (!job) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(collection(db, 'exceptions'), where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today)));
    const unsub = onSnapshot(q, (snap) => {
      setAllExceptions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
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
          exportTodayXLSX(allScans, allExceptions, job.meta);
        }
      } catch {}
    }, 60000);
    return () => clearInterval(interval);
  }, [job, allScans, allExceptions]);

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

  // Resolve exception
  const resolveException = async (exId) => {
    try {
      await updateDoc(doc(db, 'exceptions', exId), { resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: 'supervisor' });
      logAudit('resolve_exception', { exceptionId: exId });
    } catch {}
  };

  // Bulk resolve exceptions
  const bulkResolve = async () => {
    if (selectedExceptions.size === 0) return;
    const ids = [...selectedExceptions];
    for (const exId of ids) {
      try {
        await updateDoc(doc(db, 'exceptions', exId), { resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: 'supervisor' });
      } catch {}
    }
    logAudit('bulk_resolve_exceptions', { count: ids.length });
    setSelectedExceptions(new Set());
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

  // Totals
  const totalScans = Object.values(podData).reduce((sum, p) => sum + p.scanCount, 0);
  const totalAutoExceptions = Object.values(podData).reduce((sum, p) => sum + p.exceptionCount, 0);
  const totalExceptions = totalAutoExceptions + allExceptions.length;
  const totalPace = Object.values(podData).reduce((sum, p) => sum + p.pace, 0);
  const dailyTarget = job?.meta?.dailyTarget || 22000;
  const remaining = Math.max(0, dailyTarget - totalScans);
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
        const files = exportPerPO(scans, job.meta);
        for (const f of files) downloadBlob(f.data, f.name);
      }
    } catch (err) { alert('Export failed: ' + err.message); }
    setExporting(false);
  };
  const handleExportReconciliation = () => {
    if (!job || !Object.keys(manifestData).length) return;
    exportReconciliation(allScans, manifestData, job.meta);
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
          {manifestCompletion && (
            <button onClick={handleExportReconciliation} style={st.exportBtn}>📋 Reconciliation</button>
          )}
          <Link to="/kiosk" style={{ ...st.exportBtn, textDecoration: 'none' }}>📺 Kiosk</Link>
          <Link to="/setup" style={st.setupLink}>Setup</Link>
        </div>
      </div>

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
      </div>

      {/* Progress bar */}
      <div style={st.progressContainer}>
        <div style={{ ...st.progressBar, width: `${Math.min(100, (totalScans / dailyTarget) * 100)}%` }} />
      </div>

      {/* Auto-refresh indicator */}
      {lastUpdated && (
        <AutoRefreshIndicator lastUpdated={lastUpdated} />
      )}

      {/* Notification toggle */}
      {!notificationsEnabled && typeof Notification !== 'undefined' && (
        <button onClick={enableNotifications} style={{ ...st.exportBtn, marginBottom: 16 }}>
          🔔 Enable Push Alerts
        </button>
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
        {(job.meta.pods || []).map((podId) => (
          <div key={podId}>
            <PodCard
              pod={podData[podId] || { id: podId, scanCount: 0, exceptionCount: 0, pace: 0, targetPerHour: 0, scanners: [] }}
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
        ))}
      </div>

      {/* Panel toggles */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24, marginBottom: 12 }}>
        {[
          ['exceptions', `Exceptions (${totalExceptions})`],
          ['leaderboard', '🏆 Leaderboard'],
          ['hourly', '📊 Hourly'],
          ['shifts', '⏱ Shifts'],
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
                <button onClick={bulkResolve}
                  style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #22C55E', backgroundColor: 'transparent', color: '#22C55E', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  ✓ Resolve Selected ({selectedExceptions.size})
                </button>
              )}
            </div>
            <button onClick={handleExportExceptions}
              style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #3B82F6', backgroundColor: 'transparent', color: '#3B82F6', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              📥 Export for Customer
            </button>
          </div>
          {allScans.filter((s) => s.type === 'exception').map((s) => (
            <div key={s.id} style={st.exRow}>
              <span style={st.exTag}>NOT IN MANIFEST</span>
              <span style={st.exDetail}>ISBN: {s.isbn} · Pod {s.podId} · {s.scannerId}</span>
              <span style={st.exTime}>{s.timestamp?.toDate?.()?.toLocaleTimeString() || '—'}</span>
            </div>
          ))}
          {allExceptions.map((ex) => (
            <div key={ex.id} style={{ ...st.exRow, opacity: ex.resolved ? 0.5 : 1 }}>
              {!ex.resolved && (
                <input type="checkbox" checked={selectedExceptions.has(ex.id)}
                  onChange={() => toggleException(ex.id)}
                  style={{ accentColor: '#3B82F6', cursor: 'pointer', width: 16, height: 16 }} />
              )}
              <span style={st.exTag}>{ex.reason}</span>
              <span style={st.exDetail}>
                {ex.isbn ? `ISBN: ${ex.isbn}` : ''}{ex.title ? ` "${ex.title}"` : ''} · Pod {ex.podId} · {ex.scannerId}
              </span>
              <span style={st.exTime}>{ex.timestamp?.toDate?.()?.toLocaleTimeString() || '—'}</span>
              {!ex.resolved ? (
                <button onClick={() => resolveException(ex.id)}
                  style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #22C55E', backgroundColor: 'transparent', color: '#22C55E', fontSize: 11, cursor: 'pointer', marginLeft: 8, fontWeight: 600 }}>
                  ✓ Resolve
                </button>
              ) : (
                <span style={{ fontSize: 11, color: '#22C55E', marginLeft: 8 }}>✓ Resolved</span>
              )}
            </div>
          ))}
          {totalExceptions === 0 && <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No exceptions today</p>}
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
    </div>
  );
}

const st = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #111)', color: 'var(--text, #fff)', padding: '16px 12px', fontFamily: 'system-ui,sans-serif', maxWidth: 1200, margin: '0 auto' },
  backLink: { color: '#666', textDecoration: 'none', fontSize: 14, marginBottom: 8, display: 'inline-block' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 24 },
  title: { fontSize: 'clamp(24px, 4vw, 32px)', fontWeight: 800, margin: 0 },
  subtitle: { fontSize: 16, color: 'var(--text-secondary, #888)', marginTop: 4 },
  text: { color: 'var(--text-secondary, #ddd)', fontSize: 16 },
  exportBtn: { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text, #fff)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  setupLink: { padding: '8px 16px', borderRadius: 8, backgroundColor: 'var(--bg-input, #333)', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center' },
  summaryRow: { display: 'flex', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16 },
  summaryItem: { textAlign: 'center', flex: 1, minWidth: 100 },
  summaryValue: { fontSize: 'clamp(28px, 5vw, 40px)', fontWeight: 800, color: 'var(--text, #fff)', lineHeight: 1 },
  summaryLabel: { fontSize: 'clamp(11px, 1.5vw, 13px)', color: 'var(--text-secondary, #888)', marginTop: 4 },
  progressContainer: { height: 8, backgroundColor: 'var(--bg-input, #333)', borderRadius: 4, overflow: 'hidden', marginBottom: 24 },
  progressBar: { height: '100%', backgroundColor: '#22C55E', borderRadius: 4, transition: 'width 0.5s ease' },
  podGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 16 },
  panelBtn: { padding: '8px 16px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border, #444)', backgroundColor: 'transparent', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  panel: { backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 12, border: '1px solid var(--border, #333)', maxHeight: 420, overflowY: 'auto', marginBottom: 16 },
  exRow: { display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border, #222)', flexWrap: 'wrap' },
  exTag: { padding: '2px 8px', borderRadius: 4, backgroundColor: '#7f1d1d', color: '#fca5a5', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  exDetail: { fontSize: 14, color: 'var(--text-secondary, #ccc)', flex: 1, minWidth: 0 },
  exTime: { fontSize: 12, color: 'var(--text-secondary, #666)', whiteSpace: 'nowrap' },
};
