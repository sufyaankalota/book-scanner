import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, query, where, onSnapshot,
} from 'firebase/firestore';
import { usePresence } from '../hooks/usePresence';

const STORAGE_KEY = 'kiosk_assigned_pods';
const DEVICE_NAME_KEY = 'kiosk_device_name';
const MAX_DEVICE_NAME = 40;

// Strip control chars / HTML so a pasted device name can't break the UI or render markup elsewhere.
function sanitizeDeviceName(s) {
  return String(s || '')
    .replace(/[<>"'&]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_DEVICE_NAME);
}

function getAssignedPods() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(v) || v.length === 0) return null;
    // Defensive: only allow short alphanumeric pod ids
    return v.filter((p) => typeof p === 'string' && /^[A-Z0-9]{1,4}$/i.test(p)).map((p) => p.toUpperCase());
  } catch { return null; }
}

function getDeviceName() {
  return sanitizeDeviceName(localStorage.getItem(DEVICE_NAME_KEY) || '');
}

export default function PodSelect() {
  const navigate = useNavigate();
  const [assignedPods, setAssignedPods] = useState(getAssignedPods);
  const [deviceName, setDeviceName] = useState(getDeviceName);
  const [setupMode, setSetupMode] = useState(!getAssignedPods());
  const [job, setJob] = useState(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [jobError, setJobError] = useState(null);
  const { presence } = usePresence(60000);

  // Setup form state
  const [selectedPods, setSelectedPods] = useState(getAssignedPods() || []);
  const [editDeviceName, setEditDeviceName] = useState(getDeviceName());

  // Load active job to get available pods
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(
      q,
      (snap) => {
        if (!snap.empty) {
          const d = snap.docs[0];
          setJob({ id: d.id, ...d.data() });
        } else {
          setJob(null);
        }
        setJobLoading(false);
        setJobError(null);
      },
      (err) => {
        setJobError(err?.message || 'Failed to load job');
        setJobLoading(false);
      }
    );
    return unsub;
  }, []);

  // Listen to pod presence — handled by usePresence hook above

  const allPods = job?.meta?.pods || ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  const togglePod = (podId) => {
    setSelectedPods((prev) =>
      prev.includes(podId)
        ? prev.filter((p) => p !== podId)
        : [...prev, podId]
    );
  };

  const saveSetup = () => {
    if (selectedPods.length === 0) return;
    const sorted = [...selectedPods].sort();
    const cleanName = sanitizeDeviceName(editDeviceName);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
    localStorage.setItem(DEVICE_NAME_KEY, cleanName);
    setAssignedPods(sorted);
    setDeviceName(cleanName);
    setSetupMode(false);
  };

  const openSetup = () => {
    setSelectedPods(assignedPods || []);
    setEditDeviceName(deviceName);
    setSetupMode(true);
  };

  // ─── Setup Mode ───
  if (setupMode) {
    return (
      <div style={styles.container}>
        <div style={styles.setupCard}>
          <h1 style={styles.heading}>🖥️ Device Setup</h1>
          <p style={styles.hint}>
            Select the pods assigned to this kiosk laptop.
            This only needs to be done once per device.
          </p>

          <label style={styles.label}>Device Name (optional)</label>
          <input
            type="text"
            value={editDeviceName}
            onChange={(e) => setEditDeviceName(sanitizeDeviceName(e.target.value))}
            placeholder="e.g. Laptop-1, Station-A..."
            maxLength={MAX_DEVICE_NAME}
            style={styles.input}
          />

          <label style={{ ...styles.label, marginTop: 20 }}>
            Select Pods ({selectedPods.length} selected)
          </label>
          <div style={styles.setupGrid}>
            {allPods.map((podId) => {
              const isSelected = selectedPods.includes(podId);
              return (
                <button
                  key={podId}
                  onClick={() => togglePod(podId)}
                  style={{
                    ...styles.setupPodBtn,
                    backgroundColor: isSelected ? '#166534' : 'var(--bg-input, #222)',
                    borderColor: isSelected ? '#22C55E' : 'var(--border, #333)',
                    color: isSelected ? '#fff' : 'var(--text-secondary, #888)',
                  }}
                >
                  <span style={{ fontSize: 28, fontWeight: 800 }}>Pod {podId}</span>
                  {isSelected && <span style={{ fontSize: 22, marginTop: 4 }}>✓</span>}
                </button>
              );
            })}
          </div>

          <button
            onClick={saveSetup}
            disabled={selectedPods.length === 0}
            style={{
              ...styles.primaryBtn,
              marginTop: 24,
              opacity: selectedPods.length > 0 ? 1 : 0.4,
            }}
          >
            Save & Continue
          </button>

          {assignedPods && (
            <button onClick={() => setSetupMode(false)} style={{ ...styles.secondaryBtn, marginTop: 12 }}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── Pod Selector ───
  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.heading}>
            {deviceName ? `📋 ${deviceName}` : '📋 Select Pod'}
          </h1>
          {job && (
            <p style={styles.jobInfo}>
              <span style={styles.jobDot} />
              {job.meta.name} · {job.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'}
            </p>
          )}
          {jobLoading && !job && (
            <p style={{ color: '#888', fontSize: 14, fontWeight: 600, margin: '4px 0 0' }}>
              Loading job…
            </p>
          )}
          {jobError && (
            <p style={{ color: '#EF4444', fontSize: 13, fontWeight: 600, margin: '4px 0 0' }}>
              ⚠️ Connection error — retrying
            </p>
          )}
          {!job && !jobLoading && !jobError && (
            <p style={{ color: '#EF4444', fontSize: 14, fontWeight: 600, margin: '4px 0 0' }}>
              No active job
            </p>
          )}
        </div>
        <button onClick={openSetup} style={styles.gearBtn} title="Device Settings">
          ⚙️
        </button>
      </div>

      {/* Pod cards */}
      <div style={styles.podGrid}>
        {assignedPods.map((podId) => {
          const p = presence[podId];
          const isOnline = p?.online;
          const operator = p?.operator || '';
          const status = p?.status || 'offline';
          const isPaused = status === 'paused';
          const isActive = isOnline && (status === 'scanning' || status === 'ready' || status === 'pair_scanner');
          const onBreak = p?.onBreak;

          let statusLabel = 'AVAILABLE';
          let statusColor = '#22C55E';
          let cardBorder = 'var(--border, #222)';

          if (isActive) {
            statusLabel = operator ? `${operator} scanning` : 'IN USE';
            statusColor = '#3B82F6';
            cardBorder = '#3B82F6';
          } else if (isPaused) {
            statusLabel = onBreak ? 'ON BREAK' : 'PAUSED';
            statusColor = '#EAB308';
            cardBorder = '#EAB308';
          }

          return (
            <button
              key={podId}
              onClick={() => navigate(`/pod?id=${podId}&from=pods`)}
              style={{
                ...styles.podCard,
                borderColor: cardBorder,
              }}
            >
              <div style={styles.podCardHeader}>
                <span style={styles.podName}>Pod {podId}</span>
                <span style={{
                  ...styles.statusBadge,
                  backgroundColor: statusColor,
                }}>
                  {statusLabel}
                </span>
              </div>

              {operator && isOnline && (
                <p style={styles.operatorText}>
                  👤 {operator}
                  {isPaused && ' · ⏸ Paused'}
                  {onBreak && ' · ☕ Break'}
                </p>
              )}

              <div style={styles.tapHint}>
                Tap to open →
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer hint */}
      <p style={styles.footerHint}>
        {assignedPods.length} pod{assignedPods.length !== 1 ? 's' : ''} assigned to this device
        {' · '}
        <button onClick={openSetup} style={styles.reconfigureLink}>
          Reconfigure
        </button>
      </p>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: 'var(--bg, #0f0f0f)',
    color: 'var(--text, #f0f0f0)',
    fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif",
    padding: '24px clamp(16px, 4vw, 40px)',
    maxWidth: 800,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 28,
  },
  heading: {
    fontSize: 'clamp(24px, 5vw, 36px)',
    fontWeight: 800,
    margin: 0,
    letterSpacing: '-0.5px',
  },
  jobInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#86efac',
    fontSize: 14,
    fontWeight: 600,
    margin: '6px 0 0',
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: '#22C55E',
    flexShrink: 0,
    display: 'inline-block',
  },
  gearBtn: {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid var(--border, #333)',
    backgroundColor: 'var(--bg-card, #161616)',
    fontSize: 22,
    cursor: 'pointer',
    lineHeight: 1,
  },

  // Setup mode
  setupCard: {
    backgroundColor: 'var(--bg-card, #161616)',
    border: '1px solid var(--border, #222)',
    borderRadius: 16,
    padding: 'clamp(20px, 4vw, 32px)',
    maxWidth: 600,
    margin: '0 auto',
    width: '100%',
  },
  label: {
    display: 'block',
    color: 'var(--text-secondary, #aaa)',
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 8,
    border: '1px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)',
    color: 'var(--text, #fff)',
    fontSize: 16,
    boxSizing: 'border-box',
    fontWeight: 600,
  },
  hint: {
    color: 'var(--text-secondary, #888)',
    fontSize: 15,
    lineHeight: 1.5,
    marginBottom: 24,
    fontWeight: 500,
  },
  setupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
    gap: 10,
  },
  setupPodBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '18px 12px',
    borderRadius: 12,
    border: '2px solid',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    minHeight: 90,
  },

  // Pod selector grid
  podGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16,
    flex: 1,
  },
  podCard: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--bg-card, #161616)',
    border: '2px solid',
    borderRadius: 16,
    padding: 'clamp(18px, 3vw, 28px)',
    cursor: 'pointer',
    textAlign: 'left',
    color: 'var(--text, #f0f0f0)',
    transition: 'transform 0.1s ease, border-color 0.2s ease',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  },
  podCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  podName: {
    fontSize: 'clamp(28px, 5vw, 40px)',
    fontWeight: 800,
    letterSpacing: '-0.5px',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '5px 14px',
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  operatorText: {
    color: 'var(--text-secondary, #aaa)',
    fontSize: 15,
    margin: '0 0 8px',
    fontWeight: 600,
  },
  tapHint: {
    marginTop: 'auto',
    paddingTop: 12,
    color: 'var(--text-secondary, #555)',
    fontSize: 14,
    fontWeight: 600,
  },

  // Footer
  footerHint: {
    textAlign: 'center',
    color: 'var(--text-secondary, #555)',
    fontSize: 13,
    marginTop: 24,
    fontWeight: 500,
  },
  reconfigureLink: {
    background: 'none',
    border: 'none',
    color: '#3B82F6',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'underline',
    padding: 0,
  },

  // Shared
  primaryBtn: {
    width: '100%',
    padding: '16px 22px',
    borderRadius: 10,
    border: 'none',
    backgroundColor: '#22C55E',
    color: '#fff',
    fontSize: 18,
    fontWeight: 800,
    cursor: 'pointer',
  },
  secondaryBtn: {
    width: '100%',
    padding: '12px 18px',
    borderRadius: 8,
    border: '1px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)',
    color: 'var(--text-secondary, #ccc)',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
  },
};
