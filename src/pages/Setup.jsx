import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc,
  query, where, updateDoc, serverTimestamp, writeBatch, Timestamp,
} from 'firebase/firestore';
import { parseManifestFile } from '../utils/manifest';
import { logAudit } from '../utils/audit';
import { hashPassword } from '../utils/crypto';

const DEFAULT_COLORS = [
  { name: 'Red', hex: '#EF4444' }, { name: 'Blue', hex: '#3B82F6' },
  { name: 'Yellow', hex: '#EAB308' }, { name: 'Green', hex: '#22C55E' },
  { name: 'Orange', hex: '#F97316' }, { name: 'Purple', hex: '#A855F7' },
  { name: 'Pink', hex: '#EC4899' }, { name: 'Teal', hex: '#14B8A6' },
  { name: 'Brown', hex: '#92400E' }, { name: 'Gold', hex: '#CA8A04' },
];
const DEFAULT_PODS = ['A', 'B', 'C', 'D', 'E'];

export default function Setup() {
  const [jobName, setJobName] = useState('');
  const [mode, setMode] = useState('single');
  const [dailyTarget, setDailyTarget] = useState(22000);
  const [workingHours, setWorkingHours] = useState(8);
  const [pods, setPods] = useState(DEFAULT_PODS);
  const [podInput, setPodInput] = useState(DEFAULT_PODS.join(', '));
  const [manifest, setManifest] = useState(null);
  const [manifestPreview, setManifestPreview] = useState([]);
  const [poNames, setPoNames] = useState([]);
  const [poColors, setPoColors] = useState({});
  const [fileError, setFileError] = useState('');
  const [parseProgress, setParseProgress] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [pastJobs, setPastJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [location, setLocation] = useState('');

  // Edit
  const [editMode, setEditMode] = useState(false);
  const [editTarget, setEditTarget] = useState('');
  const [editHours, setEditHours] = useState('');
  const [editPods, setEditPods] = useState('');

  // PIN
  const [pinValue, setPinValue] = useState('');
  const [pinSaved, setPinSaved] = useState(false);
  const [showSection, setShowSection] = useState(''); // '' | 'pin' | 'branding' | 'retention' | 'audit'

  // Branding
  const [brandName, setBrandName] = useState('');
  const [brandSubtitle, setBrandSubtitle] = useState('');
  const [brandLogo, setBrandLogo] = useState('');
  const [brandSaved, setBrandSaved] = useState(false);

  // Data retention
  const [retentionDays, setRetentionDays] = useState(90);
  const [cleanupStatus, setCleanupStatus] = useState('');

  // Audit log
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Alert thresholds
  const [idleTimeout, setIdleTimeout] = useState(5);
  const [paceWarning, setPaceWarning] = useState(80);
  const [alertsSaved, setAlertsSaved] = useState(false);

  // Export scheduling
  const [autoExportTime, setAutoExportTime] = useState('17:00');
  const [autoExportEnabled, setAutoExportEnabled] = useState(false);
  const [reportEmail, setReportEmail] = useState('');
  const [scheduleSaved, setScheduleSaved] = useState(false);

  // Customer portal credentials
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPw, setCustomerPw] = useState('');
  const [customerPwSaved, setCustomerPwSaved] = useState(false);

  // Customer PO uploads
  const [customerPOUploads, setCustomerPOUploads] = useState([]);
  const [selectedUploadId, setSelectedUploadId] = useState(null);

  // Job queue
  const [queuedJobs, setQueuedJobs] = useState([]);
  const [showQueueForm, setShowQueueForm] = useState(false);
  const [qJobName, setQJobName] = useState('');
  const [qMode, setQMode] = useState('single');
  const [qDailyTarget, setQDailyTarget] = useState(22000);
  const [qWorkingHours, setQWorkingHours] = useState(8);
  const [qPods, setQPods] = useState(DEFAULT_PODS);
  const [qPodInput, setQPodInput] = useState(DEFAULT_PODS.join(', '));
  const [qLocation, setQLocation] = useState('');
  const [qManifest, setQManifest] = useState(null);
  const [qPoNames, setQPoNames] = useState([]);
  const [qPoColors, setQPoColors] = useState({});
  const [qFileError, setQFileError] = useState('');
  const [qParsing, setQParsing] = useState(false);
  const [qParseProgress, setQParseProgress] = useState(0);
  const [qManifestPreview, setQManifestPreview] = useState([]);
  const [qSaving, setQSaving] = useState(false);
  const [qSelectedUploadId, setQSelectedUploadId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
        const snap = await getDocs(q);
        if (!snap.empty) {
          const d = snap.docs[0];
          if (d) {
            const jobData = { id: d.id, ...d.data() };
            setActiveJob(jobData);
            setEditTarget(jobData.meta.dailyTarget);
            setEditHours(jobData.meta.workingHours);
            setEditPods(jobData.meta.pods?.join(', ') || '');
          }
        }
        // Load branding
        const brandDoc = await getDoc(doc(db, 'config', 'branding'));
        if (brandDoc.exists()) {
          setBrandName(brandDoc.data().name || '');
          setBrandSubtitle(brandDoc.data().subtitle || '');
          setBrandLogo(brandDoc.data().logo || '');
        }
        // Load past (closed) and queued jobs
        const otherSnap = await getDocs(query(collection(db, 'jobs'), where('meta.active', '==', false)));
        const others = otherSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setQueuedJobs(others.filter((j) => j.meta.queued)
          .sort((a, b) => (a.meta.queueOrder || 0) - (b.meta.queueOrder || 0)));
        setPastJobs(others.filter((j) => !j.meta.queued)
          .sort((a, b) => (b.meta.closedAt?.toDate?.()?.getTime() || 0) - (a.meta.closedAt?.toDate?.()?.getTime() || 0)));
        // Load alert thresholds
        const alertDoc = await getDoc(doc(db, 'config', 'alerts'));
        if (alertDoc.exists()) {
          setIdleTimeout(alertDoc.data().idleTimeout || 5);
          setPaceWarning(alertDoc.data().paceWarning || 80);
        }
        // Load export schedule
        const schedDoc = await getDoc(doc(db, 'config', 'schedule'));
        if (schedDoc.exists()) {
          setAutoExportEnabled(schedDoc.data().enabled || false);
          setAutoExportTime(schedDoc.data().time || '17:00');
          setReportEmail(schedDoc.data().reportEmail || '');
        }
      } catch (err) { console.error('Failed to load:', err); }
      setLoading(false);
    })();
    // Load customer PO uploads
    getDocs(collection(db, 'po-uploads')).then((snap) => {
      setCustomerPOUploads(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.uploadedAt?.toDate?.()?.getTime() || 0) - (a.uploadedAt?.toDate?.()?.getTime() || 0)));
    }).catch(() => {});
  }, []);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setFileError(''); setSelectedUploadId(null); setParsing(true); setParseProgress(0);
    try {
      const result = await parseManifestFile(file, (pct) => setParseProgress(pct));
      setManifest(result.manifest); setPoNames(result.poNames);
      setManifestPreview(Object.entries(result.manifest).slice(0, 50));
      const colors = {};
      result.poNames.forEach((po, i) => { colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex; });
      setPoColors(colors);
      setParseProgress(100);
    } catch (err) { setFileError(err.message); setManifest(null); setPoNames([]); setManifestPreview([]); }
    setParsing(false);
  };

  // Use a customer-uploaded PO
  const useCustomerUpload = async (upload) => {
    setFileError('');
    try {
      const snap = await getDocs(collection(db, 'po-uploads', upload.id, 'manifest'));
      const man = {};
      snap.forEach((d) => { man[d.id] = d.data().poName; });
      setManifest(man);
      setPoNames(upload.poNames || []);
      setManifestPreview(Object.entries(man).slice(0, 50));
      // Use customer-chosen colors if available, otherwise auto-assign
      const colors = {};
      const savedColors = upload.poColors || {};
      (upload.poNames || []).forEach((po, i) => {
        colors[po] = savedColors[po] || DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex;
      });
      setPoColors(colors);
      setSelectedUploadId(upload.id);
    } catch (err) {
      setFileError('Failed to load PO upload: ' + err.message);
    }
  };

  const handlePodInputChange = (val) => {
    setPodInput(val);
    setPods([...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))]);
  };

  const handleActivateJob = async () => {
    if (!jobName.trim()) return alert('Enter a job name');
    if (mode === 'multi' && !manifest) return alert('Upload a manifest for Multi-PO mode');
    if (pods.length === 0) return alert('Configure at least one pod');
    const target = Number(dailyTarget); const hours = Number(workingHours);
    if (!target || target <= 0) return alert('Enter a valid daily target');
    if (!hours || hours <= 0 || hours > 24) return alert('Enter valid working hours (1-24)');

    setSaving(true);
    try {
      const existing = await getDocs(query(collection(db, 'jobs'), where('meta.active', '==', true)));
      if (!existing.empty) {
        alert('Another job is already active. Close it first.');
        const d = existing.docs[0]; setActiveJob({ id: d.id, ...d.data() }); setSaving(false); return;
      }
      const jobId = `job_${Date.now()}`;
      await setDoc(doc(db, 'jobs', jobId), {
        meta: { name: jobName.trim(), mode, dailyTarget: target, workingHours: hours, pods, active: true,
          location: location.trim() || '', createdAt: serverTimestamp() },
        poColors: mode === 'multi' ? poColors : {},
      });
      if (mode === 'multi' && manifest) {
        const BATCH_SIZE = 400; const entries = Object.entries(manifest);
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          entries.slice(i, i + BATCH_SIZE).forEach(([isbn, poName]) => {
            batch.set(doc(db, 'jobs', jobId, 'manifest', isbn), { poName });
          });
          await batch.commit();
        }
        // Mark customer upload as added if used
        if (selectedUploadId) {
          await updateDoc(doc(db, 'po-uploads', selectedUploadId), { status: 'added', jobId, addedAt: serverTimestamp() });
          setSelectedUploadId(null);
        }
      }
      logAudit('job_created', { jobId, name: jobName.trim(), mode });
      setActiveJob({ id: jobId, meta: { name: jobName.trim(), mode, dailyTarget: target, workingHours: hours, pods, active: true, location: location.trim() || '' }, poColors: mode === 'multi' ? poColors : {} });
      setEditTarget(target); setEditHours(hours); setEditPods(pods.join(', '));
    } catch (err) { alert('Failed to create job: ' + err.message); }
    setSaving(false);
  };

  const handleCloseJob = async () => {
    if (!activeJob) return;
    const nextQueued = queuedJobs[0];
    const msg = nextQueued
      ? `Close this job? The next queued job "${nextQueued.meta.name}" will be activated.`
      : 'Close this job? Pods will no longer be able to scan.';
    if (!window.confirm(msg)) return;
    try {
      await updateDoc(doc(db, 'jobs', activeJob.id), { 'meta.active': false, 'meta.closedAt': serverTimestamp() });
      for (const podId of activeJob.meta.pods || []) {
        try { await setDoc(doc(db, 'presence', podId), { podId, scanners: [], operator: '', status: 'offline', online: false, lastSeen: serverTimestamp() }); } catch {}
      }
      logAudit('job_closed', { jobId: activeJob.id });

      // Auto-activate next queued job
      if (nextQueued) {
        await updateDoc(doc(db, 'jobs', nextQueued.id), { 'meta.active': true, 'meta.queued': false, 'meta.activatedAt': serverTimestamp() });
        logAudit('job_activated_from_queue', { jobId: nextQueued.id, name: nextQueued.meta.name });
        setActiveJob({ ...nextQueued, meta: { ...nextQueued.meta, active: true, queued: false } });
        setEditTarget(nextQueued.meta.dailyTarget);
        setEditHours(nextQueued.meta.workingHours);
        setEditPods(nextQueued.meta.pods?.join(', ') || '');
        setQueuedJobs((prev) => prev.slice(1));
      } else {
        setActiveJob(null);
      }
      setEditMode(false);
    } catch (err) { alert('Failed to close job: ' + err.message); }
  };

  const handleQueueJob = async () => {
    if (!qJobName.trim()) return alert('Enter a job name');
    if (qMode === 'multi' && !qManifest) return alert('Upload a manifest for Multi-PO mode');
    if (qPods.length === 0) return alert('Configure at least one pod');
    const target = Number(qDailyTarget); const hours = Number(qWorkingHours);
    if (!target || target <= 0) return alert('Enter a valid daily target');
    if (!hours || hours <= 0 || hours > 24) return alert('Enter valid working hours (1-24)');

    setQSaving(true);
    try {
      const jobId = `job_${Date.now()}`;
      await setDoc(doc(db, 'jobs', jobId), {
        meta: { name: qJobName.trim(), mode: qMode, dailyTarget: target, workingHours: hours, pods: qPods, active: false,
          queued: true, queueOrder: Date.now(), location: qLocation.trim() || '', createdAt: serverTimestamp() },
        poColors: qMode === 'multi' ? qPoColors : {},
      });
      if (qMode === 'multi' && qManifest) {
        const BATCH_SIZE = 400; const entries = Object.entries(qManifest);
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          entries.slice(i, i + BATCH_SIZE).forEach(([isbn, poName]) => {
            batch.set(doc(db, 'jobs', jobId, 'manifest', isbn), { poName });
          });
          await batch.commit();
        }
        if (qSelectedUploadId) {
          await updateDoc(doc(db, 'po-uploads', qSelectedUploadId), { status: 'queued', jobId, addedAt: serverTimestamp() });
          setQSelectedUploadId(null);
        }
      }
      logAudit('job_queued', { jobId, name: qJobName.trim(), mode: qMode });
      const newJob = { id: jobId, meta: { name: qJobName.trim(), mode: qMode, dailyTarget: target, workingHours: hours, pods: qPods, active: false, queued: true, queueOrder: Date.now(), location: qLocation.trim() || '' }, poColors: qMode === 'multi' ? qPoColors : {} };
      setQueuedJobs((prev) => [...prev, newJob]);
      // Reset form
      setQJobName(''); setQMode('single'); setQDailyTarget(22000); setQWorkingHours(8);
      setQPods(DEFAULT_PODS); setQPodInput(DEFAULT_PODS.join(', ')); setQLocation('');
      setQManifest(null); setQPoNames([]); setQPoColors({}); setQManifestPreview([]);
      setQFileError(''); setShowQueueForm(false);
    } catch (err) { alert('Failed to queue job: ' + err.message); }
    setQSaving(false);
  };

  const handleRemoveFromQueue = async (jobId) => {
    if (!window.confirm('Remove this job from the queue? The job data will be deleted.')) return;
    try {
      const mfSnap = await getDocs(collection(db, 'jobs', jobId, 'manifest'));
      if (mfSnap.size > 0) {
        let batch = writeBatch(db); let c = 0;
        for (const d of mfSnap.docs) { batch.delete(d.ref); c++; if (c % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
        await batch.commit();
      }
      await deleteDoc(doc(db, 'jobs', jobId));
      logAudit('job_removed_from_queue', { jobId });
      setQueuedJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch (err) { alert('Failed to remove: ' + err.message); }
  };

  const handleQueueFileUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setQFileError(''); setQSelectedUploadId(null); setQParsing(true); setQParseProgress(0);
    try {
      const result = await parseManifestFile(file, (pct) => setQParseProgress(pct));
      setQManifest(result.manifest); setQPoNames(result.poNames);
      setQManifestPreview(Object.entries(result.manifest).slice(0, 50));
      const colors = {};
      result.poNames.forEach((po, i) => { colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex; });
      setQPoColors(colors); setQParseProgress(100);
    } catch (err) { setQFileError(err.message); setQManifest(null); setQPoNames([]); setQPoColors({}); }
    setQParsing(false);
  };

  const useCustomerUploadForQueue = async (upload) => {
    setQFileError('');
    try {
      const snap = await getDocs(collection(db, 'po-uploads', upload.id, 'manifest'));
      const man = {};
      snap.forEach((d) => { man[d.id] = d.data().poName; });
      setQManifest(man); setQPoNames(upload.poNames || []);
      setQManifestPreview(Object.entries(man).slice(0, 50));
      const colors = {};
      const savedColors = upload.poColors || {};
      (upload.poNames || []).forEach((po, i) => {
        colors[po] = savedColors[po] || DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex;
      });
      setQPoColors(colors); setQSelectedUploadId(upload.id);
    } catch (err) { setQFileError('Failed to load PO upload: ' + err.message); }
  };

  const handleDeleteJob = async () => {
    if (!activeJob) return;
    const name = activeJob.meta.name || activeJob.id;
    if (!window.confirm(`DELETE job "${name}" and ALL its data (scans, exceptions, shifts, BOLs, manifest)? This cannot be undone.`)) return;
    if (!window.confirm('Are you absolutely sure? This is permanent.')) return;
    try {
      // Close job first if active
      if (activeJob.meta.active) {
        await updateDoc(doc(db, 'jobs', activeJob.id), { 'meta.active': false, 'meta.closedAt': serverTimestamp() });
        for (const podId of activeJob.meta.pods || []) {
          try { await setDoc(doc(db, 'presence', podId), { podId, scanners: [], operator: '', status: 'offline', online: false, lastSeen: serverTimestamp() }); } catch {}
        }
      }
      // Delete scans
      const scanSnap = await getDocs(query(collection(db, 'scans'), where('jobId', '==', activeJob.id)));
      const BATCH = 400;
      let batch = writeBatch(db); let count = 0;
      for (const d of scanSnap.docs) { batch.delete(d.ref); count++; if (count % BATCH === 0) { await batch.commit(); batch = writeBatch(db); } }
      // Delete exceptions
      const excSnap = await getDocs(query(collection(db, 'exceptions'), where('jobId', '==', activeJob.id)));
      for (const d of excSnap.docs) { batch.delete(d.ref); count++; if (count % BATCH === 0) { await batch.commit(); batch = writeBatch(db); } }
      // Delete shifts
      const shiftSnap = await getDocs(query(collection(db, 'shifts'), where('jobId', '==', activeJob.id)));
      for (const d of shiftSnap.docs) { batch.delete(d.ref); count++; if (count % BATCH === 0) { await batch.commit(); batch = writeBatch(db); } }
      // Delete BOLs
      const bolSnap = await getDocs(query(collection(db, 'bols'), where('jobId', '==', activeJob.id)));
      for (const d of bolSnap.docs) { batch.delete(d.ref); count++; if (count % BATCH === 0) { await batch.commit(); batch = writeBatch(db); } }
      // Delete manifest subcollection
      const manifestSnap = await getDocs(collection(db, 'jobs', activeJob.id, 'manifest'));
      for (const d of manifestSnap.docs) { batch.delete(d.ref); count++; if (count % BATCH === 0) { await batch.commit(); batch = writeBatch(db); } }
      // Final batch + delete job doc
      batch.delete(doc(db, 'jobs', activeJob.id));
      await batch.commit();
      logAudit('job_deleted', { jobId: activeJob.id, jobName: name, deletedRecords: count });
      setActiveJob(null); setEditMode(false);
      alert(`Job "${name}" and ${count} related records deleted.`);
    } catch (err) { alert('Delete failed: ' + err.message); }
  };

  const handleEditSave = async () => {
    const target = Number(editTarget); const hours = Number(editHours);
    if (!target || target <= 0) return alert('Enter a valid daily target');
    if (!hours || hours <= 0 || hours > 24) return alert('Enter valid working hours');
    const newPods = [...new Set(editPods.split(',').map((s) => s.trim()).filter(Boolean))];
    if (newPods.length === 0) return alert('Need at least one pod');
    try {
      await updateDoc(doc(db, 'jobs', activeJob.id), { 'meta.dailyTarget': target, 'meta.workingHours': hours, 'meta.pods': newPods });
      logAudit('job_edited', { jobId: activeJob.id });
      setActiveJob({ ...activeJob, meta: { ...activeJob.meta, dailyTarget: target, workingHours: hours, pods: newPods } });
      setEditMode(false);
    } catch (err) { alert('Failed to save: ' + err.message); }
  };

  const handlePinChange = async () => {
    if (!pinValue || pinValue.length < 4) return alert('PIN must be at least 4 digits');
    try {
      const pinHash = await hashPassword(pinValue);
      await setDoc(doc(db, 'config', 'supervisor'), { pinHash });
      logAudit('pin_changed', {}); setPinSaved(true); setPinValue('');
      setTimeout(() => setPinSaved(false), 3000);
    } catch (err) { alert('Failed to save PIN: ' + err.message); }
  };

  const handleBrandingSave = async () => {
    try {
      await setDoc(doc(db, 'config', 'branding'), { name: brandName.trim(), subtitle: brandSubtitle.trim(), logo: brandLogo });
      logAudit('branding_updated', { name: brandName.trim() }); setBrandSaved(true);
      setTimeout(() => setBrandSaved(false), 3000);
    } catch (err) { alert('Failed to save branding: ' + err.message); }
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) { alert('Logo must be under 500 KB'); e.target.value = ''; return; }
    if (!file.type.startsWith('image/')) { alert('Please select an image file'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => setBrandLogo(reader.result);
    reader.readAsDataURL(file);
  };

  const handleDataCleanup = async () => {
    if (!window.confirm(`Delete all scans and exceptions older than ${retentionDays} days? This cannot be undone.`)) return;
    setCleanupStatus('Cleaning up...');
    try {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - retentionDays); cutoff.setHours(0, 0, 0, 0);
      const cutoffTs = Timestamp.fromDate(cutoff);
      let deleted = 0;
      // Clean scans
      const scanSnap = await getDocs(query(collection(db, 'scans'), where('timestamp', '<', cutoffTs)));
      for (const d of scanSnap.docs) { await deleteDoc(d.ref); deleted++; }
      // Clean exceptions
      const excSnap = await getDocs(query(collection(db, 'exceptions'), where('timestamp', '<', cutoffTs)));
      for (const d of excSnap.docs) { await deleteDoc(d.ref); deleted++; }
      // Clean audit
      const auditSnap = await getDocs(query(collection(db, 'audit'), where('timestamp', '<', cutoffTs)));
      for (const d of auditSnap.docs) { await deleteDoc(d.ref); deleted++; }
      logAudit('data_cleanup', { retentionDays, deletedCount: deleted });
      setCleanupStatus(`Deleted ${deleted} old records.`);
    } catch (err) { setCleanupStatus('Cleanup failed: ' + err.message); }
  };

  const loadAuditLog = async () => {
    setAuditLoading(true);
    try {
      const snap = await getDocs(collection(db, 'audit'));
      const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.timestamp?.toDate?.()?.getTime() || 0) - (a.timestamp?.toDate?.()?.getTime() || 0));
      setAuditLogs(logs.slice(0, 50));
    } catch {}
    setAuditLoading(false);
  };

  const handleAlertsSave = async () => {
    try {
      await setDoc(doc(db, 'config', 'alerts'), { idleTimeout: Number(idleTimeout), paceWarning: Number(paceWarning) });
      logAudit('alerts_updated', { idleTimeout, paceWarning });
      setAlertsSaved(true);
      setTimeout(() => setAlertsSaved(false), 3000);
    } catch (err) { alert('Failed to save: ' + err.message); }
  };

  const handleScheduleSave = async () => {
    try {
      await setDoc(doc(db, 'config', 'schedule'), { enabled: autoExportEnabled, time: autoExportTime, reportEmail: reportEmail.trim() });
      logAudit('schedule_updated', { enabled: autoExportEnabled, time: autoExportTime });
      setScheduleSaved(true);
      setTimeout(() => setScheduleSaved(false), 3000);
    } catch (err) { alert('Failed to save: ' + err.message); }
  };

  const getPodUrl = (podId) => {
    const base = window.location.origin;
    return `${base}/pod?id=${encodeURIComponent(podId)}`;
  };

  const getQrUrl = (podId) => {
    const podUrl = getPodUrl(podId);
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(podUrl)}`;
  };

  const printQrCodes = () => {
    const podIds = activeJob?.meta?.pods || [];
    const html = podIds.map((id) => `
      <div style="text-align:center;page-break-inside:avoid;margin:24px 0">
        <h2 style="font-size:28px;margin-bottom:8px">Pod ${id}</h2>
        <img src="${getQrUrl(id)}" width="200" height="200" />
        <p style="font-size:12px;color:#888">${getPodUrl(id)}</p>
      </div>
    `).join('');
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Pod QR Codes</title></head><body style="font-family:sans-serif">${html}</body></html>`);
    w.document.close();
    w.print();
  };

  if (loading) return <div style={s.container}><p style={s.text}>Loading...</p></div>;

  // ─── Active Job View ───
  if (activeJob) {
    return (
      <div style={s.container}>
        <Link to="/" style={s.backLink}>← Back to Home</Link>
        <h1 style={s.title}>Active Job</h1>
        <div style={s.card}>
          {!editMode ? (
            <>
              <p style={s.text}><strong>Job Name:</strong> {activeJob.meta.name}</p>
              <p style={s.text}><strong>Mode:</strong> {activeJob.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'}</p>
              <p style={s.text}><strong>Daily Target:</strong> {activeJob.meta.dailyTarget?.toLocaleString()}</p>
              <p style={s.text}><strong>Working Hours:</strong> {activeJob.meta.workingHours}</p>
              <p style={s.text}><strong>Pods:</strong> {activeJob.meta.pods?.join(', ')}</p>
              {activeJob.meta.location && <p style={s.text}><strong>Location:</strong> {activeJob.meta.location}</p>}
              {activeJob.meta.mode === 'multi' && activeJob.poColors && (
                <div style={{ marginTop: 12 }}>
                  <strong style={s.text}>PO Colors:</strong>
                  {Object.entries(activeJob.poColors).map(([po, color]) => (
                    <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <div style={{ width: 24, height: 24, borderRadius: 4, backgroundColor: color, border: '1px solid #555' }} />
                      <span style={s.text}>{po}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 24, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Link to="/dashboard" style={s.linkBtn}>Go to Dashboard</Link>
                <button onClick={() => setEditMode(true)} style={s.editBtn}>✏️ Edit Job</button>
                <button onClick={handleCloseJob} style={s.dangerBtn}>Close Job</button>
                <button onClick={handleDeleteJob} style={{ ...s.dangerBtn, backgroundColor: '#450a0a', borderColor: '#7f1d1d' }}>🗑 Delete Job</button>
              </div>
            </>
          ) : (
            <>
              <h2 style={{ color: '#fff', fontSize: 20, marginBottom: 16, marginTop: 0 }}>Edit Job Settings</h2>
              <label style={s.label}>Daily Target</label>
              <input type="number" value={editTarget} onChange={(e) => setEditTarget(e.target.value)} style={s.input} />
              <label style={s.label}>Working Hours Per Day</label>
              <input type="number" value={editHours} onChange={(e) => setEditHours(e.target.value)} min={1} max={24} style={s.input} />
              <label style={s.label}>Pod IDs (comma-separated)</label>
              <input type="text" value={editPods} onChange={(e) => setEditPods(e.target.value)} style={s.input} />
              <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
                <button onClick={handleEditSave} style={s.primaryBtn}>Save Changes</button>
                <button onClick={() => setEditMode(false)} style={s.secondaryBtn}>Cancel</button>
              </div>
            </>
          )}
        </div>

        {/* Admin sections */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24, marginBottom: 12 }}>
          {['pin', 'branding', 'alerts', 'qr', 'schedule', 'retention', 'audit', 'customer'].map((key) => (
            <button key={key} onClick={() => { setShowSection(showSection === key ? '' : key); if (key === 'audit') loadAuditLog(); }}
              style={{ ...s.secondaryBtn, ...(showSection === key ? { borderColor: '#3B82F6', color: '#3B82F6' } : {}) }}>
              {key === 'pin' ? '🔒 PIN' : key === 'branding' ? '🎨 Branding' : key === 'alerts' ? '⚙️ Alerts' : key === 'qr' ? '📱 QR Codes' : key === 'schedule' ? '⏰ Auto-Export' : key === 'retention' ? '🗑 Retention' : key === 'audit' ? '📋 Audit' : '🔑 Customer'}
            </button>
          ))}
          <Link to="/users" style={{ ...s.secondaryBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>👥 Users</Link>
        </div>

        {showSection === 'pin' && (
          <div style={s.card}>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>Default PIN is 1234. Change it here.</p>
            <input type="password" inputMode="numeric" value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePinChange(); }}
              placeholder="New PIN (4+ digits)..." style={s.input} maxLength={8} />
            <button onClick={handlePinChange} disabled={!pinValue}
              style={{ ...s.primaryBtn, marginTop: 8 }}>{pinSaved ? '✓ PIN Saved!' : 'Update PIN'}</button>
          </div>
        )}

        {showSection === 'branding' && (
          <div style={s.card}>
            <label style={s.label}>Company / App Name</label>
            <input type="text" value={brandName} onChange={(e) => setBrandName(e.target.value)}
              placeholder="e.g. BookFlow" style={s.input} />
            <label style={s.label}>Subtitle</label>
            <input type="text" value={brandSubtitle} onChange={(e) => setBrandSubtitle(e.target.value)}
              placeholder="e.g. by PrepFort" style={s.input} />
            <label style={s.label}>Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
              {brandLogo ? (
                <img src={brandLogo} alt="Logo" style={{ width: 64, height: 64, borderRadius: 12, objectFit: 'contain', border: '1px solid #333', backgroundColor: '#0a0a0a' }} />
              ) : (
                <div style={{ width: 64, height: 64, borderRadius: 12, border: '1px dashed #444', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12 }}>No logo</div>
              )}
              <div style={{ flex: 1 }}>
                <input type="file" accept="image/*" onChange={handleLogoUpload} style={{ ...s.input, padding: 8 }} />
                <p style={{ color: '#666', fontSize: 11, marginTop: 4 }}>PNG, JPG, or SVG — max 500 KB</p>
                {brandLogo && (
                  <button onClick={() => setBrandLogo('')}
                    style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid #7f1d1d', backgroundColor: 'transparent', color: '#EF4444', fontSize: 11, cursor: 'pointer', marginTop: 4 }}>
                    Remove Logo
                  </button>
                )}
              </div>
            </div>
            <button onClick={handleBrandingSave}
              style={{ ...s.primaryBtn, marginTop: 12 }}>{brandSaved ? '✓ Saved!' : 'Save Branding'}</button>
          </div>
        )}

        {showSection === 'alerts' && (
          <div style={s.card}>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>Configure alert thresholds for pod monitoring.</p>
            <label style={s.label}>Idle Timeout (minutes)</label>
            <input type="number" value={idleTimeout} onChange={(e) => setIdleTimeout(e.target.value)}
              min={1} max={30} style={s.input} />
            <p style={{ color: '#666', fontSize: 12, marginTop: 4 }}>Alert when a pod has no scans for this many minutes</p>
            <label style={s.label}>Pace Warning Threshold (%)</label>
            <input type="number" value={paceWarning} onChange={(e) => setPaceWarning(e.target.value)}
              min={10} max={100} style={s.input} />
            <p style={{ color: '#666', fontSize: 12, marginTop: 4 }}>Warn when pace drops below this % of target</p>
            <button onClick={handleAlertsSave}
              style={{ ...s.primaryBtn, marginTop: 12 }}>{alertsSaved ? '✓ Saved!' : 'Save Alert Settings'}</button>
          </div>
        )}

        {showSection === 'qr' && (
          <div style={s.card}>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>Print QR codes for each pod. Operators can scan to open their pod page.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center' }}>
              {(activeJob?.meta?.pods || []).map((podId) => (
                <div key={podId} style={{ textAlign: 'center' }}>
                  <img src={getQrUrl(podId)} alt={`QR for Pod ${podId}`} width={150} height={150}
                    style={{ borderRadius: 8, border: '1px solid #333' }} />
                  <p style={{ color: '#ccc', fontSize: 14, fontWeight: 600, marginTop: 4 }}>Pod {podId}</p>
                  <p style={{ color: '#666', fontSize: 10, wordBreak: 'break-all', maxWidth: 150 }}>{getPodUrl(podId)}</p>
                </div>
              ))}
            </div>
            <button onClick={printQrCodes}
              style={{ ...s.primaryBtn, marginTop: 16 }}>🖨 Print All QR Codes</button>
          </div>
        )}

        {showSection === 'schedule' && (
          <div style={s.card}>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>Automatically export the daily report at a set time.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <label style={{ color: '#ccc', fontSize: 14 }}>Enable auto-export</label>
              <button onClick={() => setAutoExportEnabled(!autoExportEnabled)}
                style={{ padding: '4px 16px', borderRadius: 20, border: 'none',
                  backgroundColor: autoExportEnabled ? '#22C55E' : '#333',
                  color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'background-color 0.2s' }}>
                {autoExportEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            <label style={s.label}>Export Time</label>
            <input type="time" value={autoExportTime} onChange={(e) => setAutoExportTime(e.target.value)}
              style={s.input} />
            <p style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
              Report will auto-download on any open Dashboard tab at this time
            </p>
            <label style={{ ...s.label, marginTop: 16 }}>📧 EOD Report Email</label>
            <input type="email" value={reportEmail} onChange={(e) => setReportEmail(e.target.value)}
              placeholder="e.g. supervisor@company.com" style={s.input} />
            <p style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
              Daily scan &amp; exception reports in Excel format will be emailed at the scheduled time
            </p>
            <button onClick={handleScheduleSave}
              style={{ ...s.primaryBtn, marginTop: 12 }}>{scheduleSaved ? '✓ Saved!' : 'Save Schedule'}</button>
          </div>
        )}

        {showSection === 'retention' && (
          <div style={s.card}>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>
              Delete old scans, exceptions, and audit logs to keep Firestore lean.
            </p>
            <label style={s.label}>Delete records older than (days)</label>
            <input type="number" value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))}
              min={7} style={s.input} />
            <button onClick={handleDataCleanup}
              style={{ ...s.dangerBtn, marginTop: 12, width: '100%' }}>
              🗑 Run Cleanup
            </button>
            {cleanupStatus && <p style={{ color: '#888', marginTop: 8, fontSize: 14 }}>{cleanupStatus}</p>}
          </div>
        )}

        {showSection === 'audit' && (
          <div style={s.card}>
            {auditLoading ? <p style={s.text}>Loading...</p> : (
              <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                {auditLogs.map((log) => (
                  <div key={log.id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #222', fontSize: 13 }}>
                    <span style={{ color: '#3B82F6', fontWeight: 600, minWidth: 120 }}>{log.action}</span>
                    <span style={{ color: '#888', flex: 1 }}>
                      {log.user?.name && <span style={{ color: '#A855F7', marginRight: 6 }}>{log.user.name}</span>}
                      {Object.entries(log).filter(([k]) => !['id', 'action', 'timestamp', 'user'].includes(k)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}
                    </span>
                    <span style={{ color: '#666', whiteSpace: 'nowrap' }}>{log.timestamp?.toDate?.()?.toLocaleString() || '—'}</span>
                  </div>
                ))}
                {auditLogs.length === 0 && <p style={{ color: '#888' }}>No audit logs yet.</p>}
              </div>
            )}
          </div>
        )}

        {showSection === 'customer' && (
          <div style={s.card}>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>Set the email and password for the Customer Portal (/portal). Customers use this to view daily volumes, reports, upload POs and BOLs.</p>
            <input type="email" value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="Customer email..." style={s.input} />
            <input type="text" value={customerPw}
              onChange={(e) => setCustomerPw(e.target.value)}
              placeholder="Customer password..." style={{ ...s.input, marginTop: 8 }} />
            <button onClick={async () => {
              if (!customerPw.trim()) return;
              const pwHash = await hashPassword(customerPw.trim());
              const update = { passwordHash: pwHash };
              if (customerEmail.trim()) update.email = customerEmail.trim().toLowerCase();
              await setDoc(doc(db, 'config', 'customer'), update, { merge: true });
              setCustomerPwSaved(true);
              setTimeout(() => setCustomerPwSaved(false), 2000);
            }} disabled={!customerPw.trim()}
              style={{ ...s.primaryBtn, marginTop: 8 }}>{customerPwSaved ? '✓ Saved!' : 'Save Customer Credentials'}</button>
          </div>
        )}

        {/* ─── Job Queue ─── */}
        <div style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ color: '#888', fontSize: 18, fontWeight: 700, margin: 0 }}>Job Queue</h2>
            <button onClick={() => setShowQueueForm(!showQueueForm)}
              style={{ ...s.secondaryBtn, borderColor: '#22C55E', color: '#22C55E' }}>
              {showQueueForm ? 'Cancel' : '+ Queue Next Job'}
            </button>
          </div>
          {queuedJobs.length === 0 && !showQueueForm && (
            <p style={{ color: '#666', fontSize: 14 }}>No jobs queued. Queue a job to auto-start when the current one closes.</p>
          )}
          {queuedJobs.map((qj, idx) => (
            <div key={qj.id} style={{ ...s.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: '#555', fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>#{idx + 1}</span>
                <div>
                  <div style={{ color: '#ccc', fontSize: 16, fontWeight: 700 }}>{qj.meta.name}</div>
                  <div style={{ color: '#666', fontSize: 13, marginTop: 2 }}>
                    {qj.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} · {qj.meta.pods?.length || 0} pods · Target: {(qj.meta.dailyTarget || 22000).toLocaleString()}
                    {qj.meta.location ? ` · ${qj.meta.location}` : ''}
                  </div>
                </div>
              </div>
              <button onClick={() => handleRemoveFromQueue(qj.id)}
                style={{ ...s.dangerBtn, fontSize: 13, padding: '8px 16px' }}>Remove</button>
            </div>
          ))}
          {showQueueForm && (
            <div style={s.card}>
              <h3 style={{ color: '#fff', fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>Queue a New Job</h3>
              <label style={s.label}>Job Name / PO Label</label>
              <input type="text" value={qJobName} onChange={(e) => setQJobName(e.target.value)}
                placeholder="e.g. PO-20261028" style={s.input} />

              <label style={s.label}>Warehouse Location (optional)</label>
              <input type="text" value={qLocation} onChange={(e) => setQLocation(e.target.value)}
                placeholder="e.g. Building A, Bay 3" style={s.input} />

              <label style={s.label}>Mode</label>
              <div style={{ display: 'flex', gap: 12 }}>
                <button onClick={() => setQMode('single')} style={qMode === 'single' ? s.activeToggle : s.toggle}>Single PO</button>
                <button onClick={() => setQMode('multi')} style={qMode === 'multi' ? s.activeToggle : s.toggle}>Multi-PO</button>
              </div>

              {qMode === 'multi' && (
                <div style={{ marginTop: 16 }}>
                  <label style={s.label}>Upload Manifest (CSV or XLSX — columns: ISBN, PO)</label>
                  <input type="file" accept=".csv,.xlsx,.xls" onChange={handleQueueFileUpload} style={s.input} disabled={qParsing} />
                  {qParsing && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ color: '#93C5FD', fontSize: 13, fontWeight: 600 }}>Parsing manifest... {qParseProgress}%</span>
                      <div style={{ height: 6, backgroundColor: '#222', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
                        <div style={{ height: '100%', width: `${qParseProgress}%`, backgroundColor: '#3B82F6', borderRadius: 3, transition: 'width 0.2s' }} />
                      </div>
                    </div>
                  )}
                  {customerPOUploads.filter((u) => u.status === 'pending').length > 0 && (
                    <div style={{ marginTop: 12, padding: 12, backgroundColor: '#1a1a2e', borderRadius: 8, border: '1px solid #3B82F6' }}>
                      <p style={{ color: '#93C5FD', fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>📦 Customer-Uploaded POs Available</p>
                      {customerPOUploads.filter((u) => u.status === 'pending').map((up) => (
                        <div key={up.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #333' }}>
                          <div>
                            <span style={{ color: '#ccc', fontSize: 13 }}>{(up.poNames || []).join(', ')}</span>
                            <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>({(up.isbnCount || 0).toLocaleString()} ISBNs)</span>
                          </div>
                          <button onClick={() => useCustomerUploadForQueue(up)}
                            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #3B82F6',
                              backgroundColor: qSelectedUploadId === up.id ? '#1E40AF' : 'transparent',
                              color: qSelectedUploadId === up.id ? '#fff' : '#3B82F6',
                              fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                            {qSelectedUploadId === up.id ? '✓ Selected' : 'Use This'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {qFileError && <p style={{ color: '#EF4444', marginTop: 4 }}>{qFileError}</p>}
                  {qManifest && (
                    <p style={{ color: '#22C55E', marginTop: 4 }}>
                      ✓ Loaded {Object.keys(qManifest).length.toLocaleString()} ISBNs across {qPoNames.length} POs
                    </p>
                  )}
                  {qPoNames.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <label style={s.label}>PO → Color Mapping</label>
                      {qPoNames.map((po) => (
                        <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                          <span style={{ ...s.text, minWidth: 120, fontSize: 14 }}>{po}</span>
                          <select value={qPoColors[po] || DEFAULT_COLORS[0].hex}
                            onChange={(e) => setQPoColors({ ...qPoColors, [po]: e.target.value })} style={{ ...s.input, flex: 1 }}>
                            {DEFAULT_COLORS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
                          </select>
                          <div style={{ width: 32, height: 32, borderRadius: 4, backgroundColor: qPoColors[po] || DEFAULT_COLORS[0].hex, border: '1px solid #555', flexShrink: 0 }} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <label style={{ ...s.label, marginTop: 16 }}>Daily Target</label>
              <input type="number" value={qDailyTarget} onChange={(e) => setQDailyTarget(e.target.value)} style={s.input} />
              <label style={s.label}>Working Hours Per Day</label>
              <input type="number" value={qWorkingHours} onChange={(e) => setQWorkingHours(e.target.value)} min={1} max={24} style={s.input} />
              <label style={s.label}>Pod IDs (comma-separated)</label>
              <input type="text" value={qPodInput} onChange={(e) => { setQPodInput(e.target.value); setQPods([...new Set(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))]); }}
                placeholder="A, B, C, D, E" style={s.input} />
              <p style={{ color: '#999', fontSize: 14, marginTop: 4 }}>{qPods.length} unique pod(s): {qPods.join(', ')}</p>

              <button onClick={handleQueueJob} disabled={qSaving}
                style={{ ...s.primaryBtn, marginTop: 24, opacity: qSaving ? 0.6 : 1, backgroundColor: '#3B82F6' }}>
                {qSaving ? 'Queuing...' : 'Add to Queue'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── New Job Form ───
  return (
    <div style={s.container}>
      <Link to="/" style={s.backLink}>← Back to Home</Link>
      <h1 style={s.title}>Job Setup</h1>
      <div style={s.card}>
        <label style={s.label}>Job Name / PO Label</label>
        <input type="text" value={jobName} onChange={(e) => setJobName(e.target.value)}
          placeholder="e.g. PO-20261021" style={s.input} />

        <label style={s.label}>Warehouse Location (optional)</label>
        <input type="text" value={location} onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Building A, Bay 3" style={s.input} />

        <label style={s.label}>Mode</label>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => setMode('single')} style={mode === 'single' ? s.activeToggle : s.toggle}>Single PO</button>
          <button onClick={() => setMode('multi')} style={mode === 'multi' ? s.activeToggle : s.toggle}>Multi-PO</button>
        </div>

        {mode === 'multi' && (
          <div style={{ marginTop: 16 }}>
            <label style={s.label}>Upload Manifest (CSV or XLSX — columns: ISBN, PO)</label>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} style={s.input} disabled={parsing} />
            {parsing && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ color: '#93C5FD', fontSize: 13, fontWeight: 600 }}>Parsing manifest... {parseProgress}%</span>
                </div>
                <div style={{ height: 6, backgroundColor: '#222', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${parseProgress}%`, backgroundColor: '#3B82F6', borderRadius: 3, transition: 'width 0.2s' }} />
                </div>
              </div>
            )}

            {/* Customer-uploaded POs */}
            {customerPOUploads.filter((u) => u.status === 'pending').length > 0 && (
              <div style={{ marginTop: 12, padding: 12, backgroundColor: '#1a1a2e', borderRadius: 8, border: '1px solid #3B82F6' }}>
                <p style={{ color: '#93C5FD', fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>
                  📦 Customer-Uploaded POs Available
                </p>
                {customerPOUploads.filter((u) => u.status === 'pending').map((up) => (
                  <div key={up.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #333' }}>
                    <div>
                      <span style={{ color: '#ccc', fontSize: 13 }}>{(up.poNames || []).join(', ')}</span>
                      <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>({(up.isbnCount || 0).toLocaleString()} ISBNs)</span>
                      <span style={{ color: '#666', fontSize: 11, marginLeft: 8 }}>
                        {up.uploadedAt?.toDate?.()?.toLocaleDateString() || ''}
                      </span>
                    </div>
                    <button onClick={() => useCustomerUpload(up)}
                      style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid #3B82F6',
                        backgroundColor: selectedUploadId === up.id ? '#1E40AF' : 'transparent',
                        color: selectedUploadId === up.id ? '#fff' : '#3B82F6',
                        fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      {selectedUploadId === up.id ? '✓ Selected' : 'Use This'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {fileError && <p style={{ color: '#EF4444', marginTop: 4 }}>{fileError}</p>}
            {manifest && (
              <p style={{ color: '#22C55E', marginTop: 4 }}>
                ✓ Loaded {Object.keys(manifest).length.toLocaleString()} ISBNs across {poNames.length} POs
                {poNames.length > 10 && <span style={{ color: '#EAB308' }}> (Warning: {poNames.length} POs — only 10 colors)</span>}
              </p>
            )}
            {poNames.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label style={s.label}>PO → Color Mapping</label>
                {poNames.map((po) => (
                  <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <span style={{ ...s.text, minWidth: 120, fontSize: 14 }}>{po}</span>
                    <select value={poColors[po] || DEFAULT_COLORS[0].hex}
                      onChange={(e) => setPoColors({ ...poColors, [po]: e.target.value })} style={{ ...s.input, flex: 1 }}>
                      {DEFAULT_COLORS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
                    </select>
                    <div style={{ width: 32, height: 32, borderRadius: 4, backgroundColor: poColors[po] || DEFAULT_COLORS[0].hex, border: '1px solid #555', flexShrink: 0 }} />
                  </div>
                ))}
              </div>
            )}
            {manifestPreview.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <label style={s.label}>Manifest Preview (first 50 rows)</label>
                <div style={{ maxHeight: 200, overflowY: 'auto', backgroundColor: '#0a0a0a', borderRadius: 8, border: '1px solid #333', fontSize: 13 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={s.th}>ISBN</th><th style={s.th}>PO</th></tr></thead>
                    <tbody>
                      {manifestPreview.map(([isbn, po]) => (
                        <tr key={isbn}><td style={s.td}>{isbn}</td><td style={s.td}>{po}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <label style={{ ...s.label, marginTop: 16 }}>Daily Target</label>
        <input type="number" value={dailyTarget} onChange={(e) => setDailyTarget(e.target.value)} style={s.input} />
        <label style={s.label}>Working Hours Per Day</label>
        <input type="number" value={workingHours} onChange={(e) => setWorkingHours(e.target.value)} min={1} max={24} style={s.input} />
        <label style={s.label}>Pod IDs (comma-separated)</label>
        <input type="text" value={podInput} onChange={(e) => handlePodInputChange(e.target.value)}
          placeholder="A, B, C, D, E" style={s.input} />
        <p style={{ color: '#999', fontSize: 14, marginTop: 4 }}>{pods.length} unique pod(s): {pods.join(', ')}</p>

        <button onClick={handleActivateJob} disabled={saving}
          style={{ ...s.primaryBtn, marginTop: 24, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Activating...' : 'Activate Job'}
        </button>
      </div>

      {/* Past Jobs */}
      {pastJobs.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ color: '#888', fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Past Jobs</h2>
          {pastJobs.map((pj) => (
            <div key={pj.id} style={{ ...s.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: 16 }}>
              <div>
                <div style={{ color: '#ccc', fontSize: 16, fontWeight: 700 }}>{pj.meta.name}</div>
                <div style={{ color: '#666', fontSize: 13, marginTop: 2 }}>
                  {pj.meta.mode} · {pj.meta.pods?.length || 0} pods · closed {pj.meta.closedAt?.toDate?.()?.toLocaleDateString() || '—'}
                </div>
              </div>
              <button onClick={async () => {
                if (!window.confirm(`Delete job "${pj.meta.name}" and ALL its data? This cannot be undone.`)) return;
                try {
                  const scanSnap = await getDocs(query(collection(db, 'scans'), where('jobId', '==', pj.id)));
                  const excSnap = await getDocs(query(collection(db, 'exceptions'), where('jobId', '==', pj.id)));
                  const shiftSnap = await getDocs(query(collection(db, 'shifts'), where('jobId', '==', pj.id)));
                  const bolSnap = await getDocs(query(collection(db, 'bols'), where('jobId', '==', pj.id)));
                  const mfSnap = await getDocs(collection(db, 'jobs', pj.id, 'manifest'));
                  const allDocs = [...scanSnap.docs, ...excSnap.docs, ...shiftSnap.docs, ...bolSnap.docs, ...mfSnap.docs];
                  let batch = writeBatch(db); let c = 0;
                  for (const d of allDocs) { batch.delete(d.ref); c++; if (c % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
                  batch.delete(doc(db, 'jobs', pj.id));
                  await batch.commit();
                  logAudit('job_deleted', { jobId: pj.id, jobName: pj.meta.name, deletedRecords: c });
                  setPastJobs((prev) => prev.filter((j) => j.id !== pj.id));
                } catch (err) { alert('Delete failed: ' + err.message); }
              }} style={{ ...s.dangerBtn, fontSize: 13, padding: '8px 16px' }}>🗑 Delete</button>
            </div>
          ))}
        </div>
      )}

      {/* Admin sections — always accessible */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 24, marginBottom: 12 }}>
        {['branding', 'customer', 'audit'].map((key) => (
          <button key={key} onClick={() => { setShowSection(showSection === key ? '' : key); if (key === 'audit') loadAuditLog(); }}
            style={{ ...s.secondaryBtn, ...(showSection === key ? { borderColor: '#3B82F6', color: '#3B82F6' } : {}) }}>
            {key === 'branding' ? '🎨 Branding' : key === 'audit' ? '📋 Audit' : '🔑 Customer'}
          </button>
        ))}
        <Link to="/users" style={{ ...s.secondaryBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>👥 Users</Link>
      </div>

      {showSection === 'branding' && (
        <div style={s.card}>
          <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>Customize your app branding.</p>
          <label style={s.label}>App Name</label>
          <input type="text" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="BookFlow" style={s.input} />
          <label style={s.label}>Subtitle</label>
          <input type="text" value={brandSubtitle} onChange={(e) => setBrandSubtitle(e.target.value)} placeholder="by PrepFort" style={s.input} />
          <button onClick={async () => {
            await setDoc(doc(db, 'config', 'branding'), { name: brandName.trim(), subtitle: brandSubtitle.trim(), logo: brandLogo }, { merge: true });
            setBrandSaved(true); setTimeout(() => setBrandSaved(false), 2000);
          }} style={{ ...s.primaryBtn, marginTop: 8 }}>{brandSaved ? '✓ Saved!' : 'Save Branding'}</button>
        </div>
      )}

      {showSection === 'customer' && (
        <div style={s.card}>
          <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>Set the email and password for the Customer Portal (/portal).</p>
          <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)}
            placeholder="Customer email..." style={s.input} />
          <input type="text" value={customerPw} onChange={(e) => setCustomerPw(e.target.value)}
            placeholder="Customer password..." style={{ ...s.input, marginTop: 8 }} />
          <button onClick={async () => {
            if (!customerPw.trim()) return;
            const pwHash = await hashPassword(customerPw.trim());
            const update = { passwordHash: pwHash };
            if (customerEmail.trim()) update.email = customerEmail.trim().toLowerCase();
            await setDoc(doc(db, 'config', 'customer'), update, { merge: true });
            setCustomerPwSaved(true); setTimeout(() => setCustomerPwSaved(false), 2000);
          }} disabled={!customerPw.trim()}
            style={{ ...s.primaryBtn, marginTop: 8 }}>{customerPwSaved ? '✓ Saved!' : 'Save Customer Credentials'}</button>
        </div>
      )}

      {showSection === 'audit' && (
        <div style={s.card}>
          {auditLoading ? <p style={s.text}>Loading...</p> : (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {auditLogs.map((log) => (
                <div key={log.id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #222', fontSize: 13 }}>
                  <span style={{ color: '#3B82F6', fontWeight: 600, minWidth: 120 }}>{log.action}</span>
                  <span style={{ color: '#888', flex: 1 }}>
                    {log.user?.name && <span style={{ color: '#A855F7', marginRight: 6 }}>{log.user.name}</span>}
                    {Object.entries(log).filter(([k]) => !['id', 'action', 'timestamp', 'user'].includes(k)).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}
                  </span>
                  <span style={{ color: '#666', whiteSpace: 'nowrap' }}>{log.timestamp?.toDate?.()?.toLocaleString() || '—'}</span>
                </div>
              ))}
              {auditLogs.length === 0 && <p style={{ color: '#888' }}>No audit logs yet.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', padding: '24px 20px', fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif", maxWidth: 720, margin: '0 auto' },
  backLink: { color: '#555', textDecoration: 'none', fontSize: 13, marginBottom: 12, display: 'inline-block', fontWeight: 600 },
  title: { fontSize: 26, fontWeight: 800, marginBottom: 20, marginTop: 8, letterSpacing: '-0.3px' },
  card: { backgroundColor: 'var(--bg-card, #161616)', borderRadius: 12, padding: '20px 22px', marginBottom: 14, border: '1px solid var(--border, #222)' },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#777', marginBottom: 6, marginTop: 14, textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid #2a2a2a', backgroundColor: 'var(--bg-input, #1a1a1a)', color: 'var(--text, #f0f0f0)', fontSize: 15, boxSizing: 'border-box', fontWeight: 500 },
  text: { color: '#ccc', fontSize: 15, margin: '4px 0' },
  toggle: { padding: '11px 20px', borderRadius: 8, border: '1px solid #2a2a2a', backgroundColor: '#1a1a1a', color: '#888', cursor: 'pointer', fontSize: 14, fontWeight: 600, flex: 1, textAlign: 'center' },
  activeToggle: { padding: '11px 20px', borderRadius: 8, border: '1px solid #3B82F6', backgroundColor: 'rgba(59,130,246,0.1)', color: '#93c5fd', cursor: 'pointer', fontSize: 14, fontWeight: 600, flex: 1, textAlign: 'center' },
  primaryBtn: { padding: '13px 24px', borderRadius: 10, border: 'none', backgroundColor: '#22C55E', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', width: '100%' },
  secondaryBtn: { padding: '9px 16px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: '#2a2a2a', backgroundColor: '#161616', color: '#aaa', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  dangerBtn: { padding: '11px 20px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  editBtn: { padding: '11px 20px', borderRadius: 8, border: '1px solid rgba(59,130,246,0.3)', backgroundColor: 'rgba(59,130,246,0.06)', color: '#93c5fd', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  linkBtn: { padding: '11px 20px', borderRadius: 8, backgroundColor: '#3B82F6', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none', display: 'inline-block', textAlign: 'center' },
  th: { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #222', color: '#666', fontWeight: 600, position: 'sticky', top: 0, backgroundColor: '#0f0f0f', fontSize: 12 },
  td: { padding: '6px 12px', borderBottom: '1px solid #1a1a1a', color: '#bbb', fontSize: 13 },
};
