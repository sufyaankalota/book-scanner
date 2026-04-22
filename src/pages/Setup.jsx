import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc,
  query, where, updateDoc, serverTimestamp, writeBatch, Timestamp,
} from 'firebase/firestore';
import { parseManifestFile } from '../utils/manifest';
import { logAudit } from '../utils/audit';

const DEFAULT_COLORS = [
  { name: 'Red', hex: '#EF4444' }, { name: 'Blue', hex: '#3B82F6' },
  { name: 'Yellow', hex: '#EAB308' }, { name: 'Green', hex: '#22C55E' },
  { name: 'Orange', hex: '#F97316' }, { name: 'Purple', hex: '#A855F7' },
  { name: 'Pink', hex: '#EC4899' }, { name: 'Teal', hex: '#14B8A6' },
  { name: 'Indigo', hex: '#6366F1' }, { name: 'Lime', hex: '#84CC16' },
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
  const [activeJob, setActiveJob] = useState(null);
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
  const [brandSaved, setBrandSaved] = useState(false);

  // Data retention
  const [retentionDays, setRetentionDays] = useState(90);
  const [cleanupStatus, setCleanupStatus] = useState('');

  // Audit log
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
        const snap = await getDocs(q);
        if (!snap.empty) {
          const jobDoc = snap.docs[0];
          const jobData = { id: jobDoc.id, ...jobDoc.data() };
          setActiveJob(jobData);
          setEditTarget(jobData.meta.dailyTarget);
          setEditHours(jobData.meta.workingHours);
          setEditPods(jobData.meta.pods?.join(', ') || '');
        }
        // Load branding
        const brandDoc = await getDoc(doc(db, 'config', 'branding'));
        if (brandDoc.exists()) {
          setBrandName(brandDoc.data().name || '');
          setBrandSubtitle(brandDoc.data().subtitle || '');
        }
      } catch (err) { console.error('Failed to load:', err); }
      setLoading(false);
    })();
  }, []);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setFileError('');
    try {
      const result = await parseManifestFile(file);
      setManifest(result.manifest); setPoNames(result.poNames);
      setManifestPreview(Object.entries(result.manifest).slice(0, 50));
      const colors = {};
      result.poNames.forEach((po, i) => { colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex; });
      setPoColors(colors);
    } catch (err) { setFileError(err.message); setManifest(null); setPoNames([]); setManifestPreview([]); }
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
      }
      logAudit('job_created', { jobId, name: jobName.trim(), mode });
      setActiveJob({ id: jobId, meta: { name: jobName.trim(), mode, dailyTarget: target, workingHours: hours, pods, active: true, location: location.trim() || '' }, poColors: mode === 'multi' ? poColors : {} });
      setEditTarget(target); setEditHours(hours); setEditPods(pods.join(', '));
    } catch (err) { alert('Failed to create job: ' + err.message); }
    setSaving(false);
  };

  const handleCloseJob = async () => {
    if (!activeJob) return;
    if (!window.confirm('Close this job? Pods will no longer be able to scan.')) return;
    try {
      await updateDoc(doc(db, 'jobs', activeJob.id), { 'meta.active': false, 'meta.closedAt': serverTimestamp() });
      for (const podId of activeJob.meta.pods || []) {
        try { await setDoc(doc(db, 'presence', podId), { podId, scanners: [], operator: '', status: 'offline', online: false, lastSeen: serverTimestamp() }); } catch {}
      }
      logAudit('job_closed', { jobId: activeJob.id });
      setActiveJob(null); setEditMode(false);
    } catch (err) { alert('Failed to close job: ' + err.message); }
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
      await setDoc(doc(db, 'config', 'supervisor'), { pin: pinValue });
      logAudit('pin_changed', {}); setPinSaved(true); setPinValue('');
      setTimeout(() => setPinSaved(false), 3000);
    } catch (err) { alert('Failed to save PIN: ' + err.message); }
  };

  const handleBrandingSave = async () => {
    try {
      await setDoc(doc(db, 'config', 'branding'), { name: brandName.trim(), subtitle: brandSubtitle.trim() });
      logAudit('branding_updated', { name: brandName.trim() }); setBrandSaved(true);
      setTimeout(() => setBrandSaved(false), 3000);
    } catch (err) { alert('Failed to save branding: ' + err.message); }
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
          {['pin', 'branding', 'retention', 'audit'].map((key) => (
            <button key={key} onClick={() => { setShowSection(showSection === key ? '' : key); if (key === 'audit') loadAuditLog(); }}
              style={{ ...s.secondaryBtn, ...(showSection === key ? { borderColor: '#3B82F6', color: '#3B82F6' } : {}) }}>
              {key === 'pin' ? '🔒 PIN' : key === 'branding' ? '🎨 Branding' : key === 'retention' ? '🗑 Data Retention' : '📋 Audit Log'}
            </button>
          ))}
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
            <label style={s.label}>Company / Warehouse Name</label>
            <input type="text" value={brandName} onChange={(e) => setBrandName(e.target.value)}
              placeholder="e.g. ACME Warehouse" style={s.input} />
            <label style={s.label}>Subtitle</label>
            <input type="text" value={brandSubtitle} onChange={(e) => setBrandSubtitle(e.target.value)}
              placeholder="e.g. Book Processing Center" style={s.input} />
            <button onClick={handleBrandingSave}
              style={{ ...s.primaryBtn, marginTop: 12 }}>{brandSaved ? '✓ Saved!' : 'Save Branding'}</button>
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
                      {Object.entries(log).filter(([k]) => !['id', 'action', 'timestamp'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ')}
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
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} style={s.input} />
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
    </div>
  );
}

const s = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #111)', color: 'var(--text, #fff)', padding: '24px 16px', fontFamily: 'system-ui,sans-serif', maxWidth: 800, margin: '0 auto' },
  backLink: { color: '#666', textDecoration: 'none', fontSize: 14, marginBottom: 12, display: 'inline-block' },
  title: { fontSize: 32, fontWeight: 700, marginBottom: 24, marginTop: 8 },
  card: { backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 12, padding: 24, marginBottom: 16 },
  label: { display: 'block', fontSize: 14, fontWeight: 600, color: '#aaa', marginBottom: 6, marginTop: 16 },
  input: { width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #333', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text, #fff)', fontSize: 16, boxSizing: 'border-box' },
  text: { color: '#ddd', fontSize: 16, margin: '4px 0' },
  toggle: { padding: '12px 20px', borderRadius: 8, border: '1px solid #444', backgroundColor: '#222', color: '#aaa', cursor: 'pointer', fontSize: 14, fontWeight: 600, flex: 1, textAlign: 'center' },
  activeToggle: { padding: '12px 20px', borderRadius: 8, border: '1px solid #3B82F6', backgroundColor: '#1e3a5f', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, flex: 1, textAlign: 'center' },
  primaryBtn: { padding: '14px 28px', borderRadius: 8, border: 'none', backgroundColor: '#22C55E', color: '#fff', fontSize: 18, fontWeight: 700, cursor: 'pointer', width: '100%' },
  secondaryBtn: { padding: '10px 18px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: '#444', backgroundColor: '#222', color: '#ccc', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  dangerBtn: { padding: '12px 24px', borderRadius: 8, border: 'none', backgroundColor: '#EF4444', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  editBtn: { padding: '12px 24px', borderRadius: 8, border: '1px solid #3B82F6', backgroundColor: 'transparent', color: '#3B82F6', fontSize: 16, fontWeight: 600, cursor: 'pointer' },
  linkBtn: { padding: '12px 24px', borderRadius: 8, backgroundColor: '#3B82F6', color: '#fff', fontSize: 16, fontWeight: 700, textDecoration: 'none', display: 'inline-block', textAlign: 'center' },
  th: { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #333', color: '#888', fontWeight: 600, position: 'sticky', top: 0, backgroundColor: '#0a0a0a' },
  td: { padding: '6px 12px', borderBottom: '1px solid #222', color: '#ccc' },
};
