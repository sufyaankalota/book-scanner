import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, getDocs, query, where, onSnapshot, Timestamp,
} from 'firebase/firestore';
import PodCard from '../components/PodCard';
import {
  exportTodayXLSX, exportAllXLSX, exportPerPO, downloadBlob,
} from '../utils/export';

export default function Dashboard() {
  const [job, setJob] = useState(null);
  const [podData, setPodData] = useState({});
  const [presence, setPresence] = useState({});
  const [operatorStats, setOperatorStats] = useState({});
  const [allScans, setAllScans] = useState([]);
  const [allExceptions, setAllExceptions] = useState([]);
  const [showExceptions, setShowExceptions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Load active job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
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

  // Listen to presence
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

  // Listen to today's scans
  useEffect(() => {
    if (!job) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const q = query(
      collection(db, 'scans'),
      where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );

    const unsub = onSnapshot(q, (snap) => {
      const scans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllScans(scans);

      const pods = {};
      const opStats = {};
      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;

      for (const podId of job.meta.pods || []) {
        const podScans = scans.filter((s) => s.podId === podId);
        const recentScans = podScans.filter((s) => {
          const ts = s.timestamp?.toDate?.();
          return ts && ts.getTime() > fifteenMinAgo;
        });

        const scanners = [...new Set(podScans.map((s) => s.scannerId).filter(Boolean))];
        const minutes = Math.min(15, (now - today.getTime()) / 60000);
        const pace = minutes > 0 && recentScans.length > 0
          ? Math.round((recentScans.length / Math.min(15, minutes)) * 60)
          : 0;

        const targetPerHour = Math.round(
          (job.meta.dailyTarget || 22000) / (job.meta.workingHours || 8) / (job.meta.pods?.length || 5)
        );

        pods[podId] = {
          id: podId,
          scanCount: podScans.length,
          exceptionCount: podScans.filter((s) => s.type === 'exception').length,
          pace,
          targetPerHour,
          scanners,
        };

        // Per-operator breakdown
        const byOp = {};
        for (const s of podScans) {
          if (s.scannerId) {
            byOp[s.scannerId] = (byOp[s.scannerId] || 0) + 1;
          }
        }
        opStats[podId] = byOp;
      }
      setPodData(pods);
      setOperatorStats(opStats);
    });
    return unsub;
  }, [job]);

  // Listen to today's manual exceptions
  useEffect(() => {
    if (!job) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const q = query(
      collection(db, 'exceptions'),
      where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );

    const unsub = onSnapshot(q, (snap) => {
      setAllExceptions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [job]);

  // Totals
  const totalScans = Object.values(podData).reduce((sum, p) => sum + p.scanCount, 0);
  const totalAutoExceptions = Object.values(podData).reduce((sum, p) => sum + p.exceptionCount, 0);
  const totalExceptions = totalAutoExceptions + allExceptions.length;
  const totalPace = Object.values(podData).reduce((sum, p) => sum + p.pace, 0);
  const dailyTarget = job?.meta?.dailyTarget || 22000;
  const remaining = Math.max(0, dailyTarget - totalScans);
  const estHoursLeft = totalPace > 0 ? (remaining / totalPace).toFixed(1) : '—';

  const handleExportToday = async () => {
    if (!job) return;
    setExporting(true);
    try {
      exportTodayXLSX(allScans, allExceptions, job.meta);
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
    setExporting(false);
  };

  const handleExportAll = async () => {
    if (!job) return;
    setExporting(true);
    try {
      const scanSnap = await getDocs(
        query(collection(db, 'scans'), where('jobId', '==', job.id))
      );
      const scans = scanSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const excSnap = await getDocs(
        query(collection(db, 'exceptions'), where('jobId', '==', job.id))
      );
      const excs = excSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      exportAllXLSX(scans, excs, job.meta);

      if (job.meta.mode === 'multi') {
        const files = exportPerPO(scans, job.meta);
        for (const f of files) {
          downloadBlob(f.data, f.name);
        }
      }
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
    setExporting(false);
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <p style={styles.text}>Loading...</p>
      </div>
    );
  }

  if (!job) {
    return (
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
        <h1 style={styles.title}>Dashboard</h1>
        <p style={styles.text}>
          No active job. <Link to="/setup" style={{ color: '#3B82F6' }}>Go to Setup</Link>
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <Link to="/" style={styles.backLink}>← Back to Home</Link>

      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>{job.meta.name}</h1>
          <p style={styles.subtitle}>
            {job.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} · Target:{' '}
            {dailyTarget.toLocaleString()}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={handleExportToday} disabled={exporting} style={{ ...styles.exportBtn, opacity: exporting ? 0.5 : 1 }}>
            {exporting ? '...' : 'Export Today'}
          </button>
          <button onClick={handleExportAll} disabled={exporting} style={{ ...styles.exportBtn, opacity: exporting ? 0.5 : 1 }}>
            {exporting ? '...' : 'Export All'}
          </button>
          <Link to="/setup" style={styles.setupLink}>Setup</Link>
        </div>
      </div>

      {/* Summary bar */}
      <div style={styles.summaryRow}>
        <div style={styles.summaryItem}>
          <div style={styles.summaryValue}>{totalScans.toLocaleString()}</div>
          <div style={styles.summaryLabel}>Scanned / {dailyTarget.toLocaleString()}</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={{ ...styles.summaryValue, color: totalExceptions > 0 ? '#F97316' : '#888' }}>
            {totalExceptions}
          </div>
          <div style={styles.summaryLabel}>Total Exceptions</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={styles.summaryValue}>{totalPace}</div>
          <div style={styles.summaryLabel}>Combined Scans/hr</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={styles.summaryValue}>{estHoursLeft}</div>
          <div style={styles.summaryLabel}>Est. Hours Left</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={styles.progressContainer}>
        <div style={{ ...styles.progressBar, width: `${Math.min(100, (totalScans / dailyTarget) * 100)}%` }} />
      </div>

      {/* Pod grid */}
      <div style={styles.podGrid}>
        {(job.meta.pods || []).map((podId) => (
          <PodCard
            key={podId}
            pod={podData[podId] || { id: podId, scanCount: 0, exceptionCount: 0, pace: 0, targetPerHour: 0, scanners: [] }}
            presence={presence[podId]}
            operatorStats={operatorStats[podId]}
          />
        ))}
      </div>

      {/* Exceptions panel */}
      <div style={styles.exceptionsSection}>
        <button
          onClick={() => setShowExceptions(!showExceptions)}
          style={styles.exceptionsToggle}
        >
          {showExceptions ? 'Hide' : 'View'} Exceptions ({totalExceptions})
        </button>

        {showExceptions && (
          <div style={styles.exceptionsPanel}>
            {allScans
              .filter((s) => s.type === 'exception')
              .map((s) => (
                <div key={s.id} style={styles.exceptionRow}>
                  <span style={styles.exTag}>NOT IN MANIFEST</span>
                  <span style={styles.exDetail}>
                    ISBN: {s.isbn} · Pod {s.podId} · {s.scannerId}
                  </span>
                  <span style={styles.exTime}>
                    {s.timestamp?.toDate?.()?.toLocaleTimeString() || '—'}
                  </span>
                </div>
              ))}
            {allExceptions.map((ex) => (
              <div key={ex.id} style={styles.exceptionRow}>
                <span style={styles.exTag}>{ex.reason}</span>
                <span style={styles.exDetail}>
                  {ex.isbn ? `ISBN: ${ex.isbn}` : ''}{ex.title ? ` "${ex.title}"` : ''} · Pod {ex.podId} · {ex.scannerId}
                </span>
                <span style={styles.exTime}>
                  {ex.timestamp?.toDate?.()?.toLocaleTimeString() || '—'}
                </span>
              </div>
            ))}
            {totalExceptions === 0 && (
              <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>
                No exceptions today
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh', backgroundColor: '#111', color: '#fff',
    padding: '16px 12px', fontFamily: 'system-ui, sans-serif',
    maxWidth: 1200, margin: '0 auto',
  },
  backLink: { color: '#666', textDecoration: 'none', fontSize: 14, marginBottom: 8, display: 'inline-block' },
  headerRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    flexWrap: 'wrap', gap: 16, marginBottom: 24,
  },
  title: { fontSize: 'clamp(24px, 4vw, 32px)', fontWeight: 800, margin: 0 },
  subtitle: { fontSize: 16, color: '#888', marginTop: 4 },
  text: { color: '#ddd', fontSize: 16 },
  exportBtn: {
    padding: '10px 20px', borderRadius: 8, border: '1px solid #444',
    backgroundColor: '#222', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  setupLink: {
    padding: '10px 20px', borderRadius: 8, backgroundColor: '#333',
    color: '#aaa', fontSize: 14, fontWeight: 600, textDecoration: 'none',
    display: 'flex', alignItems: 'center',
  },
  summaryRow: {
    display: 'flex', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 16,
  },
  summaryItem: { textAlign: 'center', flex: 1, minWidth: 100 },
  summaryValue: { fontSize: 'clamp(28px, 5vw, 40px)', fontWeight: 800, color: '#fff', lineHeight: 1 },
  summaryLabel: { fontSize: 'clamp(11px, 1.5vw, 13px)', color: '#888', marginTop: 4 },
  progressContainer: {
    height: 8, backgroundColor: '#333', borderRadius: 4, overflow: 'hidden', marginBottom: 24,
  },
  progressBar: {
    height: '100%', backgroundColor: '#22C55E', borderRadius: 4, transition: 'width 0.5s ease',
  },
  podGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16, marginBottom: 32,
  },
  exceptionsSection: { marginTop: 16 },
  exceptionsToggle: {
    padding: '10px 20px', borderRadius: 8, border: '1px solid #F97316',
    backgroundColor: 'transparent', color: '#F97316', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  exceptionsPanel: {
    marginTop: 12, backgroundColor: '#1a1a1a', borderRadius: 12,
    border: '1px solid #333', maxHeight: 400, overflowY: 'auto',
  },
  exceptionRow: {
    display: 'flex', gap: 12, alignItems: 'center',
    padding: '10px 16px', borderBottom: '1px solid #222', flexWrap: 'wrap',
  },
  exTag: {
    padding: '2px 8px', borderRadius: 4, backgroundColor: '#7f1d1d',
    color: '#fca5a5', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
  },
  exDetail: { fontSize: 14, color: '#ccc', flex: 1, minWidth: 0 },
  exTime: { fontSize: 12, color: '#666', whiteSpace: 'nowrap' },
};
