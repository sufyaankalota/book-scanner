import React, { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection, query, where, onSnapshot, Timestamp,
} from 'firebase/firestore';
import { computeDailyTarget } from '../utils/target';

export default function Kiosk() {
  const [job, setJob] = useState(null);
  const [podData, setPodData] = useState({});
  const [presence, setPresence] = useState({});
  const [leaderboard, setLeaderboard] = useState([]);
  const [allScans, setAllScans] = useState([]);
  const [time, setTime] = useState(new Date());
  const [factIdx, setFactIdx] = useState(0);
  const containerRef = useRef(null);
  const milestoneRef = useRef({ 50: false, 75: false, 90: false, 100: false });
  const audioCtxRef = useRef(null);

  // Clock
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Rotate fun facts every 12s
  useEffect(() => {
    const t = setInterval(() => setFactIdx((i) => i + 1), 12000);
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
  // Daily target = 2,200 × pod count (scales with crew size).
  const dailyTarget = computeDailyTarget(job);
  const pct = dailyTarget > 0 ? Math.min(100, Math.round((totalScans / dailyTarget) * 100)) : 0;
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

  // Per-pod rankings (medals) + on-fire flag (top quartile by current pace)
  const podRanking = useMemo(() => {
    const entries = Object.entries(podData)
      .filter(([, v]) => v.count > 0)
      .sort((a, b) => b[1].count - a[1].count);
    const rankByPod = {};
    entries.forEach(([id], i) => { rankByPod[id] = i + 1; });
    const paces = Object.values(podData).map((p) => p.pace).filter((p) => p > 0).sort((a, b) => b - a);
    const fireThreshold = paces.length >= 4 ? paces[Math.floor(paces.length / 4)] : (paces[0] || Infinity);
    return { rankByPod, fireThreshold: Math.max(60, fireThreshold) };
  }, [podData]);

  // Rotating fun facts — derived from live data
  const funFacts = useMemo(() => {
    const facts = [];
    if (totalPace > 0) {
      const perSec = (totalPace / 3600).toFixed(1);
      facts.push(`⚡ ${perSec} books scanned every second!`);
      const perMin = Math.round(totalPace / 60);
      if (perMin > 0) facts.push(`📚 ${perMin} books per minute across the floor`);
    }
    if (totalScans >= 100) {
      const stackFt = (totalScans * 0.04).toFixed(1);
      facts.push(`📏 Stacked, today's books would be ${stackFt} ft tall`);
    }
    if (topPerformer) {
      facts.push(`🔥 ${topPerformer.name} leads with ${topPerformer.count.toLocaleString()} scans`);
    }
    if (activePodCount > 0 && totalScans > 0) {
      const avg = Math.round(totalScans / activePodCount);
      facts.push(`💪 Each active pod averages ${avg.toLocaleString()} books today`);
    }
    if (pct >= 100) {
      facts.push(`🎉 Target smashed! Every scan now is bonus ammo`);
    } else if (remaining > 0 && totalPace > 0) {
      facts.push(`🎯 ${remaining.toLocaleString()} books to go — you got this!`);
    }
    facts.push(`🏆 Top 3 operators get bragging rights all day`);
    facts.push(`✨ Every book scanned is a customer made happy`);
    return facts;
  }, [totalPace, totalScans, topPerformer, activePodCount, pct, remaining]);

  const currentFact = funFacts.length > 0 ? funFacts[factIdx % funFacts.length] : '';

  // Milestone sound effects (50/75/90/100%) — Web Audio API, no assets needed
  useEffect(() => {
    const playMilestone = (kind) => {
      try {
        if (!audioCtxRef.current) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          audioCtxRef.current = new Ctx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        // Notes: ascending arpeggio for milestone, fanfare for 100%
        const notes = kind === 'jackpot'
          ? [523.25, 659.25, 783.99, 1046.5, 1318.5] // C-E-G-C-E (fanfare)
          : kind === 'big'
            ? [523.25, 659.25, 783.99] // C-E-G
            : [523.25, 659.25]; // C-E
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          const start = ctx.currentTime + i * 0.13;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
          osc.connect(gain).connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.4);
        });
      } catch { /* audio is best-effort */ }
    };
    const checks = [
      { thr: 100, kind: 'jackpot' },
      { thr: 90,  kind: 'big' },
      { thr: 75,  kind: 'big' },
      { thr: 50,  kind: 'small' },
    ];
    for (const { thr, kind } of checks) {
      if (pct >= thr && !milestoneRef.current[thr]) {
        milestoneRef.current[thr] = true;
        playMilestone(kind);
      }
    }
  }, [pct]);

  return (
    <div ref={containerRef} className="kiosk-screen" style={k.container}>
      {/* Inline animations + LIVE dot pulse */}
      <style>{`
        @keyframes pulse-dot { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.4); } }
        @keyframes pulse-glow { 0%,100% { box-shadow: 0 0 30px rgba(34,197,94,0.4); } 50% { box-shadow: 0 0 60px rgba(34,197,94,0.7); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes slide-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fact-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
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

      {/* Top bar — compact single row */}
      <div style={k.topBar}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={k.jobName}>{job?.meta?.name || 'No Active Job'}</h1>
          <span style={k.modeLabel}>
            {job?.meta?.mode === 'multi' ? 'Multi-PO' : 'Single PO'}{' · '}{activePodCount}/{totalPodCount} pods active
            <span style={{ marginLeft: 14, color: '#22C55E', fontWeight: 800, letterSpacing: 2 }}>
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

      {/* Rotating fun fact */}
      {currentFact && (
        <div key={factIdx} style={k.funFact}>
          {currentFact}
        </div>
      )}

      {/* Main 2-column layout: stats+pods on left, spotlight+leaderboard on right */}
      <div style={k.mainGrid}>

        {/* LEFT column */}
        <div style={k.leftCol}>
          {/* Big stats — only 3 now */}
          <div style={k.bigRow}>
            <div className="stat-tile" style={k.bigStat}>
              <div style={{ ...k.bigVal, color: '#fff' }}>{totalScans.toLocaleString()}</div>
              <div style={k.bigLbl}>SCANNED TODAY</div>
            </div>
            <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.1s' }}>
              <div style={{ ...k.bigVal, color: '#22C55E' }}>{totalPace.toLocaleString()}</div>
              <div style={k.bigLbl}>SCANS / HR</div>
            </div>
            <div className="stat-tile" style={{ ...k.bigStat, animationDelay: '0.2s' }}>
              <div style={{ ...k.bigVal, color: pct >= 100 ? '#A855F7' : pct >= 75 ? '#22C55E' : pct >= 50 ? '#3B82F6' : '#EAB308' }}>{pct}%</div>
              <div style={k.bigLbl}>OF TARGET</div>
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
                const statusTxt = onBreak ? '☕ BREAK' : isPaused ? '⏸ PAUSED' : isOnline ? '● LIVE' : '○ OFF';
                const rank = podRanking.rankByPod[podId];
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
                const onFire = isOnline && !onBreak && !isPaused && pd.pace >= podRanking.fireThreshold && pd.pace > 0;
                return (
                  <div key={podId} style={{
                    ...k.podCard,
                    borderColor: onFire ? '#F59E0B' : borderClr,
                    boxShadow: onFire
                      ? '0 0 24px rgba(245,158,11,0.55)'
                      : isOnline && !onBreak && !isPaused ? `0 0 16px ${borderClr}33` : 'none',
                  }}>
                    <div style={k.podHeader}>
                      <span style={k.podName}>
                        {medal && <span style={{ marginRight: 4 }}>{medal}</span>}{podId}
                      </span>
                      <span style={{ ...k.podStatus, color: onFire ? '#F59E0B' : statusClr }}>
                        {onFire ? '🔥 ON FIRE' : statusTxt}
                      </span>
                    </div>
                    {pr?.operator && isOnline && <div style={k.podOp}>{pr.operator}</div>}
                    <div style={k.podStats}>
                      <span style={k.podPace}>{pd.pace}<span style={k.podPaceUnit}>/hr</span></span>
                      <span style={k.podCount}>{pd.count.toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT column — Top performer + leaderboard */}
        <div style={k.rightCol}>
          {topPerformer && (
            <div className="top-performer-card" style={k.topPerformer}>
              <div style={k.spotlightLbl}>{'🏆 TOP PERFORMER'}</div>
              <div style={k.spotlightName}>{topPerformer.name}</div>
              <div style={k.spotlightCount}>{topPerformer.count.toLocaleString()}</div>
              <div style={k.spotlightSubLbl}>scans today</div>
            </div>
          )}

          <div style={{ ...k.section, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <h2 style={k.sectionTitle}>{'🏅 Leaderboard'}</h2>
            <div style={{ ...k.leaderboard, flex: 1, overflow: 'auto', minHeight: 0 }}>
              {leaderboard.slice(0, 10).map((l) => (
                <div key={l.name} style={{
                  ...k.leaderRow,
                  ...(l.rank <= 3 ? { background: l.rank === 1 ? 'linear-gradient(90deg, rgba(234,179,8,0.12), transparent)' : l.rank === 2 ? 'linear-gradient(90deg, rgba(156,163,175,0.10), transparent)' : 'linear-gradient(90deg, rgba(217,119,6,0.10), transparent)' } : {}),
                }}>
                  <span style={{
                    ...k.rank,
                    color: l.rank === 1 ? '#EAB308' : l.rank === 2 ? '#9CA3AF' : l.rank === 3 ? '#D97706' : 'var(--text-tertiary, #666)',
                  }}>
                    {l.rank <= 3 ? ['🥇', '🥈', '🥉'][l.rank - 1] : `#${l.rank}`}
                  </span>
                  <span style={k.leaderName}>{l.name}</span>
                  <span style={k.leaderCount}>{l.count.toLocaleString()}</span>
                </div>
              ))}
              {leaderboard.length === 0 && <p style={{ color: 'var(--text-tertiary, #666)', textAlign: 'center', padding: 20, fontSize: 'clamp(13px, 1vw, 18px)' }}>No scans yet — first one wins gold 🥇</p>}
            </div>
          </div>
        </div>
      </div>

      <button onClick={goFullscreen} style={k.fullscreenBtn} title="Toggle fullscreen">⛶</button>
    </div>
  );
}

