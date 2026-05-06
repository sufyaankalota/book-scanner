import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, getDoc,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import TodayLeaderboard from '../components/TodayLeaderboard';
import { computeDailyTarget } from '../utils/target';

export default function Home() {
  const { currentUser, logout } = useAuth();
  const [job, setJob] = useState(null);
  const [presenceRaw, setPresenceRaw] = useState({});
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);
  const [branding, setBranding] = useState({ name: '', subtitle: '' });
  const [canInstall, setCanInstall] = useState(false);

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
      snap.forEach((d) => { data[d.id] = d.data(); });
      setPresenceRaw(data);
    });
    return unsub;
  }, []);

  // Re-evaluate online status every 10 seconds
  useEffect(() => {
    const evaluate = () => {
      const evaluated = {};
      for (const [id, p] of Object.entries(presenceRaw)) {
        const lastSeen = p.lastSeen?.toDate?.();
        const isRecent = lastSeen && Date.now() - lastSeen.getTime() < 90000;
        evaluated[id] = { ...p, online: p.online && isRecent };
      }
      setPresence(evaluated);
    };
    evaluate();
    const interval = setInterval(evaluate, 10000);
    return () => clearInterval(interval);
  }, [presenceRaw]);

  // Load branding
  useEffect(() => {
    getDoc(doc(db, 'config', 'branding')).then((snap) => {
      if (snap.exists()) setBranding(snap.data());
    }).catch(() => {});
  }, []);

  // PWA install prompt
  useEffect(() => {
    const check = () => setCanInstall(!!window.__pwaInstallPrompt);
    check();
    window.addEventListener('appinstalled', () => setCanInstall(false));
    const t = setTimeout(check, 2000);
    return () => clearTimeout(t);
  }, []);

  const handleInstall = async () => {
    const prompt = window.__pwaInstallPrompt;
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    window.__pwaInstallPrompt = null;
    setCanInstall(false);
  };

  const pods = job?.meta?.pods || ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loader}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={branding.logo || '/icon.svg'} alt="Logo" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'contain' }} />
          <div>
            <h1 style={styles.title}>{branding.name || 'BookFlow'}</h1>
            <p style={styles.subtitle}>{branding.subtitle || 'by PrepFort'}</p>
          </div>
        </div>
        {currentUser && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--text-tertiary, #666)', fontSize: 13 }}>{currentUser.name}</span>
            <span style={{ color: '#444', fontSize: 13 }}>({currentUser.role})</span>
            <button onClick={logout} style={styles.signOutBtn}>Sign Out</button>
          </div>
        )}
      </div>

      {/* PWA Install */}
      {canInstall && (
        <button onClick={handleInstall} style={styles.installBtn}>
          📲 Install App
        </button>
      )}

      {/* Job status banner */}
      {job ? (
        <div style={styles.jobBanner}>
          <div style={styles.jobDot} />
          <span style={styles.jobText}>
            Active Job: <strong>{job.meta.name}</strong> ·{' '}
            {job.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} ·
            Target: {computeDailyTarget(job).toLocaleString()}
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

      {/* Today's leaderboard — visible on the home/landing page */}
      {job && <TodayLeaderboard job={job} compact />}

      {/* Navigation */}
      <nav style={styles.nav}>
        <Link to="/setup" style={styles.navLink}>
          <span style={styles.navIcon}>⚙️</span>
          <span>Setup</span>
        </Link>
        <Link to="/dashboard" style={styles.navLink}>
          <span style={styles.navIcon}>📊</span>
          <span>Dashboard</span>
        </Link>
        <Link to="/kiosk" style={styles.navLink}>
          <span style={styles.navIcon}>📺</span>
          <span>Kiosk</span>
        </Link>
        <Link to="/history" style={styles.navLink}>
          <span style={styles.navIcon}>📁</span>
          <span>History</span>
        </Link>
        <Link to="/billing" style={styles.navLink}>
          <span style={styles.navIcon}>💰</span>
          <span>Billing</span>
        </Link>
        <Link to="/portal" style={styles.navLink}>
          <span style={styles.navIcon}>📦</span>
          <span>Portal</span>
        </Link>
      </nav>

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
                <p style={{ color: 'var(--text-secondary, #aaa)', fontSize: 13, margin: '0 0 8px' }}>
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
    backgroundColor: 'var(--bg, #0f0f0f)',
    color: 'var(--text, #f0f0f0)',
    fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif",
    padding: '0 24px 40px',
    maxWidth: 1100,
    margin: '0 auto',
  },
  topBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 0',
    borderBottom: '1px solid var(--border, #1e1e1e)',
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: 800,
    margin: 0,
    letterSpacing: '-0.3px',
  },
  subtitle: {
    fontSize: 12,
    color: 'var(--text-secondary, #666)',
    margin: 0,
    lineHeight: 1,
  },
  signOutBtn: {
    padding: '6px 14px', borderRadius: 6, border: '1px solid #2a2a2a',
    backgroundColor: 'transparent', color: '#777', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },

  loader: {
    color: 'var(--text-tertiary, #666)',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 100,
  },
  installBtn: {
    display: 'block',
    margin: '0 auto 20px',
    padding: '10px 24px',
    borderRadius: 8,
    border: '1px solid #1e40af',
    backgroundColor: 'rgba(59,130,246,0.08)',
    color: '#93c5fd',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'center',
  },
  jobBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(34,197,94,0.06)',
    border: '1px solid rgba(34,197,94,0.2)',
    borderRadius: 10,
    padding: '14px 20px',
    marginBottom: 20,
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: '#22C55E',
    flexShrink: 0,
  },
  jobText: {
    fontSize: 14,
    color: '#86efac',
  },
  noJobBanner: {
    backgroundColor: 'rgba(239,68,68,0.06)',
    border: '1px solid rgba(239,68,68,0.2)',
    borderRadius: 10,
    padding: '14px 20px',
    marginBottom: 20,
  },
  noJobText: {
    fontSize: 14,
    color: '#fca5a5',
  },
  link: {
    color: '#93c5fd',
    textDecoration: 'underline',
  },
  nav: {
    display: 'flex',
    gap: 6,
    marginBottom: 28,
    overflowX: 'auto',
    paddingBottom: 4,
  },
  navLink: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '12px 20px',
    borderRadius: 10,
    backgroundColor: 'var(--bg-card, #161616)',
    border: '1px solid var(--border, #222)',
    color: 'var(--text-secondary, #aaa)',
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'none',
    minWidth: 80,
    textAlign: 'center',
    flexShrink: 0,
  },
  navIcon: {
    fontSize: 20,
    lineHeight: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 4,
    letterSpacing: '-0.2px',
  },
  sectionHint: {
    fontSize: 13,
    color: 'var(--text-secondary, #666)',
    marginBottom: 16,
  },
  podGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 12,
    marginBottom: 32,
  },
  podCard: {
    display: 'block',
    backgroundColor: 'var(--bg-card, #161616)',
    border: '1px solid var(--border, #222)',
    borderRadius: 12,
    padding: '18px 20px',
    textDecoration: 'none',
    color: 'var(--text, #f0f0f0)',
    transition: 'border-color 0.2s, background-color 0.2s',
  },
  podHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  podName: {
    fontSize: 22,
    fontWeight: 800,
    margin: 0,
    letterSpacing: '-0.3px',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
  },
  scannerSection: {
    marginBottom: 10,
  },
  scannerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  scannerDotGreen: { width: 7, height: 7, borderRadius: '50%', backgroundColor: '#22C55E', flexShrink: 0 },
  scannerDotYellow: { width: 7, height: 7, borderRadius: '50%', backgroundColor: '#EAB308', flexShrink: 0 },
  scannerDotGray: { width: 7, height: 7, borderRadius: '50%', backgroundColor: '#444', flexShrink: 0 },
  scannerName: { fontSize: 13, color: 'var(--text-secondary, #bbb)', fontWeight: 600 },
  scannerLinked: { fontSize: 11, color: '#22C55E', fontWeight: 600, marginLeft: 'auto' },
  scannerPending: { fontSize: 12, color: '#EAB308' },
  scannerOffline: { fontSize: 12, color: '#555' },
  urlHint: {
    fontSize: 11,
    color: '#444',
    fontFamily: 'monospace',
    marginTop: 8,
  },
  instructions: {
    backgroundColor: 'var(--bg-card, #161616)',
    border: '1px solid var(--border, #222)',
    borderRadius: 12,
    padding: '20px 24px',
  },
  instructionsTitle: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 16,
    color: 'var(--text-secondary, #aaa)',
  },
  steps: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 16,
  },
  step: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    backgroundColor: '#3B82F6',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    flexShrink: 0,
  },
  stepTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text, #f0f0f0)',
    marginBottom: 2,
  },
  stepText: {
    fontSize: 12,
    color: 'var(--text-secondary, #888)',
    lineHeight: 1.4,
  },
};
