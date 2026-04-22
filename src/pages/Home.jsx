import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';

export default function Home() {
  const [job, setJob] = useState(null);
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);

  // Load active job
  useEffect(() => {
    const q = query(
      collection(db, 'jobs'),
      where('meta.active', '==', true)
    );
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const d = snap.docs[0];
        setJob({ id: d.id, ...d.data() });
      } else {
        setJob(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  // Listen to pod presence
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'presence'), (snap) => {
      const data = {};
      snap.forEach((d) => {
        const p = d.data();
        // Consider online if lastSeen within 60 seconds
        const lastSeen = p.lastSeen?.toDate?.();
        const isRecent = lastSeen && Date.now() - lastSeen.getTime() < 60000;
        data[d.id] = { ...p, online: p.online && isRecent };
      });
      setPresence(data);
    });
    return unsub;
  }, []);

  const pods = job?.meta?.pods || ['A', 'B', 'C', 'D', 'E'];

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loader}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>📦 Book Scanner</h1>
        <p style={styles.subtitle}>Warehouse Scanning System</p>
      </div>

      {/* Job status banner */}
      {job ? (
        <div style={styles.jobBanner}>
          <div style={styles.jobDot} />
          <span style={styles.jobText}>
            Active Job: <strong>{job.meta.name}</strong> ·{' '}
            {job.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} ·
            Target: {job.meta.dailyTarget?.toLocaleString()}
          </span>
        </div>
      ) : (
        <div style={styles.noJobBanner}>
          <span style={styles.noJobText}>
            No active job.{' '}
            <Link to="/setup" style={styles.link}>
              Create one in Setup →
            </Link>
          </span>
        </div>
      )}

      {/* Quick Links */}
      <div style={styles.quickLinks}>
        <Link to="/setup" style={styles.quickLink}>
          ⚙️ Setup
        </Link>
        <Link to="/dashboard" style={styles.quickLink}>
          📊 Dashboard
        </Link>
      </div>

      {/* Pod Grid */}
      <h2 style={styles.sectionTitle}>Pod Stations</h2>
      <p style={styles.sectionHint}>
        Open the link for your pod on its laptop. Scanner connects automatically via USB.
      </p>

      <div style={styles.podGrid}>
        {pods.map((podId) => {
          const p = presence[podId];
          const isOnline = p?.online;
          const scanners = p?.scanners || [];
          const operator = p?.operator || '';
          const status = p?.status || 'offline';
          const isPaused = status === 'paused';
          const isActive = isOnline && (status === 'scanning' || status === 'ready' || status === 'pair_scanner');

          const statusLabel = isPaused ? 'PAUSED' : isActive ? 'ONLINE' : 'OFFLINE';
          const statusColor = isPaused ? '#EAB308' : isActive ? '#22C55E' : '#555';
          const statusTextColor = isPaused ? '#fff' : isActive ? '#fff' : '#999';

          return (
            <Link
              key={podId}
              to={`/pod?id=${podId}`}
              style={styles.podCard}
            >
              {/* Status indicator */}
              <div style={styles.podHeader}>
                <h3 style={styles.podName}>Pod {podId}</h3>
                <div
                  style={{
                    ...styles.statusBadge,
                    backgroundColor: statusColor,
                    color: statusTextColor,
                  }}
                >
                  <div
                    style={{
                      ...styles.statusDot,
                      backgroundColor: isPaused ? '#fff' : isActive ? '#fff' : '#777',
                    }}
                  />
                  {statusLabel}
                </div>
              </div>

              {/* Operator */}
              {operator && isOnline && (
                <p style={{ color: '#aaa', fontSize: 13, margin: '0 0 8px' }}>
                  Operator: <strong style={{ color: '#fff' }}>{operator}</strong>
                  {isPaused && <span style={{ color: '#EAB308', marginLeft: 8 }}>⏸ Paused</span>}
                </p>
              )}

              {/* Scanner status */}
              <div style={styles.scannerSection}>
                {isOnline && scanners.length > 0 ? (
                  scanners.map((name, i) => (
                    <div key={i} style={styles.scannerRow}>
                      <div style={styles.scannerDotGreen} />
                      <span style={styles.scannerName}>{name}</span>
                      <span style={styles.scannerLinked}>Paired ✓</span>
                    </div>
                  ))
                ) : isOnline ? (
                  <div style={styles.scannerRow}>
                    <div style={styles.scannerDotYellow} />
                    <span style={styles.scannerPending}>
                      Setting up scanner...
                    </span>
                  </div>
                ) : (
                  <div style={styles.scannerRow}>
                    <div style={styles.scannerDotGray} />
                    <span style={styles.scannerOffline}>
                      Not connected
                    </span>
                  </div>
                )}
              </div>

              {/* URL hint */}
              <div style={styles.urlHint}>
                /pod?id={podId}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Setup Instructions */}
      <div style={styles.instructions}>
        <h3 style={styles.instructionsTitle}>Quick Start</h3>
        <div style={styles.steps}>
          <div style={styles.step}>
            <div style={styles.stepNum}>1</div>
            <div>
              <div style={styles.stepTitle}>Create a Job</div>
              <div style={styles.stepText}>
                Go to Setup, name your PO, choose Single or Multi-PO mode
              </div>
            </div>
          </div>
          <div style={styles.step}>
            <div style={styles.stepNum}>2</div>
            <div>
              <div style={styles.stepTitle}>Open Pod Pages</div>
              <div style={styles.stepText}>
                On each laptop, click its pod card above or bookmark the URL
              </div>
            </div>
          </div>
          <div style={styles.step}>
            <div style={styles.stepNum}>3</div>
            <div>
              <div style={styles.stepTitle}>Plug In Scanners</div>
              <div style={styles.stepText}>
                Connect TERA ring scanners via USB — they work as keyboards, no drivers needed
              </div>
            </div>
          </div>
          <div style={styles.step}>
            <div style={styles.stepNum}>4</div>
            <div>
              <div style={styles.stepTitle}>Start Scanning</div>
              <div style={styles.stepText}>
                Enter operator name, hit Start. Status turns green here when linked.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#111',
    color: '#fff',
    fontFamily: 'system-ui, sans-serif',
    padding: '32px 24px',
    maxWidth: 1200,
    margin: '0 auto',
  },
  loader: {
    color: '#888',
    fontSize: 18,
    textAlign: 'center',
    marginTop: 100,
  },
  header: {
    textAlign: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 42,
    fontWeight: 800,
    margin: 0,
  },
  subtitle: {
    fontSize: 18,
    color: '#888',
    marginTop: 4,
  },
  jobBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#14532d',
    border: '1px solid #22C55E',
    borderRadius: 10,
    padding: '12px 20px',
    marginBottom: 24,
  },
  jobDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    backgroundColor: '#22C55E',
    flexShrink: 0,
  },
  jobText: {
    fontSize: 16,
    color: '#bbf7d0',
  },
  noJobBanner: {
    backgroundColor: '#7f1d1d',
    border: '1px solid #EF4444',
    borderRadius: 10,
    padding: '12px 20px',
    marginBottom: 24,
  },
  noJobText: {
    fontSize: 16,
    color: '#fca5a5',
  },
  link: {
    color: '#93c5fd',
    textDecoration: 'underline',
  },
  quickLinks: {
    display: 'flex',
    gap: 12,
    marginBottom: 32,
  },
  quickLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 20px',
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    border: '1px solid #333',
    color: '#ddd',
    fontSize: 16,
    fontWeight: 600,
    textDecoration: 'none',
  },
  sectionTitle: {
    fontSize: 24,
    fontWeight: 700,
    marginBottom: 4,
  },
  sectionHint: {
    fontSize: 14,
    color: '#888',
    marginBottom: 16,
  },
  podGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16,
    marginBottom: 40,
  },
  podCard: {
    display: 'block',
    backgroundColor: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 12,
    padding: 20,
    textDecoration: 'none',
    color: '#fff',
    transition: 'border-color 0.2s, transform 0.2s',
  },
  podHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  podName: {
    fontSize: 28,
    fontWeight: 800,
    margin: 0,
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 12px',
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  scannerSection: {
    marginBottom: 12,
  },
  scannerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  scannerDotGreen: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: '#22C55E',
    flexShrink: 0,
  },
  scannerDotYellow: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: '#EAB308',
    flexShrink: 0,
  },
  scannerDotGray: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: '#555',
    flexShrink: 0,
  },
  scannerName: {
    fontSize: 14,
    color: '#ccc',
    fontWeight: 600,
  },
  scannerLinked: {
    fontSize: 12,
    color: '#22C55E',
    fontWeight: 600,
    marginLeft: 'auto',
  },
  scannerPending: {
    fontSize: 13,
    color: '#EAB308',
  },
  scannerOffline: {
    fontSize: 13,
    color: '#666',
  },
  urlHint: {
    fontSize: 12,
    color: '#555',
    fontFamily: 'monospace',
    marginTop: 8,
  },
  instructions: {
    backgroundColor: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 12,
    padding: 24,
  },
  instructionsTitle: {
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 16,
  },
  steps: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 16,
  },
  step: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
  },
  stepNum: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    backgroundColor: '#3B82F6',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    fontWeight: 700,
    flexShrink: 0,
  },
  stepTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: '#fff',
    marginBottom: 2,
  },
  stepText: {
    fontSize: 13,
    color: '#999',
    lineHeight: 1.4,
  },
};
