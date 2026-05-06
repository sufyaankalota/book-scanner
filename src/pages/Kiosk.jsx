import React, { useState, useEffect, useRef, useMemo } from 'react';
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
        const isRecent = lastSeen && (Date.now() - lastSeen.getTime() < 90000);
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

  // Countdown timer
  const estHoursLeft = totalPace > 0 ? remaining / totalPace : null;
  const etaTime = estHoursLeft != null ? new Date(Date.now() + estHoursLeft * 3600000) : null;
  const countdownColor = estHoursLeft == null ? 'var(--text-tertiary, #666)'
    : estHoursLeft <= (job?.meta?.workingHours || 8) ? '#22C55E'
    : estHoursLeft <= (job?.meta?.workingHours || 8) * 1.2 ? '#EAB308'
    : '#EF4444';
  const countdownLabel = estHoursLeft == null ? '—'
    : estHoursLeft < 1 ? `${Math.round(estHoursLeft * 60)}m`
    : `${estHoursLeft.toFixed(1)}h`;

  // Hourly breakdown
  const hourlyData = useMemo(() => {
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
  }, [allScans]);
  const maxHourly = Math.max(1, ...hourlyData.map((d) => d.count));

  // ─── Motivational headline (changes based on pace vs target) ───
  // Goal: visible from 30+ feet, give the crew a pulse on whether they're
  // crushing it or need to push.
  const motivational = useMemo(() => {
    if (totalScans === 0) return { msg: 'LET\u2019S GO TEAM \ud83d\ude80', color: '#3B82F6' };
    if (pct >= 100) return { msg: '\ud83c\udfaf TARGET HIT \u2014 LEGENDARY!', color: '#A855F7' };
    if (pct >= 90)  return { msg: '\ud83d\udd25 ALMOST THERE \u2014 PUSH!', color: '#F59E0B' };
    if (pct >= 75)  return { msg: '\ud83d\udcaa CRUSHING IT', color: '#22C55E' };
    if (pct >= 50)  return { msg: '\ud83d\ude80 HALFWAY \u2014 KEEP GOING', color: '#22C55E' };
    if (pct >= 25)  return { msg: '\ud83d\udd25 BUILDING MOMENTUM', color: '#3B82F6' };
    if (estHoursLeft != null && estHoursLeft > (job?.meta?.workingHours || 8) * 1.5) {
      return { msg: '\u26a1 PICK UP THE PACE', color: '#EF4444' };
    }
    return { msg: '\ud83d\udcd6 EVERY SCAN COUNTS', color: '#3B82F6' };
  }, [totalScans, pct, estHoursLeft, job]);

  const topPerformer = leaderboard[0] || null;
  const activePodCount = Object.values(presence).filter((p) => p.online).length;
  const totalPodCount = (job?.meta?.pods || []).length;

  return (
    <div ref={containerRef} style={k.container}>
      {/* Inline animations + LIVE dot pulse */}
      <style>{`
        @keyframes pulse-dot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.4); } }
        @keyframes pulse-glow { 0%,100% { box-shadow: 0 0 30px rgba(34,197,94,0.4); } 50% { box-shadow: 0 0 60px rgba(34,197,94,0.7); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes slide-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .live-dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #22C55E; margin-right: 10px; vertical-align: middle; animation: pulse-dot 1.4s ease-in-out infinite; }
        .progress-shimmer {
          background: linear-gradient(90deg,
            transparent 0%,
            rgba(255,255,255,0.25) 50%,
            transparent 100%);
          background-size: 200% 100%;
          animation: shimmer 2.5s linear infinite;
        }
        .stat-tile { animation: slide-up 0.5s ease-out both; }
        .top-performer-card { animation: pulse-glow 3s ease-in-out infinite; }
      `}</style>

      {/* Top bar */}
      <div style={k.topBar}>
        <div>
          <h1 style={k.jobName}>{job?.meta?.name || 'No Active Job'}</h1>
          <span style={k.modeLabel}>
            {job?.meta?.mode === 'multi' ? 'Multi-PO' : 'Single PO'} \u00b7 {activePodCount}/{totalPodCount} pods active
            <span style={{ marginLeft: 18, color: '#22C55E', fontSize: 'clamp(14px, 1.2vw, 20px)', fontWeight: 800, letterSpacing: 2 }}>
              <span className="live-dot"></span>LIVE
            </span>
          </span>
        </div>
        <div style={k.clock}>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>

      {/* Motivational headline */}
      <div style={{ ...k.motivBanner, color: motivational.color, borderColor: motivational.color }}>
        {motivational.msg}
      </div>

      {/* Big numbers */}
      <div style={k.bigRow}>
        <div className="stat-tile" style={k.bigStat}>
          <div style={{ ...k.bigVal, color: '#fff' }}>{totalScans.toLocaleString()}</div>
          <div style={k.bigLbl}>SCANNED TODAY</div>
        </div>
        <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.1s' }}>
          <div style={{ ...k.bigVal, color: pct >= 100 ? '#A855F7' : pct >= 75 ? '#22C55E' : pct >= 50 ? '#3B82F6' : '#EAB308' }}>{pct}%</div>
          <div style={k.bigLbl}>OF TARGET</div>
        </div>
        <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.2s' }}>
          <div style={{ ...k.bigVal, color: '#22C55E' }}>{totalPace.toLocaleString()}</div>
          <div style={k.bigLbl}>SCANS / HR</div>
        </div>
        <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.3s' }}>
          <div style={k.bigVal}>{remaining.toLocaleString()}</div>
          <div style={k.bigLbl}>REMAINING</div>
        </div>
        <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.4s' }}>
          <div style={{ ...k.bigVal, color: countdownColor }}>{countdownLabel}</div>
          <div style={k.bigLbl}>TIME LEFT</div>
        </div>
        {etaTime && (
          <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.5s' }}>
            <div style={{ ...k.bigVal, color: countdownColor, fontSize: 'clamp(36px, 5vw, 70px)' }}>
              {etaTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </div>
            <div style={k.bigLbl}>ETA DONE</div>
          </div>
        )}
      </div>

      {/* Progress bar — fat, gradient, shimmery */}
      <div style={k.progressContainer}>
        <div style={{
          ...k.progressBar,
          width: `${pct}%`,
          background: pct >= 100
            ? 'linear-gradient(90deg, #A855F7, #EC4899, #F59E0B)'
            : pct >= 75
              ? 'linear-gradient(90deg, #22C55E, #84CC16)'
              : pct >= 50
                ? 'linear-gradient(90deg, #3B82F6, #22C55E)'
                : pct >= 25
                  ? 'linear-gradient(90deg, #EAB308, #3B82F6)'
                  : 'linear-gradient(90deg, #EF4444, #EAB308)',
        }} />
        <div className="progress-shimmer" style={{ ...k.progressShimmer, width: `${pct}%` }} />
        <span style={k.progressText}>{pct}%  \u2022  {totalScans.toLocaleString()} / {dailyTarget.toLocaleString()}</span>
      </div>

      {/* Top Performer + Leaderboard */}
      <div style={k.spotlightRow}>
        {topPerformer && (
          <div className="top-performer-card" style={k.topPerformer}>
            <div style={k.spotlightLbl}>\ud83c\udfc6 TOP PERFORMER</div>
            <div style={k.spotlightName}>{topPerformer.name}</div>
            <div style={k.spotlightCount}>{topPerformer.count.toLocaleString()}</div>
            <div style={k.spotlightSubLbl}>scans today</div>
          </div>
        )}

        <div style={{ ...k.section, flex: 2 }}>
          <h2 style={k.sectionTitle}>\ud83c\udfc5 Leaderboard</h2>
          <div style={k.leaderboard}>
            {leaderboard.slice(0, 8).map((l) => (
              <div key={l.name} style={{
                ...k.leaderRow,
                ...(l.rank <= 3 ? { background: l.rank === 1 ? 'linear-gradient(90deg, rgba(234,179,8,0.12), transparent)' : l.rank === 2 ? 'linear-gradient(90deg, rgba(156,163,175,0.10), transparent)' : 'linear-gradient(90deg, rgba(217,119,6,0.10), transparent)' } : {}),
              }}>
                <span style={{
                  ...k.rank,
                  color: l.rank === 1 ? '#EAB308' : l.rank === 2 ? '#9CA3AF' : l.rank === 3 ? '#D97706' : 'var(--text-tertiary, #666)',
                }}>
                  {l.rank <= 3 ? ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'][l.rank - 1] : `#${l.rank}`}
                </span>
                <span style={k.leaderName}>{l.name}</span>
                <span style={k.leaderCount}>{l.count.toLocaleString()}</span>
              </div>
            ))}
            {leaderboard.length === 0 && <p style={{ color: 'var(--text-tertiary, #666)', textAlign: 'center', padding: 30, fontSize: 'clamp(16px, 1.4vw, 22px)' }}>No scans yet \u2014 first one wins gold \ud83e\udd47</p>}
          </div>
        </div>
      </div>

      {/* Pods */}
      <div style={k.section}>
        <h2 style={k.sectionTitle}>Pod Status</h2>
        <div style={k.podGrid}>
          {(job?.meta?.pods || []).map((podId) => {
            const pd = podData[podId] || { count: 0, pace: 0 };
            const pr = presence[podId];
            const isOnline = pr?.online;
            const isPaused = pr?.status === 'paused';
            const onBreak = pr?.onBreak === true;
            const borderClr = onBreak ? '#A855F7' : isPaused ? '#EAB308' : isOnline ? '#22C55E' : '#333';
            const statusClr = onBreak ? '#A855F7' : isPaused ? '#EAB308' : isOnline ? '#22C55E' : 'var(--text-tertiary, #666)';
            const statusTxt = onBreak ? '\u2615 BREAK' : isPaused ? '\u23f8 PAUSED' : isOnline ? '\u25cf LIVE' : '\u25cb OFF';
            return (
              <div key={podId} style={{
                ...k.podCard,
                borderColor: borderClr,
                boxShadow: isOnline && !onBreak && !isPaused ? `0 0 20px ${borderClr}33` : 'none',
              }}>
                <div style={k.podHeader}>
                  <span style={k.podName}>{podId}</span>
                  <span style={{ ...k.podStatus, color: statusClr }}>{statusTxt}</span>
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

      {/* Hourly chart \u2014 compact */}
      <div style={k.section}>
        <h2 style={k.sectionTitle}>Hourly Breakdown</h2>
        <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 'clamp(80px, 10vh, 140px)', padding: '0 4px' }}>
          {hourlyData.map((d) => (
            <div key={d.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 'clamp(10px, 0.9vw, 14px)', color: '#888', marginBottom: 4, fontWeight: 700, fontFamily: 'monospace', minHeight: 14 }}>{d.count > 0 ? d.count : ''}</div>
              <div style={{
                width: '100%', maxWidth: 60,
                height: `${(d.count / maxHourly) * 100}%`, minHeight: d.count > 0 ? 6 : 1,
                background: d.hour === new Date().getHours()
                  ? 'linear-gradient(180deg, #FBBF24, #EAB308)'
                  : 'linear-gradient(180deg, #60A5FA, #3B82F6)',
                borderRadius: '6px 6px 0 0',
                boxShadow: d.hour === new Date().getHours() ? '0 0 12px rgba(234,179,8,0.5)' : 'none',
              }} />
              <div style={{ fontSize: 'clamp(11px, 0.9vw, 14px)', color: 'var(--text-tertiary, #666)', marginTop: 4, fontFamily: 'monospace' }}>{d.hour}</div>
            </div>
          ))}
        </div>
      </div>

      <p style={{ textAlign: 'center', color: '#444', fontSize: 'clamp(11px, 0.9vw, 14px)', marginTop: 16 }}>
        <button onClick={goFullscreen} style={{ background: 'none', border: '1px solid #444', color: '#888', borderRadius: 6, padding: '6px 16px', cursor: 'pointer', fontSize: 'clamp(11px, 0.9vw, 14px)' }}>\u26f6 Toggle Fullscreen</button>
        {' \u00b7 '}Auto-refreshes in real time
      </p>
    </div>
  );
}

const k = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0a0a0a)', color: 'var(--text, #f0f0f0)', fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif", padding: 'clamp(16px, 2vw, 32px)' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'clamp(12px, 1.2vw, 20px)' },
  jobName: { fontSize: 'clamp(28px, 3.5vw, 56px)', fontWeight: 900, margin: 0, letterSpacing: '-0.5px', background: 'linear-gradient(90deg, #fff, #aaa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' },
  modeLabel: { color: 'var(--text-secondary, #888)', fontSize: 'clamp(14px, 1.2vw, 20px)', fontWeight: 600 },
  clock: { fontSize: 'clamp(36px, 4.5vw, 72px)', fontWeight: 200, color: 'var(--text-secondary, #888)', fontFamily: 'monospace', letterSpacing: '-1px' },
  motivBanner: {
    textAlign: 'center',
    fontSize: 'clamp(28px, 3.5vw, 56px)',
    fontWeight: 900,
    letterSpacing: '2px',
    padding: 'clamp(14px, 1.5vw, 24px)',
    margin: 'clamp(8px, 1vw, 14px) 0 clamp(16px, 1.8vw, 28px)',
    border: '2px solid',
    borderRadius: 16,
    background: 'rgba(255,255,255,0.02)',
    textShadow: '0 0 30px currentColor',
    transition: 'all 0.6s ease',
  },
  bigRow: { display: 'flex', gap: 'clamp(16px, 1.8vw, 30px)', justifyContent: 'space-around', marginBottom: 'clamp(16px, 1.8vw, 28px)', flexWrap: 'wrap' },
  bigStat: { textAlign: 'center', minWidth: 'clamp(120px, 12vw, 200px)', flex: 1 },
  bigVal: { fontSize: 'clamp(48px, 7vw, 110px)', fontWeight: 900, lineHeight: 1, color: 'var(--text, #f0f0f0)', letterSpacing: '-2px', fontVariantNumeric: 'tabular-nums' },
  bigLbl: { fontSize: 'clamp(13px, 1.1vw, 18px)', color: 'var(--text-secondary, #888)', letterSpacing: 2.5, fontWeight: 700, marginTop: 8, textTransform: 'uppercase' },
  progressContainer: { height: 'clamp(28px, 3vw, 44px)', backgroundColor: '#1a1a1a', borderRadius: 22, overflow: 'hidden', position: 'relative', marginBottom: 'clamp(16px, 1.8vw, 28px)', border: '1px solid #2a2a2a' },
  progressBar: { height: '100%', borderRadius: 22, transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', position: 'absolute', top: 0, left: 0 },
  progressShimmer: { height: '100%', position: 'absolute', top: 0, left: 0, borderRadius: 22, pointerEvents: 'none' },
  progressText: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'clamp(14px, 1.3vw, 22px)', fontWeight: 800, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.8)', fontFamily: 'monospace', letterSpacing: 1 },
  spotlightRow: { display: 'flex', gap: 'clamp(12px, 1.2vw, 20px)', marginBottom: 'clamp(12px, 1.2vw, 20px)', flexWrap: 'wrap' },
  topPerformer: {
    flex: 1, minWidth: 280,
    background: 'linear-gradient(135deg, rgba(234,179,8,0.12), rgba(217,119,6,0.05))',
    border: '2px solid #EAB308', borderRadius: 16,
    padding: 'clamp(16px, 1.8vw, 28px)',
    textAlign: 'center', position: 'relative', overflow: 'hidden',
  },
  spotlightLbl: { fontSize: 'clamp(14px, 1.2vw, 20px)', fontWeight: 800, color: '#EAB308', letterSpacing: 3, marginBottom: 8 },
  spotlightName: { fontSize: 'clamp(28px, 3.5vw, 54px)', fontWeight: 900, color: '#fff', letterSpacing: '-1px', lineHeight: 1.1, marginBottom: 8, wordBreak: 'break-word' },
  spotlightCount: { fontSize: 'clamp(48px, 7vw, 110px)', fontWeight: 900, color: '#FBBF24', letterSpacing: '-2px', lineHeight: 1, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 30px rgba(234,179,8,0.5)' },
  spotlightSubLbl: { fontSize: 'clamp(12px, 1vw, 16px)', color: '#aaa', letterSpacing: 2, fontWeight: 600, marginTop: 6, textTransform: 'uppercase' },
  section: { backgroundColor: 'var(--bg-card, #0f0f0f)', borderRadius: 14, padding: 'clamp(14px, 1.4vw, 22px)', border: '1px solid var(--border, #1e1e1e)', marginBottom: 'clamp(12px, 1.2vw, 20px)' },
  sectionTitle: { fontSize: 'clamp(14px, 1.3vw, 22px)', fontWeight: 800, color: 'var(--text-secondary, #888)', margin: '0 0 clamp(10px, 1vw, 16px)', letterSpacing: 2, textTransform: 'uppercase' },
  podGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(180px, 16vw, 260px), 1fr))', gap: 'clamp(10px, 1vw, 16px)' },
  podCard: { backgroundColor: 'var(--bg-card, #161616)', borderRadius: 12, padding: 'clamp(12px, 1.2vw, 18px)', border: '2px solid var(--border, #222)', transition: 'box-shadow 0.4s ease' },
  podHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  podName: { fontSize: 'clamp(20px, 1.8vw, 32px)', fontWeight: 900, letterSpacing: '-0.3px' },
  podStatus: { fontSize: 'clamp(11px, 0.95vw, 15px)', fontWeight: 800, letterSpacing: 1 },
  podOp: { fontSize: 'clamp(13px, 1.1vw, 18px)', color: '#bbb', marginBottom: 8, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  podStats: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  podCount: { fontSize: 'clamp(28px, 2.8vw, 48px)', fontWeight: 900, letterSpacing: '-1px', fontVariantNumeric: 'tabular-nums' },
  podPace: { fontSize: 'clamp(12px, 1.1vw, 18px)', color: '#888', fontWeight: 600, fontFamily: 'monospace' },
  leaderboard: { },
  leaderRow: { display: 'flex', alignItems: 'center', gap: 'clamp(10px, 1vw, 16px)', padding: 'clamp(10px, 1vw, 14px) clamp(8px, 0.8vw, 12px)', borderBottom: '1px solid var(--border, #1e1e1e)', borderRadius: 6 },
  rank: { fontSize: 'clamp(20px, 1.8vw, 30px)', width: 'clamp(40px, 3.2vw, 56px)', textAlign: 'center', fontWeight: 800 },
  leaderName: { flex: 1, fontSize: 'clamp(16px, 1.4vw, 24px)', fontWeight: 700, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  leaderCount: { fontSize: 'clamp(20px, 1.8vw, 32px)', fontWeight: 900, color: '#fff', fontFamily: 'monospace', letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums' },
};
