import React, { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import {
  collection, query, where, onSnapshot, Timestamp,
} from 'firebase/firestore';

export default function Kiosk() {
  const [job, setJob] = useState(null);
  const [podData, setPodData] = useState({});
  const [presence, setPresence] = useState({});
  const [leaderboard, setLeaderboard] = useState([]);
  const [allScans, setAllScans] = useState([]);
  const [time, setTime] = useState(new Date());
  const containerRef = useRef(null);

  // Clock
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Fullscreen on click
  const goFullscreen = () => {
    try { containerRef.current?.requestFullscreen?.(); } catch {}
  };

  // Load job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const d = snap.docs[0];
        setJob({ id: d.id, ...d.data() });
      } else setJob(null);
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

  // Scans data
  useEffect(() => {
    if (!job) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(
      collection(db, 'scans'),
      where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );
    const unsub = onSnapshot(q, (snap) => {
      const scans = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setAllScans(scans);

      const pods = {};
      const byOperator = {};
      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;

      for (const podId of job.meta.pods || []) {
        const podScans = scans.filter((s) => s.podId === podId);
        const recentScans = podScans.filter((s) => {
          const ts = s.timestamp?.toDate?.();
          return ts && ts.getTime() > fifteenMinAgo;
        });
        const minutes = Math.min(15, (now - today.getTime()) / 60000);
        pods[podId] = {
          count: podScans.length,
          pace: minutes > 0 && recentScans.length > 0 ? Math.round((recentScans.length / Math.min(15, minutes)) * 60) : 0,
        };
      }
      setPodData(pods);

      // Leaderboard: by operator
      for (const s of scans) {
        if (s.scannerId) {
          byOperator[s.scannerId] = (byOperator[s.scannerId] || 0) + 1;
        }
      }
      setLeaderboard(
        Object.entries(byOperator).sort((a, b) => b[1] - a[1]).map(([name, count], i) => ({ name, count, rank: i + 1 }))
      );
    });
    return unsub;
  }, [job]);

  const totalScans = Object.values(podData).reduce((sum, p) => sum + p.count, 0);
  const totalPace = Object.values(podData).reduce((sum, p) => sum + p.pace, 0);
  const dailyTarget = job?.meta?.dailyTarget || 22000;
  const pct = Math.min(100, Math.round((totalScans / dailyTarget) * 100));
  const remaining = Math.max(0, dailyTarget - totalScans);

  // Hourly breakdown
  const hourlyData = (() => {
    const hours = {};
    for (const s of allScans) {
      const d = s.timestamp?.toDate?.();
      if (!d) continue;
      const h = d.getHours();
      hours[h] = (hours[h] || 0) + 1;
    }
    const arr = [];
    for (let h = 6; h <= 22; h++) {
      arr.push({ hour: h, count: hours[h] || 0 });
    }
    return arr;
  })();
  const maxHourly = Math.max(1, ...hourlyData.map((d) => d.count));

  return (
    <div ref={containerRef} style={k.container} onClick={goFullscreen}>
      {/* Top bar */}
      <div style={k.topBar}>
        <div>
          <h1 style={k.jobName}>{job?.meta?.name || 'No Active Job'}</h1>
          <span style={k.modeLabel}>
            {job?.meta?.mode === 'multi' ? 'Multi-PO' : 'Single PO'} · Kiosk View
          </span>
        </div>
        <div style={k.clock}>{time.toLocaleTimeString()}</div>
      </div>

      {/* Big numbers */}
      <div style={k.bigRow}>
        <div style={k.bigStat}>
          <div style={k.bigVal}>{totalScans.toLocaleString()}</div>
          <div style={k.bigLbl}>SCANNED</div>
        </div>
        <div style={k.bigStat}>
          <div style={{ ...k.bigVal, color: '#3B82F6' }}>{pct}%</div>
          <div style={k.bigLbl}>OF TARGET</div>
        </div>
        <div style={k.bigStat}>
          <div style={k.bigVal}>{totalPace}</div>
          <div style={k.bigLbl}>SCANS/HR</div>
        </div>
        <div style={k.bigStat}>
          <div style={k.bigVal}>{remaining.toLocaleString()}</div>
          <div style={k.bigLbl}>REMAINING</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={k.progressContainer}>
        <div style={{ ...k.progressBar, width: `${pct}%` }} />
        <span style={k.progressText}>{pct}%</span>
      </div>

      {/* Pod grid + Leaderboard */}
      <div style={k.mainRow}>
        {/* Pods */}
        <div style={k.section}>
          <h2 style={k.sectionTitle}>Pod Status</h2>
          <div style={k.podGrid}>
            {(job?.meta?.pods || []).map((podId) => {
              const pd = podData[podId] || { count: 0, pace: 0 };
              const pr = presence[podId];
              const isOnline = pr?.online;
              const isPaused = pr?.status === 'paused';
              return (
                <div key={podId} style={{
                  ...k.podCard,
                  borderColor: isPaused ? '#EAB308' : isOnline ? '#22C55E' : '#333',
                }}>
                  <div style={k.podHeader}>
                    <span style={k.podName}>Pod {podId}</span>
                    <span style={{
                      ...k.podStatus,
                      color: isPaused ? '#EAB308' : isOnline ? '#22C55E' : '#666',
                    }}>
                      {isPaused ? '⏸ PAUSED' : isOnline ? '● ONLINE' : '○ OFFLINE'}
                    </span>
                  </div>
                  {pr?.operator && isOnline && <div style={k.podOp}>{pr.operator}</div>}
                  <div style={k.podStats}>
                    <span style={k.podCount}>{pd.count.toLocaleString()}</span>
                    <span style={k.podPace}>{pd.pace}/hr</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Leaderboard */}
        <div style={k.section}>
          <h2 style={k.sectionTitle}>🏆 Leaderboard</h2>
          <div style={k.leaderboard}>
            {leaderboard.slice(0, 10).map((l) => (
              <div key={l.name} style={k.leaderRow}>
                <span style={{
                  ...k.rank,
                  color: l.rank === 1 ? '#EAB308' : l.rank === 2 ? '#9CA3AF' : l.rank === 3 ? '#D97706' : '#666',
                }}>
                  {l.rank <= 3 ? ['🥇', '🥈', '🥉'][l.rank - 1] : `#${l.rank}`}
                </span>
                <span style={k.leaderName}>{l.name}</span>
                <span style={k.leaderCount}>{l.count.toLocaleString()}</span>
              </div>
            ))}
            {leaderboard.length === 0 && <p style={{ color: '#666', textAlign: 'center', padding: 20 }}>No scans yet</p>}
          </div>
        </div>
      </div>

      {/* Hourly chart */}
      <div style={k.section}>
        <h2 style={k.sectionTitle}>Hourly Breakdown</h2>
        <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 80, padding: '0 4px' }}>
          {hourlyData.map((d) => (
            <div key={d.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{
                width: '100%', maxWidth: 36,
                height: `${(d.count / maxHourly) * 100}%`, minHeight: d.count > 0 ? 4 : 1,
                backgroundColor: d.hour === new Date().getHours() ? '#EAB308' : '#3B82F6',
                borderRadius: '3px 3px 0 0',
              }} />
              <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{d.hour}h</div>
            </div>
          ))}
        </div>
      </div>

      <p style={{ textAlign: 'center', color: '#444', fontSize: 12, marginTop: 16 }}>
        Click anywhere to toggle fullscreen · Auto-refreshes in real time
      </p>
    </div>
  );
}

const k = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0a0a0a)', color: 'var(--text, #fff)', fontFamily: 'system-ui,sans-serif', padding: '20px 24px' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  jobName: { fontSize: 'clamp(24px, 3vw, 36px)', fontWeight: 800, margin: 0 },
  modeLabel: { color: 'var(--text-secondary, #666)', fontSize: 14 },
  clock: { fontSize: 'clamp(24px, 3vw, 36px)', fontWeight: 300, color: 'var(--text-secondary, #888)', fontFamily: 'monospace' },
  bigRow: { display: 'flex', gap: 24, justifyContent: 'center', marginBottom: 20, flexWrap: 'wrap' },
  bigStat: { textAlign: 'center', minWidth: 140 },
  bigVal: { fontSize: 'clamp(36px, 6vw, 56px)', fontWeight: 900, lineHeight: 1, color: 'var(--text, #fff)' },
  bigLbl: { fontSize: 13, color: 'var(--text-secondary, #888)', letterSpacing: 2, fontWeight: 600, marginTop: 4 },
  progressContainer: { height: 16, backgroundColor: 'var(--bg-input, #222)', borderRadius: 8, overflow: 'hidden', position: 'relative', marginBottom: 24 },
  progressBar: { height: '100%', backgroundColor: '#22C55E', borderRadius: 8, transition: 'width 0.5s ease' },
  progressText: { position: 'absolute', right: 8, top: 0, fontSize: 11, fontWeight: 700, lineHeight: '16px', color: '#fff' },
  mainRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginBottom: 20 },
  section: { backgroundColor: 'var(--bg-card, #111)', borderRadius: 12, padding: 16, border: '1px solid var(--border, #222)' },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: 'var(--text-secondary, #aaa)', margin: '0 0 12px', letterSpacing: 1 },
  podGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 },
  podCard: { backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 8, padding: 12, border: '2px solid var(--border, #333)' },
  podHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  podName: { fontSize: 18, fontWeight: 800 },
  podStatus: { fontSize: 11, fontWeight: 700 },
  podOp: { fontSize: 12, color: '#888', marginBottom: 6 },
  podStats: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  podCount: { fontSize: 24, fontWeight: 800 },
  podPace: { fontSize: 13, color: 'var(--text-secondary, #888)' },
  leaderboard: { maxHeight: 300, overflowY: 'auto' },
  leaderRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border, #222)' },
  rank: { fontSize: 18, width: 36, textAlign: 'center', fontWeight: 700 },
  leaderName: { flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text-secondary, #ddd)' },
  leaderCount: { fontSize: 16, fontWeight: 800, color: 'var(--text, #fff)', fontFamily: 'monospace' },
};
