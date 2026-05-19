import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../firebase';
import { computeDailyTarget } from '../utils/target';
import { normalizeOperatorKey, displayOperatorName } from '../utils/operator';

/**
 * Live "Today" stats: total scans, top 5 operators, hourly pace trend.
 * Shared between Home and Dashboard so we don't drift.
 *
 * @param {object} job   active job doc ({ id, meta, ... })
 * @param {object} opts
 * @param {boolean} opts.compact   smaller layout for the home page
 * @param {boolean} opts.canMerge  show admin-only "merge scanner names" UI
 */
export default function TodayLeaderboard({ job, compact = false, canMerge = false }) {
  const [scans, setScans] = useState([]);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState(new Set()); // keys to merge FROM
  const [targetName, setTargetName] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeMsg, setMergeMsg] = useState('');
  // Re-subscribe when the local calendar day flips so the `timestamp >= today`
  // listener doesn't get stranded on yesterday's midnight when the page is
  // left open overnight (Kiosk / Dashboard).
  const [dayKey, setDayKey] = useState(() => new Date().toDateString());
  useEffect(() => {
    const i = setInterval(() => {
      const k = new Date().toDateString();
      setDayKey((prev) => (prev === k ? prev : k));
    }, 60000);
    return () => clearInterval(i);
  }, []);

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
  }, [job?.id, dayKey]);

  const stats = useMemo(() => {
    if (!scans.length) {
      return { total: 0, leaders: [], all: [], lastHour: 0, prevHour: 0, paceDrop: 0 };
    }
    const byOp = {}; // key -> { name, key, count }
    const now = Date.now();
    let lastHour = 0, prevHour = 0;
    for (const s of scans) {
      const raw = s.scannerId || 'Unknown';
      const key = normalizeOperatorKey(raw) || 'unknown';
      if (!byOp[key]) byOp[key] = { name: displayOperatorName(raw) || 'Unknown', key, count: 0, raw };
      byOp[key].count += 1;
      const t = s.timestamp?.toDate?.()?.getTime?.();
      if (!t) continue;
      const ageMin = (now - t) / 60000;
      if (ageMin <= 60) lastHour += 1;
      else if (ageMin <= 120) prevHour += 1;
    }
    const all = Object.values(byOp).sort((a, b) => b.count - a.count);
    // Compact mode (Home page) keeps the short top-5 list; full mode
    // (Dashboard) shows every operator with scans today so supervisors can
    // see the entire crew at a glance.
    const leaders = compact ? all.slice(0, 5) : all;
    // % drop in pace vs previous hour. >25% drop = alert-worthy.
    // Need at least 30 scans in prevHour for the comparison to be meaningful.
    const paceDrop = prevHour >= 30 ? Math.round(((prevHour - lastHour) / prevHour) * 100) : 0;
    return { total: scans.length, leaders, all, lastHour, prevHour, paceDrop };
  }, [scans, compact]);

  if (!job) return null;

  const target = computeDailyTarget(job);
  const pct = target > 0 ? Math.round((stats.total / target) * 100) : 0;

  const toggleSelected = (key, name) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // auto-fill target name with the largest selected row's display name
      if (!targetName) setTargetName(name);
      return next;
    });
  };

  const runMerge = async () => {
    if (selected.size < 1 || !targetName.trim() || merging) return;
    const fromNames = Array.from(selected)
      .map((k) => stats.all.find((r) => r.key === k)?.raw)
      .filter(Boolean);
    const to = targetName.trim();
    if (!window.confirm(`Merge ${fromNames.length} scanner name(s) → "${to}" for this job?\n\nFrom: ${fromNames.join(', ')}\n\nThis rewrites every matching scan + exception. Then click "🔄 Rebuild counts" to refresh totals.`)) return;
    setMerging(true); setMergeMsg('');
    try {
      const fn = httpsCallable(functions, 'mergeScannerName');
      const res = await fn({ fromNames, toName: to, jobId: job.id });
      setMergeMsg(`✓ Merged ${res.data?.updated || 0} record(s) into "${to}"`);
      setSelected(new Set());
      setTargetName('');
    } catch (err) {
      setMergeMsg('Failed: ' + (err.message || 'unknown'));
    }
    setMerging(false);
  };

  const rowsToShow = mergeMode ? stats.all : stats.leaders;

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canMerge && stats.all.length > 1 && (
            <button
              onClick={() => { setMergeMode((m) => !m); setSelected(new Set()); setMergeMsg(''); }}
              title="Combine duplicate scanner names (e.g. typos)"
              style={mergeMode ? styles.mergeBtnActive : styles.mergeBtn}
            >
              {mergeMode ? '✕ Cancel merge' : '🔗 Merge names'}
            </button>
          )}
          <div style={styles.totalChip}>
            {stats.total.toLocaleString()} scans · {pct}% of {target.toLocaleString()}
          </div>
        </div>
      </div>

      {mergeMode && (
        <div style={styles.mergeHint}>
          Check the rows to combine, then type the correct name to merge them into.
        </div>
      )}

      {rowsToShow.length === 0 ? (
        <div style={styles.empty}>No scans yet today — be the first!</div>
      ) : (
        <div style={{ ...styles.list, maxHeight: compact ? undefined : 480, overflowY: compact ? undefined : 'auto' }}>
          {rowsToShow.map((l, i) => (
            <div
              key={l.key || l.name}
              style={{
                ...styles.row,
                ...(!mergeMode && i === 0 ? styles.firstRow : null),
                ...(mergeMode && selected.has(l.key) ? styles.selectedRow : null),
                cursor: mergeMode ? 'pointer' : 'default',
              }}
              onClick={mergeMode ? () => toggleSelected(l.key, l.name) : undefined}
            >
              {mergeMode ? (
                <input
                  type="checkbox"
                  checked={selected.has(l.key)}
                  onChange={() => toggleSelected(l.key, l.name)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
              ) : (
                <span style={styles.rank}>{i < 3 ? ['🥇', '🥈', '🥉'][i] : `#${i + 1}`}</span>
              )}
              <span style={styles.name}>{l.name}</span>
              <span style={styles.count}>{l.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {mergeMode && (
        <div style={styles.mergeBar}>
          <input
            type="text"
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            placeholder="Correct name (e.g. Subatha)"
            style={styles.mergeInput}
          />
          <button
            onClick={runMerge}
            disabled={merging || selected.size < 1 || !targetName.trim()}
            style={{ ...styles.mergeGo, opacity: (merging || selected.size < 1 || !targetName.trim()) ? 0.5 : 1, cursor: merging ? 'wait' : 'pointer' }}
          >
            {merging ? '⏳ Merging…' : `Merge ${selected.size} → "${targetName.trim() || '…'}"`}
          </button>
        </div>
      )}
      {mergeMsg && <div style={styles.mergeMsg}>{mergeMsg}</div>}

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
  mergeBtn: { padding: '4px 10px', borderRadius: 6, border: '1px solid #555', backgroundColor: 'transparent', color: '#aaa', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  mergeBtnActive: { padding: '4px 10px', borderRadius: 6, border: '1px solid #EAB308', backgroundColor: 'rgba(234,179,8,0.15)', color: '#FDE68A', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  mergeHint: { color: '#FDE68A', fontSize: 12, marginBottom: 8, padding: '6px 10px', backgroundColor: 'rgba(234,179,8,0.08)', borderRadius: 6, border: '1px solid rgba(234,179,8,0.25)' },
  selectedRow: { backgroundColor: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)' },
  mergeBar: { display: 'flex', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border, #333)' },
  mergeInput: { flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #444', backgroundColor: '#0b0b0b', color: '#eee', fontSize: 13 },
  mergeGo: { padding: '6px 14px', borderRadius: 6, border: 'none', backgroundColor: '#3B82F6', color: '#fff', fontSize: 13, fontWeight: 700 },
  mergeMsg: { color: '#aaa', fontSize: 12, marginTop: 8, fontStyle: 'italic' },
};