const k = {
  container: {
    height: '100vh', width: '100vw', maxWidth: '100vw',
    backgroundColor: 'var(--bg, #0a0a0a)', color: 'var(--text, #f0f0f0)',
    fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif",
    padding: 'clamp(8px, 1.2vh, 18px) clamp(10px, 1.4vw, 22px)',
    boxSizing: 'border-box', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', gap: 'clamp(4px, 0.8vh, 10px)',
    position: 'relative',
  },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexShrink: 0 },
  jobName: { fontSize: 'clamp(20px, 2.6vw, 38px)', fontWeight: 900, margin: 0, letterSpacing: '-0.5px', lineHeight: 1.1, background: 'linear-gradient(90deg, #fff, #aaa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  modeLabel: { color: 'var(--text-secondary, #888)', fontSize: 'clamp(11px, 1vw, 16px)', fontWeight: 600, display: 'inline-flex', alignItems: 'center' },
  clock: { fontSize: 'clamp(24px, 2.8vw, 44px)', fontWeight: 200, color: 'var(--text-secondary, #888)', fontFamily: 'monospace', letterSpacing: '-1px', flexShrink: 0 },

  motivBanner: {
    textAlign: 'center',
    fontSize: 'clamp(20px, 2.6vw, 40px)',
    fontWeight: 900,
    letterSpacing: '2px',
    padding: 'clamp(6px, 1vh, 14px) clamp(10px, 1.2vw, 20px)',
    border: '2px solid',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.02)',
    textShadow: '0 0 30px currentColor',
    transition: 'all 0.6s ease',
    flexShrink: 0,
  },
  funFact: {
    textAlign: 'center',
    fontSize: 'clamp(12px, 1.2vw, 18px)',
    fontWeight: 700,
    color: '#cbd5e1',
    letterSpacing: 0.5,
    padding: 'clamp(4px, 0.6vh, 8px) clamp(8px, 1vw, 16px)',
    background: 'linear-gradient(90deg, rgba(59,130,246,0.08), rgba(168,85,247,0.08))',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 8,
    animation: 'fact-in 0.6s ease-out',
    flexShrink: 0,
  },

  // 2-column main layout fills remaining height
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
    gap: 'clamp(8px, 1vw, 16px)',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  leftCol: { display: 'flex', flexDirection: 'column', gap: 'clamp(6px, 0.8vh, 12px)', minHeight: 0, minWidth: 0 },
  rightCol: { display: 'flex', flexDirection: 'column', gap: 'clamp(6px, 0.8vh, 12px)', minHeight: 0, minWidth: 0 },

  bigRow: { display: 'flex', gap: 'clamp(8px, 1vw, 16px)', justifyContent: 'space-around', flexShrink: 0 },
  bigStat: { textAlign: 'center', flex: 1, minWidth: 0 },
  bigVal: { fontSize: 'clamp(36px, 5.5vw, 84px)', fontWeight: 900, lineHeight: 1, color: 'var(--text, #f0f0f0)', letterSpacing: '-2px', fontVariantNumeric: 'tabular-nums' },
  bigLbl: { fontSize: 'clamp(10px, 0.9vw, 14px)', color: 'var(--text-secondary, #888)', letterSpacing: 2, fontWeight: 700, marginTop: 4, textTransform: 'uppercase' },

  topPerformer: {
    background: 'linear-gradient(135deg, rgba(234,179,8,0.12), rgba(217,119,6,0.05))',
    border: '2px solid #EAB308', borderRadius: 12,
    padding: 'clamp(10px, 1.2vh, 18px) clamp(10px, 1vw, 18px)',
    textAlign: 'center', position: 'relative', overflow: 'hidden', flexShrink: 0,
  },
  spotlightLbl: { fontSize: 'clamp(11px, 0.95vw, 16px)', fontWeight: 800, color: '#EAB308', letterSpacing: 3, marginBottom: 4 },
  spotlightName: { fontSize: 'clamp(18px, 2vw, 32px)', fontWeight: 900, color: '#fff', letterSpacing: '-0.5px', lineHeight: 1.1, marginBottom: 2, wordBreak: 'break-word' },
  spotlightCount: { fontSize: 'clamp(36px, 5vw, 76px)', fontWeight: 900, color: '#FBBF24', letterSpacing: '-2px', lineHeight: 1, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 30px rgba(234,179,8,0.5)' },
  spotlightSubLbl: { fontSize: 'clamp(10px, 0.85vw, 14px)', color: '#aaa', letterSpacing: 2, fontWeight: 600, marginTop: 4, textTransform: 'uppercase' },

  section: { backgroundColor: 'var(--bg-card, #0f0f0f)', borderRadius: 10, padding: 'clamp(8px, 1vw, 16px)', border: '1px solid var(--border, #1e1e1e)', minHeight: 0 },
  sectionTitle: { fontSize: 'clamp(11px, 1vw, 16px)', fontWeight: 800, color: 'var(--text-secondary, #888)', margin: '0 0 clamp(4px, 0.6vh, 10px)', letterSpacing: 2, textTransform: 'uppercase' },

  podGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(130px, 11vw, 180px), 1fr))',
    gap: 'clamp(6px, 0.8vw, 12px)',
  },
  podCard: { backgroundColor: 'var(--bg-card, #161616)', borderRadius: 8, padding: 'clamp(8px, 0.9vw, 14px)', border: '2px solid var(--border, #222)', transition: 'box-shadow 0.4s ease' },
  podHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6 },
  podName: { fontSize: 'clamp(15px, 1.4vw, 22px)', fontWeight: 900, letterSpacing: '-0.3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  podStatus: { fontSize: 'clamp(9px, 0.8vw, 12px)', fontWeight: 800, letterSpacing: 1, whiteSpace: 'nowrap' },
  podOp: { fontSize: 'clamp(11px, 0.9vw, 14px)', color: '#bbb', marginBottom: 4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  podStats: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  podPace: { fontSize: 'clamp(22px, 2.4vw, 38px)', fontWeight: 900, letterSpacing: '-1px', fontVariantNumeric: 'tabular-nums', color: '#22C55E' },
  podPaceUnit: { fontSize: 'clamp(11px, 0.9vw, 14px)', fontWeight: 700, color: '#888', marginLeft: 2 },
  podCount: { fontSize: 'clamp(13px, 1.1vw, 18px)', color: '#888', fontWeight: 700, fontFamily: 'monospace' },

  leaderboard: {},
  leaderRow: { display: 'flex', alignItems: 'center', gap: 'clamp(6px, 0.7vw, 12px)', padding: 'clamp(5px, 0.6vh, 10px) clamp(4px, 0.5vw, 8px)', borderBottom: '1px solid var(--border, #1e1e1e)', borderRadius: 4 },
  rank: { fontSize: 'clamp(15px, 1.4vw, 22px)', width: 'clamp(28px, 2.4vw, 42px)', textAlign: 'center', fontWeight: 800, flexShrink: 0 },
  leaderName: { flex: 1, minWidth: 0, fontSize: 'clamp(12px, 1.1vw, 18px)', fontWeight: 700, color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  leaderCount: { fontSize: 'clamp(15px, 1.4vw, 24px)', fontWeight: 900, color: '#fff', fontFamily: 'monospace', letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums', flexShrink: 0 },

  fullscreenBtn: {
    position: 'absolute', bottom: 8, right: 10,
    background: 'rgba(0,0,0,0.4)', border: '1px solid #333',
    color: '#666', borderRadius: 6, padding: '4px 10px',
    cursor: 'pointer', fontSize: 14, opacity: 0.5,
  },
};
