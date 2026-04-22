import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDoc, getDocs,
  query, where, updateDoc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { parseManifestFile } from '../utils/manifest';

const DEFAULT_COLORS = [
  { name: 'Red', hex: '#EF4444' },
  { name: 'Blue', hex: '#3B82F6' },
  { name: 'Yellow', hex: '#EAB308' },
  { name: 'Green', hex: '#22C55E' },
  { name: 'Orange', hex: '#F97316' },
  { name: 'Purple', hex: '#A855F7' },
  { name: 'Pink', hex: '#EC4899' },
  { name: 'Teal', hex: '#14B8A6' },
  { name: 'Indigo', hex: '#6366F1' },
  { name: 'Lime', hex: '#84CC16' },
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

  // Edit active job
  const [editMode, setEditMode] = useState(false);
  const [editTarget, setEditTarget] = useState('');
  const [editHours, setEditHours] = useState('');
  const [editPods, setEditPods] = useState('');

  // PIN management
  const [pinValue, setPinValue] = useState('');
  const [pinSaved, setPinSaved] = useState(false);
  const [showPinSection, setShowPinSection] = useState(false);

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
      } catch (err) {
        console.error('Failed to check active job:', err);
      }
      setLoading(false);
    })();
  }, []);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileError('');
    try {
      const result = await parseManifestFile(file);
      setManifest(result.manifest);
      setPoNames(result.poNames);
      setManifestPreview(Object.entries(result.manifest).slice(0, 50));
      const colors = {};
      result.poNames.forEach((po, i) => {
        colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex;
      });
      setPoColors(colors);
    } catch (err) {
      setFileError(err.message);
      setManifest(null);
      setPoNames([]);
      setManifestPreview([]);
    }
  };

  const handlePodInputChange = (val) => {
    setPodInput(val);
    const parsed = [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))];
    setPods(parsed);
  };

  const handleActivateJob = async () => {
    if (!jobName.trim()) return alert('Enter a job name');
    if (mode === 'multi' && !manifest) return alert('Upload a manifest for Multi-PO mode');
    if (pods.length === 0) return alert('Configure at least one pod');
    const target = Number(dailyTarget);
    const hours = Number(workingHours);
    if (!target || target <= 0) return alert('Enter a valid daily target');
    if (!hours || hours <= 0 || hours > 24) return alert('Enter valid working hours (1-24)');

    setSaving(true);
    try {
      // Race condition guard — re-check for active jobs
      const existing = await getDocs(query(collection(db, 'jobs'), where('meta.active', '==', true)));
      if (!existing.empty) {
        alert('Another job is already active. Close it first.');
        const d = existing.docs[0];
        setActiveJob({ id: d.id, ...d.data() });
        setSaving(false);
        return;
      }

      const jobId = `job_${Date.now()}`;
      const jobRef = doc(db, 'jobs', jobId);

      await setDoc(jobRef, {
        meta: {
          name: jobName.trim(),
          mode,
          dailyTarget: target,
          workingHours: hours,
          pods,
          active: true,
          createdAt: serverTimestamp(),
        },
        poColors: mode === 'multi' ? poColors : {},
      });

      if (mode === 'multi' && manifest) {
        const BATCH_SIZE = 400;
        const entries = Object.entries(manifest);
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          const chunk = entries.slice(i, i + BATCH_SIZE);
          for (const [isbn, poName] of chunk) {
            batch.set(doc(db, 'jobs', jobId, 'manifest', isbn), { poName });
          }
          await batch.commit();
        }
      }

      const jobData = {
        id: jobId,
        meta: { name: jobName.trim(), mode, dailyTarget: target, workingHours: hours, pods, active: true },
        poColors: mode === 'multi' ? poColors : {},
      };
      setActiveJob(jobData);
      setEditTarget(target);
      setEditHours(hours);
      setEditPods(pods.join(', '));
    } catch (err) {
      alert('Failed to create job: ' + err.message);
    }
    setSaving(false);
  };

  const handleCloseJob = async () => {
    if (!activeJob) return;
    if (!window.confirm('Close this job? Pods will no longer be able to scan.')) return;
    try {
      await updateDoc(doc(db, 'jobs', activeJob.id), {
        'meta.active': false,
        'meta.closedAt': serverTimestamp(),
      });
      // Clear presence
      for (const podId of activeJob.meta.pods || []) {
        try {
          await setDoc(doc(db, 'presence', podId), {
            podId, scanners: [], operator: '', status: 'offline', online: false, lastSeen: serverTimestamp(),
          });
        } catch {}
      }
      setActiveJob(null);
      setEditMode(false);
    } catch (err) {
      alert('Failed to close job: ' + err.message);
    }
  };

  const handleEditSave = async () => {
    const target = Number(editTarget);
    const hours = Number(editHours);
    if (!target || target <= 0) return alert('Enter a valid daily target');
    if (!hours || hours <= 0 || hours > 24) return alert('Enter valid working hours');
    const newPods = [...new Set(editPods.split(',').map((s) => s.trim()).filter(Boolean))];
    if (newPods.length === 0) return alert('Need at least one pod');
    try {
      await updateDoc(doc(db, 'jobs', activeJob.id), {
        'meta.dailyTarget': target,
        'meta.workingHours': hours,
        'meta.pods': newPods,
      });
      setActiveJob({
        ...activeJob,
        meta: { ...activeJob.meta, dailyTarget: target, workingHours: hours, pods: newPods },
      });
      setEditMode(false);
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  };

  const handlePinChange = async () => {
    if (!pinValue || pinValue.length < 4) return alert('PIN must be at least 4 digits');
    try {
      await setDoc(doc(db, 'config', 'supervisor'), { pin: pinValue });
      setPinSaved(true);
      setPinValue('');
      setTimeout(() => setPinSaved(false), 3000);
    } catch (err) {
      alert('Failed to save PIN: ' + err.message);
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <p style={styles.text}>Loading...</p>
      </div>
    );
  }

  // ─── Active Job View ───
  if (activeJob) {
    return (
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
        <h1 style={styles.title}>Active Job</h1>
        <div style={styles.card}>
          {!editMode ? (
            <>
              <p style={styles.text}><strong>Job Name:</strong> {activeJob.meta.name}</p>
              <p style={styles.text}><strong>Mode:</strong> {activeJob.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'}</p>
              <p style={styles.text}><strong>Daily Target:</strong> {activeJob.meta.dailyTarget?.toLocaleString()}</p>
              <p style={styles.text}><strong>Working Hours:</strong> {activeJob.meta.workingHours}</p>
              <p style={styles.text}><strong>Pods:</strong> {activeJob.meta.pods?.join(', ')}</p>

              {activeJob.meta.mode === 'multi' && activeJob.poColors && (
                <div style={{ marginTop: 12 }}>
                  <strong style={styles.text}>PO Colors:</strong>
                  {Object.entries(activeJob.poColors).map(([po, color]) => (
                    <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <div style={{ width: 24, height: 24, borderRadius: 4, backgroundColor: color, border: '1px solid #555' }} />
                      <span style={styles.text}>{po}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 24, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Link to="/dashboard" style={styles.linkBtn}>Go to Dashboard</Link>
                <button onClick={() => setEditMode(true)} style={styles.editBtn}>✏️ Edit Job</button>
                <button onClick={handleCloseJob} style={styles.dangerBtn}>Close Job</button>
              </div>
            </>
          ) : (
            <>
              <h2 style={{ color: '#fff', fontSize: 20, marginBottom: 16, marginTop: 0 }}>Edit Job Settings</h2>
              <label style={styles.label}>Daily Target</label>
              <input
                type="number" value={editTarget}
                onChange={(e) => setEditTarget(e.target.value)}
                style={styles.input}
              />
              <label style={styles.label}>Working Hours Per Day</label>
              <input
                type="number" value={editHours}
                onChange={(e) => setEditHours(e.target.value)}
                min={1} max={24} style={styles.input}
              />
              <label style={styles.label}>Pod IDs (comma-separated)</label>
              <input
                type="text" value={editPods}
                onChange={(e) => setEditPods(e.target.value)}
                style={styles.input}
              />
              <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
                <button onClick={handleEditSave} style={styles.primaryBtn}>Save Changes</button>
                <button onClick={() => setEditMode(false)} style={styles.secondaryBtn}>Cancel</button>
              </div>
            </>
          )}
        </div>

        {/* Supervisor PIN section */}
        <div style={{ ...styles.card, marginTop: 24 }}>
          <button
            onClick={() => setShowPinSection(!showPinSection)}
            style={{ ...styles.secondaryBtn, width: '100%', textAlign: 'left' }}
          >
            🔒 {showPinSection ? 'Hide' : 'Change'} Supervisor PIN
          </button>
          {showPinSection && (
            <div style={{ marginTop: 16 }}>
              <p style={{ color: '#888', fontSize: 14, marginBottom: 8 }}>Default PIN is 1234. Change it here.</p>
              <input
                type="password"
                inputMode="numeric"
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePinChange(); }}
                placeholder="New PIN (4+ digits)..."
                style={styles.input}
                maxLength={8}
              />
              <button onClick={handlePinChange} disabled={!pinValue} style={{ ...styles.primaryBtn, marginTop: 8 }}>
                {pinSaved ? '✓ PIN Saved!' : 'Update PIN'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── New Job Form ───
  return (
    <div style={styles.container}>
      <Link to="/" style={styles.backLink}>← Back to Home</Link>
      <h1 style={styles.title}>Job Setup</h1>
      <div style={styles.card}>
        <label style={styles.label}>Job Name / PO Label</label>
        <input
          type="text" value={jobName}
          onChange={(e) => setJobName(e.target.value)}
          placeholder="e.g. PO-20261021"
          style={styles.input}
        />

        <label style={styles.label}>Mode</label>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={() => setMode('single')}
            style={mode === 'single' ? styles.activeToggle : styles.toggle}
          >
            Single PO
          </button>
          <button
            onClick={() => setMode('multi')}
            style={mode === 'multi' ? styles.activeToggle : styles.toggle}
          >
            Multi-PO
          </button>
        </div>

        {mode === 'multi' && (
          <div style={{ marginTop: 16 }}>
            <label style={styles.label}>
              Upload Manifest (CSV or XLSX — columns: ISBN, PO)
            </label>
            <input
              type="file" accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload} style={styles.input}
            />
            {fileError && <p style={{ color: '#EF4444', marginTop: 4 }}>{fileError}</p>}
            {manifest && (
              <p style={{ color: '#22C55E', marginTop: 4 }}>
                ✓ Loaded {Object.keys(manifest).length.toLocaleString()} ISBNs across {poNames.length} POs
                {poNames.length > 10 && (
                  <span style={{ color: '#EAB308' }}> (Warning: {poNames.length} POs — only 10 colors available)</span>
                )}
              </p>
            )}

            {/* PO Color Mapping */}
            {poNames.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label style={styles.label}>PO → Color Mapping</label>
                {poNames.map((po) => (
                  <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <span style={{ ...styles.text, minWidth: 120, fontSize: 14 }}>{po}</span>
                    <select
                      value={poColors[po] || DEFAULT_COLORS[0].hex}
                      onChange={(e) => setPoColors({ ...poColors, [po]: e.target.value })}
                      style={{ ...styles.input, flex: 1 }}
                    >
                      {DEFAULT_COLORS.map((c) => (
                        <option key={c.hex} value={c.hex}>{c.name}</option>
                      ))}
                    </select>
                    <div style={{ width: 32, height: 32, borderRadius: 4, backgroundColor: poColors[po] || DEFAULT_COLORS[0].hex, border: '1px solid #555', flexShrink: 0 }} />
                  </div>
                ))}
              </div>
            )}

            {/* Manifest preview */}
            {manifestPreview.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <label style={styles.label}>Manifest Preview (first 50 rows)</label>
                <div style={{ maxHeight: 200, overflowY: 'auto', backgroundColor: '#0a0a0a', borderRadius: 8, border: '1px solid #333', fontSize: 13 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={styles.th}>ISBN</th>
                        <th style={styles.th}>PO</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manifestPreview.map(([isbn, po]) => (
                        <tr key={isbn}>
                          <td style={styles.td}>{isbn}</td>
                          <td style={styles.td}>{po}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <label style={{ ...styles.label, marginTop: 16 }}>Daily Target</label>
        <input
          type="number" value={dailyTarget}
          onChange={(e) => setDailyTarget(e.target.value)}
          style={styles.input}
        />

        <label style={styles.label}>Working Hours Per Day</label>
        <input
          type="number" value={workingHours}
          onChange={(e) => setWorkingHours(e.target.value)}
          min={1} max={24} style={styles.input}
        />

        <label style={styles.label}>Pod IDs (comma-separated)</label>
        <input
          type="text" value={podInput}
          onChange={(e) => handlePodInputChange(e.target.value)}
          placeholder="A, B, C, D, E"
          style={styles.input}
        />
        <p style={{ color: '#999', fontSize: 14, marginTop: 4 }}>
          {pods.length} unique pod(s): {pods.join(', ')}
        </p>

        <button
          onClick={handleActivateJob}
          disabled={saving}
          style={{ ...styles.primaryBtn, marginTop: 24, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Activating...' : 'Activate Job'}
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#111',
    color: '#fff',
    padding: '24px 16px',
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 800,
    margin: '0 auto',
  },
  backLink: {
    color: '#666',
    textDecoration: 'none',
    fontSize: 14,
    marginBottom: 12,
    display: 'inline-block',
  },
  title: { fontSize: 32, fontWeight: 700, marginBottom: 24, marginTop: 8 },
  card: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 24 },
  label: { display: 'block', fontSize: 14, fontWeight: 600, color: '#aaa', marginBottom: 6, marginTop: 16 },
  input: {
    width: '100%', padding: '12px 14px', borderRadius: 8,
    border: '1px solid #333', backgroundColor: '#222', color: '#fff',
    fontSize: 16, boxSizing: 'border-box',
  },
  text: { color: '#ddd', fontSize: 16, margin: '4px 0' },
  toggle: {
    padding: '12px 20px', borderRadius: 8, border: '1px solid #444',
    backgroundColor: '#222', color: '#aaa', cursor: 'pointer', fontSize: 14,
    fontWeight: 600, flex: 1, textAlign: 'center',
  },
  activeToggle: {
    padding: '12px 20px', borderRadius: 8, border: '1px solid #3B82F6',
    backgroundColor: '#1e3a5f', color: '#fff', cursor: 'pointer', fontSize: 14,
    fontWeight: 600, flex: 1, textAlign: 'center',
  },
  primaryBtn: {
    padding: '14px 28px', borderRadius: 8, border: 'none',
    backgroundColor: '#22C55E', color: '#fff', fontSize: 18,
    fontWeight: 700, cursor: 'pointer', width: '100%',
  },
  secondaryBtn: {
    padding: '12px 20px', borderRadius: 8, border: '1px solid #444',
    backgroundColor: '#222', color: '#ccc', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  dangerBtn: {
    padding: '12px 24px', borderRadius: 8, border: 'none',
    backgroundColor: '#EF4444', color: '#fff', fontSize: 16,
    fontWeight: 700, cursor: 'pointer',
  },
  editBtn: {
    padding: '12px 24px', borderRadius: 8, border: '1px solid #3B82F6',
    backgroundColor: 'transparent', color: '#3B82F6', fontSize: 16,
    fontWeight: 600, cursor: 'pointer',
  },
  linkBtn: {
    padding: '12px 24px', borderRadius: 8, backgroundColor: '#3B82F6',
    color: '#fff', fontSize: 16, fontWeight: 700, textDecoration: 'none',
    display: 'inline-block', textAlign: 'center',
  },
  th: {
    padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #333',
    color: '#888', fontWeight: 600, position: 'sticky', top: 0, backgroundColor: '#0a0a0a',
  },
  td: {
    padding: '6px 12px', borderBottom: '1px solid #222', color: '#ccc',
  },
};
