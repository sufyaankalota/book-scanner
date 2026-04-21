import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import {
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  updateDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { parseManifestFile } from '../utils/manifest';

const DEFAULT_COLORS = [
  { name: 'Red', hex: '#EF4444' },
  { name: 'Blue', hex: '#3B82F6' },
  { name: 'Yellow', hex: '#EAB308' },
  { name: 'Green', hex: '#22C55E' },
  { name: 'Orange', hex: '#F97316' },
  { name: 'Purple', hex: '#A855F7' },
];

const DEFAULT_PODS = ['A', 'B', 'C', 'D', 'E'];

export default function Setup() {
  const [jobName, setJobName] = useState('');
  const [mode, setMode] = useState('single'); // 'single' | 'multi'
  const [dailyTarget, setDailyTarget] = useState(22000);
  const [workingHours, setWorkingHours] = useState(8);
  const [pods, setPods] = useState(DEFAULT_PODS);
  const [podInput, setPodInput] = useState(DEFAULT_PODS.join(', '));
  const [manifest, setManifest] = useState(null);
  const [poNames, setPoNames] = useState([]);
  const [poColors, setPoColors] = useState({});
  const [fileError, setFileError] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Check for active job on load
  useEffect(() => {
    (async () => {
      try {
        const q = query(
          collection(db, 'jobs'),
          where('meta.active', '==', true)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          const jobDoc = snap.docs[0];
          setActiveJob({ id: jobDoc.id, ...jobDoc.data() });
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
      // Auto-assign colors
      const colors = {};
      result.poNames.forEach((po, i) => {
        colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length].hex;
      });
      setPoColors(colors);
    } catch (err) {
      setFileError(err.message);
      setManifest(null);
      setPoNames([]);
    }
  };

  const handlePodInputChange = (val) => {
    setPodInput(val);
    const parsed = val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setPods(parsed);
  };

  const handleActivateJob = async () => {
    if (!jobName.trim()) return alert('Enter a job name');
    if (mode === 'multi' && !manifest) return alert('Upload a manifest for Multi-PO mode');
    if (pods.length === 0) return alert('Configure at least one pod');

    setSaving(true);
    try {
      const jobId = `job_${Date.now()}`;
      const jobRef = doc(db, 'jobs', jobId);

      await setDoc(jobRef, {
        meta: {
          name: jobName.trim(),
          mode,
          dailyTarget: Number(dailyTarget),
          workingHours: Number(workingHours),
          pods,
          active: true,
          createdAt: serverTimestamp(),
        },
        poColors: mode === 'multi' ? poColors : {},
      });

      // Store manifest in subcollection (avoids 1MB doc limit)
      if (mode === 'multi' && manifest) {
        const BATCH_SIZE = 400; // Firestore batch limit is 500
        const entries = Object.entries(manifest);
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          const chunk = entries.slice(i, i + BATCH_SIZE);
          for (const [isbn, poName] of chunk) {
            const ref = doc(db, 'jobs', jobId, 'manifest', isbn);
            batch.set(ref, { poName });
          }
          await batch.commit();
        }
      }

      setActiveJob({
        id: jobId,
        meta: {
          name: jobName.trim(),
          mode,
          dailyTarget: Number(dailyTarget),
          workingHours: Number(workingHours),
          pods,
          active: true,
        },
        poColors: mode === 'multi' ? poColors : {},
      });
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
      setActiveJob(null);
    } catch (err) {
      alert('Failed to close job: ' + err.message);
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <p style={styles.text}>Loading...</p>
      </div>
    );
  }

  // If there's an active job, show its status
  if (activeJob) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Active Job</h1>
        <div style={styles.card}>
          <p style={styles.text}>
            <strong>Job Name:</strong> {activeJob.meta.name}
          </p>
          <p style={styles.text}>
            <strong>Mode:</strong>{' '}
            {activeJob.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'}
          </p>
          <p style={styles.text}>
            <strong>Daily Target:</strong>{' '}
            {activeJob.meta.dailyTarget?.toLocaleString()}
          </p>
          <p style={styles.text}>
            <strong>Pods:</strong> {activeJob.meta.pods?.join(', ')}
          </p>
          {activeJob.meta.mode === 'multi' && activeJob.poColors && (
            <div style={{ marginTop: 12 }}>
              <strong style={styles.text}>PO Colors:</strong>
              {Object.entries(activeJob.poColors).map(([po, color]) => (
                <div key={po} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 4,
                      backgroundColor: color,
                      border: '1px solid #555',
                    }}
                  />
                  <span style={styles.text}>{po}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
            <a href="/dashboard" style={styles.linkBtn}>
              Go to Dashboard
            </a>
            <button onClick={handleCloseJob} style={styles.dangerBtn}>
              Close Job
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Job Setup</h1>
      <div style={styles.card}>
        {/* Job Name */}
        <label style={styles.label}>Job Name / PO Label</label>
        <input
          type="text"
          value={jobName}
          onChange={(e) => setJobName(e.target.value)}
          placeholder="e.g. PO-20261021"
          style={styles.input}
        />

        {/* Mode Toggle */}
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

        {/* Multi-PO: Manifest Upload */}
        {mode === 'multi' && (
          <div style={{ marginTop: 16 }}>
            <label style={styles.label}>
              Upload Manifest (CSV or XLSX — columns: ISBN, PO)
            </label>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
              style={styles.input}
            />
            {fileError && <p style={{ color: '#EF4444' }}>{fileError}</p>}
            {manifest && (
              <p style={{ color: '#22C55E' }}>
                ✓ Loaded {Object.keys(manifest).length} ISBNs across{' '}
                {poNames.length} POs
              </p>
            )}

            {/* PO Color Mapping */}
            {poNames.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label style={styles.label}>PO → Color Mapping</label>
                {poNames.map((po) => (
                  <div
                    key={po}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      marginTop: 8,
                    }}
                  >
                    <span style={{ ...styles.text, minWidth: 120 }}>{po}</span>
                    <select
                      value={poColors[po] || DEFAULT_COLORS[0].hex}
                      onChange={(e) =>
                        setPoColors({ ...poColors, [po]: e.target.value })
                      }
                      style={styles.input}
                    >
                      {DEFAULT_COLORS.map((c) => (
                        <option key={c.hex} value={c.hex}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 4,
                        backgroundColor: poColors[po] || DEFAULT_COLORS[0].hex,
                        border: '1px solid #555',
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Daily Target */}
        <label style={{ ...styles.label, marginTop: 16 }}>Daily Target</label>
        <input
          type="number"
          value={dailyTarget}
          onChange={(e) => setDailyTarget(e.target.value)}
          style={styles.input}
        />

        {/* Working Hours */}
        <label style={styles.label}>Working Hours Per Day</label>
        <input
          type="number"
          value={workingHours}
          onChange={(e) => setWorkingHours(e.target.value)}
          min={1}
          max={24}
          style={styles.input}
        />

        {/* Pod Configuration */}
        <label style={styles.label}>
          Pod IDs (comma-separated)
        </label>
        <input
          type="text"
          value={podInput}
          onChange={(e) => handlePodInputChange(e.target.value)}
          placeholder="A, B, C, D, E"
          style={styles.input}
        />
        <p style={{ color: '#999', fontSize: 14 }}>
          {pods.length} pod(s): {pods.join(', ')}
        </p>

        {/* Activate */}
        <button
          onClick={handleActivateJob}
          disabled={saving}
          style={{ ...styles.primaryBtn, marginTop: 24 }}
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
    padding: 32,
    fontFamily: 'system-ui, sans-serif',
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 24,
  },
  label: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: '#aaa',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 6,
    border: '1px solid #333',
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 16,
    boxSizing: 'border-box',
  },
  text: {
    color: '#ddd',
    fontSize: 16,
    margin: '4px 0',
  },
  toggle: {
    padding: '10px 20px',
    borderRadius: 6,
    border: '1px solid #444',
    backgroundColor: '#222',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
  activeToggle: {
    padding: '10px 20px',
    borderRadius: 6,
    border: '1px solid #3B82F6',
    backgroundColor: '#1e3a5f',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
  primaryBtn: {
    padding: '14px 28px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#22C55E',
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%',
  },
  dangerBtn: {
    padding: '12px 24px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#EF4444',
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
  },
  linkBtn: {
    padding: '12px 24px',
    borderRadius: 8,
    backgroundColor: '#3B82F6',
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    textDecoration: 'none',
    display: 'inline-block',
  },
};
