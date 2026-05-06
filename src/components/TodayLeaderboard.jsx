import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { computeDailyTarget } from '../utils/target';

/**
 * Live "Today" stats: total scans, top 5 operators, hourly pace trend.
 * Shared between Home and Dashboard so we don't drift.
 *
 * @param {object} job   active job doc ({ id, meta, ... })
 * @param {object} opts
 * @param {boolean} opts.compact  smaller layout for the home page
 */
export default function TodayLeaderboard({ job, compact = false }) {
  const [scans, setScans] = useState([]);

  useEffect(() => {
    if (!job?.id) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(
      collection(db, 'scans'),
      where('jobId', '==', job.id),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );
    const unsub = onSnapshot(q, (snap) => {
      setScans(snap.docs.map((d) => d.data()));
    });
    return unsub;
  }, [job?.id]);

  const stats = useMemo(() => {
    if (!scans.length) {
      return { total: 0, leaders: [], lastHour: 0, prevHour: 0, paceDrop: 0 };
    }
    const byOp = {};
    const now = Date.now();
    let lastHour = 0, prevHour = 0;
    for (const s of scans) {
      const op = s.scannerId || 'Unknown';
      byOp[op] = (byOp[op] || 0) + 1;
      const t = s.timestamp?.toDate?.()?.getTime?.();
      if (!t) continue;
      const ageMin = (now - t) / 60000;
      if (ageMin <= 60) lastHour += 1;
      else if (ageMin <= 120) prevHour += 1;
    }
    const leaders = Object.entries(byOp)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    // % drop in pace vs previous hour. >25% drop = alert-worthy.
    // Need at least 30 scans in prevHour for the comparison to be meaningful.
    const paceDrop = prevHour >= 30 ? Math.round(((prevHour - lastHour) / prevHour) * 100) : 0;
    return { total: scans.length, leaders, lastHour, prevHour, paceDrop };
  }, [scans]);

  if (!job) return null;

  const target = computeDailyTarget(job);
  const pct = target > 0 ? Math.round((stats.total / target) * 100) : 0;

  return (
    <div style={compact ? styles.compactWrap : styles.wrap}>
      {/* Pace drop alert */}
      {stats.paceDrop >= 25 && (
        <div style={styles.alert}>
          ⚠️ <strong>Pace dropped {stats.paceDrop}%</strong> — last hour: {stats.lastHour} vs previous: {stats.prevHour}
        </div>
      )}

      <div style={styles.headerRow}>
        <div style={styles.title}>🏆 Today's Leaderboard</div>
        <div style={styles.totalChip}>
          {stats.total.toLocaleString()} scans · {pct}% of {target.toLocaleString()}
        </div>
      </div>

      {stats.leaders.length === 0 ? (
        <div style={styles.empty}>No scans yet today — be the first!</div>
      ) : (
        <div style={styles.list}>
          {stats.leaders.map((l, i) => (
            <div key={l.name} style={{ ...styles.row, ...(i === 0 ? styles.firstRow : null) }}>
              <span style={styles.rank}>{['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]}</span>
              <span style={styles.name}>{l.name}</span>
              <span style={styles.count}>{l.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {stats.lastHour > 0 && (
        <div style={styles.paceLine}>
          ⏱️ Last hour: <strong>{stats.lastHour}</strong>
          {stats.prevHour > 0 && ` · Previous: ${stats.prevHour}`}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: {
    backgroundColor: 'var(--bg-card, #1a1a1a)',
    border: '1px solid var(--border, #333)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  compactWrap: {
    backgroundColor: 'var(--bg-card, #1a1a1a)',
    border: '1px solid var(--border, #333)',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  title: { color: 'var(--text, #eee)', fontSize: 16, fontWeight: 700 },
  totalChip: { color: '#22C55E', fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 999, backgroundColor: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' },
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6 },
  firstRow: { backgroundColor: 'rgba(234,179,8,0.08)' },
  rank: { fontSize: 16, minWidth: 24 },
  name: { flex: 1, color: 'var(--text, #ccc)', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  count: { color: 'var(--text, #fff)', fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  paceLine: { color: 'var(--text-secondary, #888)', fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border, #333)' },
  empty: { color: 'var(--text-secondary, #888)', fontSize: 13, padding: '12px 4px', fontStyle: 'italic' },
  alert: {
    backgroundColor: '#7c2d12',
    border: '1px solid #EF4444',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 12,
    color: '#fed7aa',
    fontSize: 14,
    fontWeight: 600,
  },
};
