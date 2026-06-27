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
import { Settings, LayoutDashboard, MonitorPlay, History, Receipt, TrendingUp, Package, Download, Pause, Boxes, Layers, Printer, PlayCircle } from 'lucide-react';

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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, marginTop: 120 }}>
          <div className="spinner spinner-lg" />
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13, fontFamily: 'var(--font-display)', letterSpacing: '0.05em' }}>Loading…</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container} className="page-enter">
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
            <span style={{ color: 'var(--text-tertiary, #666)', fontSize: 13 }}>({currentUser.role})</span>
            <button onClick={logout} style={styles.signOutBtn}>Sign Out</button>
          </div>
        )}
      </div>

      {/* PWA Install */}
      {canInstall && (
        <button onClick={handleInstall} style={styles.installBtn}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Download size={16} /> Install App</span>
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
      <nav className="home-nav stagger" style={styles.nav}>
        <Link to="/setup" style={styles.navLink}>
          <Settings size={22} />
          <span>Setup</span>
        </Link>
        <Link to="/dashboard" style={styles.navLink}>
          <LayoutDashboard size={22} />
          <span>Dashboard</span>
        </Link>
        <Link to="/kiosk" style={styles.navLink}>
          <MonitorPlay size={22} />
          <span>Kiosk</span>
        </Link>
        <Link to="/history" style={styles.navLink}>
          <History size={22} />
          <span>History</span>
        </Link>
        <Link to="/billing" style={styles.navLink}>
          <Receipt size={22} />
          <span>Billing</span>
        </Link>
        <Link to="/reports" style={styles.navLink}>
          <TrendingUp size={22} />
          <span>Reports</span>
        </Link>
        <Link to="/portal" style={styles.navLink}>
          <Package size={22} />
          <span>Portal</span>
        </Link>
        <Link to="/pack" style={styles.navLink}>
          <Boxes size={22} />
          <span>Pack</span>
        </Link>
        <Link to="/pallet" style={styles.navLink}>
          <Layers size={22} />
          <span>Pallet</span>
        </Link>
        <Link to="/print-station" style={styles.navLink}>
          <Printer size={22} />
          <span>Print Station</span>
        </Link>
        <Link to="/demo" style={styles.navLink}>
          <PlayCircle size={22} />
          <span>Demo</span>
        </Link>
      </nav>

      {/* Pod Grid */}
      <h2 style={styles.sectionTitle}>Pod Stations</h2>
      <p style={styles.sectionHint}>
        Open the link for your pod on its laptop. Scanner connects automatically via USB.
      </p>

      <div className="home-podgrid stagger" style={styles.podGrid}>
        {pods.map((podId) => {
          const p = presence[podId];
          const isOnline = p?.online;
          const scanners = p?.scanners || [];
          const operator = p?.operator || '';
          const status = p?.status || 'offline';
          const isPaused = status === 'paused';
          const isActive = isOnline && (status === 'scanning' || status === 'ready' || status === 'pair_scanner');

          const statusLabel = isPaused ? 'PAUSED' : isActive ? 'ONLINE' : 'OFFLINE';
          const statusColor = isPaused ? 'var(--warning)' : isActive ? 'var(--success)' : 'var(--border-strong)';
          const statusTextColor = isPaused ? '#0e1118' : isActive ? '#0e1118' : 'var(--text-secondary)';

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
                  Operator: <strong style={{ color: 'var(--text)' }}>{operator}</strong>
                  {isPaused && <span style={{ color: 'var(--warning)', marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Pause size={11} /> Paused</span>}
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
    fontFamily: 'var(--font-sans)',
    padding: '0 clamp(16px, 2.5vw, 36px) 40px',
    width: '100%',
    boxSizing: 'border-box',
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
    padding: '6px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
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
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--accent)',
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'center',
  },
  jobBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'var(--success-soft)',
    border: '1px solid var(--success)',
    borderRadius: 'var(--radius-md)',
    padding: '14px 20px',
    marginBottom: 20,
  },
  jobDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: 'var(--success)',
    flexShrink: 0,
  },
  jobText: {
    fontSize: 14,
    color: 'var(--text)',
  },
  noJobBanner: {
    backgroundColor: 'var(--warning-soft)',
    border: '1px solid var(--warning)',
    borderRadius: 'var(--radius-md)',
    padding: '14px 20px',
    marginBottom: 20,
  },
  noJobText: {
    fontSize: 14,
    color: 'var(--text)',
  },
  link: {
    color: 'var(--accent)',
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
    borderRadius: 'var(--radius-md)',
    background: 'linear-gradient(180deg, var(--bg-elev), var(--bg-card))',
    border: '1px solid var(--border, #222)',
    boxShadow: 'var(--shadow-xs)',
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
    background: 'linear-gradient(180deg, var(--bg-elev), var(--bg-card))',
    border: '1px solid var(--border, #222)',
    borderRadius: 'var(--radius-lg)',
    padding: '18px 20px',
    textDecoration: 'none',
    color: 'var(--text, #f0f0f0)',
    boxShadow: 'var(--shadow-card)',
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
  scannerDotGreen: { width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--success)', flexShrink: 0 },
  scannerDotYellow: { width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--warning)', flexShrink: 0 },
  scannerDotGray: { width: 7, height: 7, borderRadius: '50%', backgroundColor: 'var(--border-strong)', flexShrink: 0 },
  scannerName: { fontSize: 13, color: 'var(--text-secondary, #bbb)', fontWeight: 600 },
  scannerLinked: { fontSize: 11, color: 'var(--success)', fontWeight: 600, marginLeft: 'auto' },
  scannerPending: { fontSize: 12, color: 'var(--warning)' },
  scannerOffline: { fontSize: 12, color: 'var(--text-tertiary)' },
  urlHint: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    marginTop: 8,
  },
  instructions: {
    background: 'linear-gradient(180deg, var(--bg-elev), var(--bg-card))',
    border: '1px solid var(--border, #222)',
    borderRadius: 'var(--radius-lg)',
    padding: '20px 24px',
    boxShadow: 'var(--shadow-card)',
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
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-contrast)',
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
