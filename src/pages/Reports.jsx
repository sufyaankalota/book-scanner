import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  collection, getDocs, query, where, Timestamp, limit as qLimit, orderBy, startAfter,
  getCountFromServer, doc, deleteDoc, getDoc,
} from 'firebase/firestore';
import {
  BarChart, Bar, LineChart, Line, ComposedChart, Area, AreaChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import * as XLSX from 'xlsx';
import { db } from '../firebase';
import { useToast } from '../components/Toast';
import { downloadBlob } from '../utils/export';
import RolePayEditor from '../components/RolePayEditor';
import { dailyPayTotal } from '../utils/roles';
import { useAuth } from '../contexts/AuthContext';
import { verifyPassword } from '../utils/crypto';
import { logAudit } from '../utils/audit';
import { cleanISBN } from '../utils/isbn';
import { isScanEngineConfigured, scanEngine } from '../lib/scanEngine';

const STANDARD_RATE = 0.50;
const EXCEPTION_RATE = 0.85;
const CREW_DAILY_GOAL = 30000;

// Operator/pod breakdown requires fetching scan docs. Skip for ranges larger
// than this to keep monthly/all-time loads fast.
const OPERATOR_BREAKDOWN_MAX_DAYS = 14;

// ─── Coherent color palette (data-viz friendly, AA-contrast on dark bg) ───
const C = {
  standard:  '#3B82F6', // blue-500
  exception: '#F472B6', // rose-400
  revenue:   '#10B981', // emerald-500
  labor:     '#F59E0B', // amber-500
  ai:        '#A855F7', // purple-500
  margin:    '#22D3EE', // cyan-400
  goal:      '#64748B', // slate-500 (reference line)
  danger:    '#EF4444',
  neutral:   '#94A3B8',
  muted:     '#64748B',
};
const OPERATOR_COLORS = ['#3B82F6', '#06B6D4', '#10B981', '#84CC16', '#EAB308', '#F59E0B', '#F97316', '#EF4444', '#EC4899', '#A855F7', '#8B5CF6', '#6366F1', '#0EA5E9', '#14B8A6', '#22C55E'];

// ─── Date-range presets ───
function getRangePreset(key) {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  // Monday-anchored week
  const monThisWeek = new Date(today);
  monThisWeek.setDate(monThisWeek.getDate() - ((monThisWeek.getDay() + 6) % 7));
  const monLastWeek = new Date(monThisWeek); monLastWeek.setDate(monLastWeek.getDate() - 7);
  const monNextWeek = new Date(monThisWeek); monNextWeek.setDate(monNextWeek.getDate() + 7);
  const firstThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const firstLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  switch (key) {
    case 'today':      return { start: today, end: tomorrow };
    case 'yesterday':  return { start: yesterday, end: today };
    case 'thisWeek':   return { start: monThisWeek, end: monNextWeek };
    case 'lastWeek':   return { start: monLastWeek, end: monThisWeek };
    case 'thisMonth':  return { start: firstThisMonth, end: firstNextMonth };
    case 'lastMonth':  return { start: firstLastMonth, end: firstThisMonth };
    default:           return { start: today, end: tomorrow };
  }
}

function dateInputValue(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseDateInput(s) { return new Date(s + 'T00:00:00'); }
function dayKey(d) { return dateInputValue(d); }

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

export default function Reports() {
  const { show: toast } = useToast();
  const { currentUser } = useAuth();
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState('all');
  const [preset, setPreset] = useState('today');
  const [customStart, setCustomStart] = useState(dateInputValue(getRangePreset('today').start));
  const [customEnd, setCustomEnd] = useState(dateInputValue(new Date(getRangePreset('today').end.getTime() - 86400000)));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [payEditDate, setPayEditDate] = useState(() => dateInputValue(new Date()));
  const [payRefreshKey, setPayRefreshKey] = useState(0);
  // Duplicate-cleanup UI state (per-operator expand + PIN gate + in-flight delete)
  const [dupExpanded, setDupExpanded] = useState({}); // { [scannerKey]: bool }
  const [dupPinOpen, setDupPinOpen] = useState(null); // { scanner, dupes } when collecting PIN
  const [dupPin, setDupPin] = useState('');
  const [dupPinError, setDupPinError] = useState('');
  const [dupBusy, setDupBusy] = useState(false);
  // Rapid-repeat (same ISBN < 30s) cleanup state
  const [rapidExpanded, setRapidExpanded] = useState({});
  const [rapidPinOpen, setRapidPinOpen] = useState(null);
  const [rapidPin, setRapidPin] = useState('');
  const [rapidPinError, setRapidPinError] = useState('');
  const [rapidBusy, setRapidBusy] = useState(false);
  // Range-wide aggregate counts (always fetched, cheap)
  const [summary, setSummary] = useState({
    standardScans: 0, exceptionScans: 0, manualScans: 0, aiMatchScans: 0,
    loggedExceptions: 0, aiCalls: 0, aiCost: 0,
  });
  // Per-day aggregate rows (always fetched, parallel)
  const [dailyAgg, setDailyAgg] = useState([]);
  // Full ai-usage docs for model breakdown table (small collection)
  const [aiUsage, setAiUsage] = useState([]);
  // dailyPay docs (small)
  const [pay, setPay] = useState([]);
  // Scan docs — only populated when range is small enough for operator breakdown
  const [scans, setScans] = useState([]);
  const [operatorBreakdownDisabled, setOperatorBreakdownDisabled] = useState(false);

  // Load all jobs once
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'jobs'));
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            if (a.meta?.active !== b.meta?.active) return a.meta?.active ? -1 : 1;
            const ta = a.meta?.closedAt?.toDate?.() || a.meta?.createdAt?.toDate?.() || new Date(0);
            const tb = b.meta?.closedAt?.toDate?.() || b.meta?.createdAt?.toDate?.() || new Date(0);
            return tb - ta;
          });
        setJobs(list);
      } catch (err) {
        toast('Failed to load jobs: ' + err.message, 'error');
      }
    })();
  }, []); // eslint-disable-line

  // Resolve effective date range
  const { start, end } = useMemo(() => {
    if (preset === 'custom') {
      const s = parseDateInput(customStart);
      const e = parseDateInput(customEnd);
      e.setDate(e.getDate() + 1); // make end inclusive
      return { start: s, end: e };
    }
    return getRangePreset(preset);
  }, [preset, customStart, customEnd]);

  // Fetch data when filters change
  const reqIdRef = React.useRef(0);
  useEffect(() => {
    const myReqId = ++reqIdRef.current;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setTruncated(false);
    // Clear stale data so visuals don't show old numbers while we refetch
    setDailyAgg([]);
    setScans([]);
    setAiUsage([]);
    setPay([]);
    setSummary({ standardScans: 0, exceptionScans: 0, manualScans: 0, aiMatchScans: 0, loggedExceptions: 0, aiCalls: 0, aiCost: 0 });
    (async () => {
      try {
        const jobFilter = jobId !== 'all' ? [where('jobId', '==', jobId)] : [];
        const startTs = Timestamp.fromDate(start);
        const endTs = Timestamp.fromDate(end);
        const rangeFilters = [where('timestamp', '>=', startTs), where('timestamp', '<', endTs)];

        // ─── Build per-day windows ───
        const dayWindows = [];
        {
          const d = new Date(start); d.setHours(0, 0, 0, 0);
          while (d < end) {
            const next = new Date(d); next.setDate(next.getDate() + 1);
            dayWindows.push([new Date(d), next > end ? end : next]);
            d.setDate(d.getDate() + 1);
          }
        }
        const numDays = dayWindows.length;
        const canShowOperators = numDays <= OPERATOR_BREAKDOWN_MAX_DAYS;
        setOperatorBreakdownDisabled(!canShowOperators);

        // dailyPay query (string date field) — same regardless of source
        const startKey = dayKey(start);
        const endKey = dayKey(new Date(end.getTime() - 86400000));
        const qPay = jobId !== 'all'
          ? query(collection(db, 'dailyPay'), where('jobId', '==', jobId),
              where('date', '>=', startKey), where('date', '<=', endKey))
          : query(collection(db, 'dailyPay'),
              where('date', '>=', startKey), where('date', '<=', endKey));

        // ai-usage docs (small collection — fetch fully, derive everything client-side)
        const qAi = query(collection(db, 'ai-usage'), ...jobFilter, ...rangeFilters);

        // ─── Scan-engine fast path ───
        // When configured, replace N per-day Firestore count queries + 5
        // range-wide count queries with a single SQL aggregation on Postgres,
        // and the per-day scan-doc fetch with keyset pagination on the
        // mirror. Works for cross-job (jobId === 'all') too.
        if (isScanEngineConfigured) {
          const summaryArgs = {
            jobId: jobId !== 'all' ? jobId : undefined,
            start: start.toISOString(),
            end: end.toISOString(),
          };
          const HARD_LIMIT = 100_000;
          const PAGE_SIZE = 5_000;
          const scansPromise = canShowOperators ? (async () => {
            const out = [];
            let cursor;
            while (out.length < HARD_LIMIT) {
              const { scans, nextCursor } = await scanEngine.listScans({
                ...summaryArgs,
                since: summaryArgs.start,
                until: summaryArgs.end,
                limit: PAGE_SIZE,
                cursor,
              });
              for (const s of scans) {
                // Shape parity with Firestore docs the rest of the page expects.
                out.push({ ...s, timestamp: { toDate: () => new Date(s.timestamp) } });
              }
              if (!nextCursor) break;
              cursor = nextCursor;
            }
            return out;
          })() : Promise.resolve([]);

          const [summaryRes, scanDocs, payRes, aiRes] = await Promise.all([
            scanEngine.scanSummary(summaryArgs).catch((e) => {
              console.error('summary fetch failed', e); return null;
            }),
            scansPromise.catch((e) => { console.error('scan fetch failed', e); return []; }),
            getDocs(qPay).catch((e) => { console.error('pay fetch failed', e); return { docs: [] }; }),
            getDocs(qAi).catch((e) => { console.error('ai-usage fetch failed', e); return { docs: [] }; }),
          ]);
          if (cancelled || reqIdRef.current !== myReqId) return;

          // Reshape summary into the same dailyArr/summary state the legacy
          // path produced so downstream useMemos don't change.
          const perDay = summaryRes?.perDay || [];
          const dailyArr = perDay.map((p) => ({
            date: p.day, scans: p.count, exceptions: 0, aiCalls: 0, aiCost: 0,
          }));
          // Ensure every requested day appears so charts have continuous data.
          const dayKeys = new Set(dailyArr.map((r) => r.date));
          for (const [d] of dayWindows) {
            const k = dayKey(d);
            if (!dayKeys.has(k)) dailyArr.push({ date: k, scans: 0, exceptions: 0, aiCalls: 0, aiCost: 0 });
          }
          const byType = summaryRes?.byType || {};
          const bySource = summaryRes?.bySource || {};
          const aiDocs = aiRes.docs.map((d) => ({ id: d.id, ...d.data() }));
          const aiCallsTotal = aiDocs.length;
          const aiCostTotal = aiDocs.reduce((s, u) => s + (Number(u.costUsd) || 0), 0);
          setDailyAgg(dailyArr.sort((a, b) => a.date.localeCompare(b.date)));
          setScans(scanDocs);
          setPay(payRes.docs.map((d) => ({ id: d.id, ...d.data() })));
          setAiUsage(aiDocs);
          setSummary({
            standardScans: byType.standard ?? 0,
            exceptionScans: byType.exception ?? 0,
            manualScans: bySource.manual ?? 0,
            aiMatchScans: bySource['ai-match'] ?? 0,
            loggedExceptions: summaryRes?.exceptionsCount ?? 0,
            aiCalls: aiCallsTotal,
            aiCost: aiCostTotal,
          });
          return;
        }

        // ─── Legacy Firestore path (scan-engine not configured) ───
        // Range-wide aggregates (KPI cards). Each is one Firestore round-trip
        // with zero doc transfer.
        const rangeQ = (name, extra = []) => query(
          collection(db, name), ...jobFilter, ...rangeFilters, ...extra,
        );
        const safeCount = async (q, label) => {
          try { return (await getCountFromServer(q)).data().count; }
          catch (e) { console.warn(`[Reports] count(${label}) failed:`, e.message); throw e; }
        };

        // ─── Per-day scans count (one round-trip per day, all parallel) ───
        const fetchDayScansCount = async ([dStart, dEnd]) => {
          const dayFilters = [
            where('timestamp', '>=', Timestamp.fromDate(dStart)),
            where('timestamp', '<', Timestamp.fromDate(dEnd)),
          ];
          const scansQ = query(collection(db, 'scans'), ...jobFilter, ...dayFilters);
          const c = await safeCount(scansQ, `scans day=${dayKey(dStart)}`).catch(() => 0);
          return { date: dayKey(dStart), scans: c, exceptions: 0, aiCalls: 0, aiCost: 0 };
        };
        const dailyPromise = Promise.all(dayWindows.map(fetchDayScansCount));

        // ─── Optional scan-doc fetch for operator/pod breakdown ───
        const HARD_LIMIT = 100_000;
        const PAGE_SIZE = 10_000;
        const fetchDayScans = async (dStart, dEnd) => {
          const out = [];
          let cursor = null;
          const dayFilters = [
            where('timestamp', '>=', Timestamp.fromDate(dStart)),
            where('timestamp', '<', Timestamp.fromDate(dEnd)),
          ];
          while (true) {
            const parts = [
              collection(db, 'scans'), ...jobFilter, ...dayFilters,
              orderBy('timestamp', 'asc'),
              ...(cursor ? [startAfter(cursor)] : []),
              qLimit(PAGE_SIZE),
            ];
            const snap = await getDocs(query(...parts));
            if (snap.empty) break;
            for (const dDoc of snap.docs) out.push({ id: dDoc.id, ...dDoc.data() });
            if (snap.docs.length < PAGE_SIZE) break;
            cursor = snap.docs[snap.docs.length - 1];
          }
          return out;
        };
        const scansPromise = canShowOperators
          ? Promise.all(dayWindows.map(([s, e]) => fetchDayScans(s, e))).then((arr) => arr.flat())
          : Promise.resolve([]);

        // ─── Range-wide breakdown counts (need composite indexes; soft-fail) ───
        const rangeSummaryPromise = Promise.all([
          safeCount(rangeQ('scans', [where('type', '==', 'standard')]), 'scans.type=standard').catch(() => null),
          safeCount(rangeQ('scans', [where('type', '==', 'exception')]), 'scans.type=exception').catch(() => null),
          safeCount(rangeQ('scans', [where('source', '==', 'manual')]), 'scans.source=manual').catch(() => null),
          safeCount(rangeQ('scans', [where('source', '==', 'ai-match')]), 'scans.source=ai-match').catch(() => null),
          safeCount(rangeQ('exceptions'), 'exceptions').catch(() => 0),
        ]);

        const [dailyArr, scanDocs, payRes, aiRes, rangeBits] = await Promise.all([
          dailyPromise.catch((e) => { console.error('daily agg failed', e); return []; }),
          scansPromise.catch((e) => { console.error('scan fetch failed', e); return []; }),
          getDocs(qPay).catch((e) => { console.error('pay fetch failed', e); return { docs: [] }; }),
          getDocs(qAi).catch((e) => { console.error('ai-usage fetch failed', e); return { docs: [] }; }),
          rangeSummaryPromise,
        ]);
        // Drop stale responses if filters changed while we were waiting
        if (cancelled || reqIdRef.current !== myReqId) return;

        const [stdC, excC, manC, aimC, logExcC] = rangeBits;
        const indexHints = [];
        if (stdC == null) indexHints.push('scans by type');
        if (manC == null) indexHints.push('scans by source');
        const totalScansFromDaily = dailyArr.reduce((s, r) => s + (r.scans || 0), 0);

        // Compute AI metrics from the docs we already have — always correct
        const aiDocs = aiRes.docs.map((d) => ({ id: d.id, ...d.data() }));
        const aiCallsTotal = aiDocs.length;
        const aiCostTotal = aiDocs.reduce((s, u) => s + (Number(u.costUsd) || 0), 0);

        setDailyAgg(dailyArr.sort((a, b) => a.date.localeCompare(b.date)));
        setScans(scanDocs);
        setPay(payRes.docs.map((d) => ({ id: d.id, ...d.data() })));
        setAiUsage(aiDocs);
        setSummary({
          standardScans: stdC ?? Math.max(0, totalScansFromDaily - (excC ?? 0)),
          exceptionScans: excC ?? 0,
          manualScans: manC ?? 0,
          aiMatchScans: aimC ?? 0,
          loggedExceptions: logExcC ?? 0,
          aiCalls: aiCallsTotal,
          aiCost: aiCostTotal,
        });
        if (indexHints.length) {
          setLoadError(`Range breakdown still indexing (${indexHints.join(', ')}) — totals shown will be approximate until Firestore finishes building the new indexes (~5 min). Refresh to retry.`);
        }
      } catch (err) {
        if (cancelled || reqIdRef.current !== myReqId) return;
        setLoadError(err.message || 'Load failed');
        toast('Load failed: ' + err.message, 'error');
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, start, end, payRefreshKey]); // eslint-disable-line

  // ─── Derived metrics (from server-side aggregates) ───
  const metrics = useMemo(() => {
    // Per the scan schema: type ∈ {standard, exception}; source ∈ {manual, ai-match, undefined}.
    // For billing, manual + ai-match scans count as EXCEPTION units even though they have type='standard'.
    const exceptionUnits = summary.manualScans + summary.aiMatchScans + summary.exceptionScans + summary.loggedExceptions;
    const standardCount = Math.max(0, summary.standardScans - summary.manualScans - summary.aiMatchScans);
    const totalUnits = standardCount + exceptionUnits;
    const revenue = standardCount * STANDARD_RATE + exceptionUnits * EXCEPTION_RATE;
    const aiCost = summary.aiCost;
    const aiCalls = summary.aiCalls;
    const labor = pay.reduce((s, p) => s + dailyPayTotal(p), 0);
    const margin = revenue - labor - aiCost;
    const exceptionRate = totalUnits ? (exceptionUnits / totalUnits) : 0;
    const aiUsageRate = totalUnits ? (aiCalls / totalUnits) : 0;
    return {
      standardCount, manualCount: summary.manualScans, aiMatchCount: summary.aiMatchScans,
      loggedExceptionCount: summary.loggedExceptions + summary.exceptionScans,
      exceptionUnits, totalUnits, revenue, aiCost, aiCalls, labor, margin, exceptionRate, aiUsageRate,
    };
  }, [summary, pay]);

  // ─── Daily breakdown (from per-day aggregates) ───
  // Note: at the per-day level we don't have type/source breakdown — we know
  // total scans and exception-collection count per day. Revenue per day uses
  // the range-wide exception ratio so the daily revenue line is internally
  // consistent with the KPI revenue.
  const daily = useMemo(() => {
    const totalUnitsRange = metrics.totalUnits;
    const exceptionUnitsRange = metrics.exceptionUnits;
    const blendedRate = totalUnitsRange
      ? (metrics.revenue / totalUnitsRange)
      : STANDARD_RATE;
    const exceptionShare = totalUnitsRange ? exceptionUnitsRange / totalUnitsRange : 0;
    const byDay = new Map();
    const ensure = (k) => {
      if (!byDay.has(k)) byDay.set(k, { date: k, total: 0, standard: 0, exceptions: 0, revenue: 0, aiCost: 0, aiCalls: 0, labor: 0 });
      return byDay.get(k);
    };
    dailyAgg.forEach((r) => {
      const row = ensure(r.date);
      const dayTotal = r.scans + r.exceptions;
      row.total = dayTotal;
      // Approximate split using range-wide ratio
      row.exceptions = Math.round(dayTotal * exceptionShare);
      row.standard = Math.max(0, dayTotal - row.exceptions);
      row.revenue = Math.round(dayTotal * blendedRate * 100) / 100;
      row.aiCost = Math.round((r.aiCost || 0) * 100) / 100;
      row.aiCalls = r.aiCalls || 0;
    });
    pay.forEach((p) => {
      if (!p.date) return;
      const row = ensure(p.date);
      row.labor = Math.round(dailyPayTotal(p) * 100) / 100;
    });
    return Array.from(byDay.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        ...r,
        margin: Math.round((r.revenue - r.aiCost - r.labor) * 100) / 100,
      }));
  }, [dailyAgg, pay, metrics]);

  // ─── By-pod productivity (requires scan docs; small ranges only) ───
  const byPod = useMemo(() => {
    const m = new Map();
    scans.forEach((s) => {
      const p = (s.podId || 'unassigned').toString().toUpperCase();
      m.set(p, (m.get(p) || 0) + 1);
    });
    return Array.from(m.entries())
      .map(([pod, count]) => ({ pod, count }))
      .sort((a, b) => b.count - a.count);
  }, [scans]);

  // ─── By-operator productivity (requires scan docs; small ranges only) ───
  const byOperator = useMemo(() => {
    const m = new Map();
    scans.forEach((s) => {
      const name = (s.scannerId || 'unknown').toString().trim() || 'unknown';
      const key = name.toLowerCase();
      if (!m.has(key)) m.set(key, { operator: name, standard: 0, exceptions: 0, total: 0 });
      const row = m.get(key);
      const isException = s.type === 'exception' || s.source === 'manual' || s.source === 'ai-match';
      if (isException) row.exceptions += 1; else row.standard += 1;
      row.total += 1;
    });
    return Array.from(m.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);
  }, [scans]);

  // ─── Duplicate scans per operator (today/yesterday — small ranges only) ───
  // Groups every scan by (scanner, job, isbn). Any group with > 1 scan means the
  // book was scanned more than once and the operator collected extra pay for the
  // duplicate copies. "Extra" = group size − 1 (the count we want to remove).
  const duplicatesByOperator = useMemo(() => {
    const groups = new Map(); // key = scanner|job|isbn -> { scanner, jobId, isbn, docs: [{id, ts}] }
    scans.forEach((s) => {
      const isbn = cleanISBN(s.isbn || '');
      if (!isbn) return;
      const scanner = (s.scannerId || 'unknown').toString().trim() || 'unknown';
      const jId = s.jobId || '(no-job)';
      const k = `${scanner.toLowerCase()}|${jId}|${isbn}`;
      if (!groups.has(k)) groups.set(k, { scanner, jobId: jId, isbn, docs: [] });
      groups.get(k).docs.push({ id: s.id, ts: s.timestamp?.toDate?.() || null, type: s.type, source: s.source });
    });
    const perOp = new Map();
    for (const g of groups.values()) {
      if (g.docs.length < 2) continue;
      g.docs.sort((a, b) => (a.ts?.getTime() || 0) - (b.ts?.getTime() || 0));
      const key = g.scanner.toLowerCase();
      if (!perOp.has(key)) perOp.set(key, { scanner: g.scanner, extras: 0, dupeIsbns: 0, totalScans: 0, overrides: 0, dupes: [] });
      const row = perOp.get(key);
      row.extras += g.docs.length - 1;
      row.dupeIsbns += 1;
      row.dupes.push(g);
    }
    // attach total scans + override count per operator
    scans.forEach((s) => {
      const scanner = (s.scannerId || 'unknown').toString().trim() || 'unknown';
      const key = scanner.toLowerCase();
      if (perOp.has(key)) {
        perOp.get(key).totalScans += 1;
        if (s.duplicateOverride) perOp.get(key).overrides += 1;
      }
    });
    return Array.from(perOp.values()).sort((a, b) => b.extras - a.extras);
  }, [scans]);

  // ─── Scan velocity per scanner per day (rapid-fire detection) ───
  // A real operator picks up a book, orients the barcode, scans, and places it in a
  // gaylord. The hard physical floor is ~2-3s between scans of different books.
  // Anyone with a high share of <2s gaps is almost certainly inflating counts by
  // either (a) re-triggering the same book multiple times before cooldown, or
  // (b) scanning a strip of barcodes printed on a sheet. Anything ≥3s is normal.
  //
  // Group by scanner+day so the same operator on two days shows two rows.
  const velocityByScanner = useMemo(() => {
    // bucket scans by scanner|day
    const buckets = new Map();
    scans.forEach((s) => {
      const ts = s.timestamp?.toDate?.();
      if (!ts) return;
      const scanner = (s.scannerId || 'unknown').toString().trim() || 'unknown';
      const day = dayKey(ts);
      const k = `${scanner.toLowerCase()}|${day}`;
      if (!buckets.has(k)) buckets.set(k, { scanner, day, items: [] });
      buckets.get(k).items.push(ts);
    });
    const rows = [];
    for (const b of buckets.values()) {
      const sorted = b.items.sort((a, z) => a - z);
      const total = sorted.length;
      if (total < 2) continue;
      // gaps in seconds
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 1000);
      const sub2 = gaps.filter((g) => g < 2).length;
      const sub3 = gaps.filter((g) => g < 3).length;
      const sub5 = gaps.filter((g) => g < 5).length;
      const sortedGaps = [...gaps].sort((a, z) => a - z);
      const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
      // Peak 60s sliding window — densest minute of the day for this scanner
      let peakMin = 0;
      for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (j < sorted.length && (sorted[j] - sorted[i]) <= 60_000) j++;
        const count = j - i;
        if (count > peakMin) peakMin = count;
      }
      // Longest burst of consecutive sub-2s gaps (run length)
      let longestBurst = 0, curBurst = 0;
      for (const g of gaps) {
        if (g < 2) { curBurst += 1; if (curBurst > longestBurst) longestBurst = curBurst; }
        else { curBurst = 0; }
      }
      const sub2Pct = total > 1 ? sub2 / (total - 1) : 0;
      // Suspicion score: weight sub-2s share heavily, peak/min lightly, and burst length
      const suspicion = Math.round(
        100 * sub2Pct +                    // 0–100 from share of sub-2s gaps
        Math.min(40, peakMin / 3) +        // up to +40 for >120 scans/min peaks
        Math.min(20, longestBurst)         // up to +20 for long bursts
      );
      rows.push({
        scanner: b.scanner, day: b.day, total,
        median: median ?? 0,
        sub2, sub3, sub5, sub2Pct,
        peakMin, longestBurst, suspicion,
      });
    }
    return rows.sort((a, z) => z.suspicion - a.suspicion);
  }, [scans]);

  // ─── Rapid same-ISBN repeats (the exact "scan the same book 2-3x fast" glitch) ───
  // For every (scanner, isbn) pair, walk timestamps in order and count any repeat
  // that landed within RAPID_WINDOW_MS of the previous scan of THAT SAME ISBN by
  // THAT SAME SCANNER. This is the inflation pattern we're chasing: it ignores
  // legitimate second copies scanned hours later, and ignores rapid scanning of
  // *different* books (which is the velocity card's job).
  const RAPID_WINDOW_MS = 30_000;
  const rapidRepeatsByScanner = useMemo(() => {
    const groups = new Map();
    scans.forEach((s) => {
      const isbn = cleanISBN(s.isbn || '');
      if (!isbn) return;
      const ts = s.timestamp?.toDate?.();
      if (!ts) return;
      const scanner = (s.scannerId || 'unknown').toString().trim() || 'unknown';
      const k = `${scanner.toLowerCase()}|${isbn}`;
      if (!groups.has(k)) groups.set(k, { scanner, isbn, items: [] });
      groups.get(k).items.push({ id: s.id, ts, jobId: s.jobId || '(no-job)' });
    });
    const perOp = new Map();
    for (const g of groups.values()) {
      if (g.items.length < 2) continue;
      g.items.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < g.items.length; i++) {
        const dt = g.items[i].ts - g.items[i - 1].ts;
        if (dt < RAPID_WINDOW_MS) {
          const key = g.scanner.toLowerCase();
          if (!perOp.has(key)) perOp.set(key, { scanner: g.scanner, events: [] });
          perOp.get(key).events.push({
            isbn: g.isbn,
            firstTs: g.items[i - 1].ts,
            repeatTs: g.items[i].ts,
            gapSec: dt / 1000,
            firstId: g.items[i - 1].id,
            repeatId: g.items[i].id,
            jobId: g.items[i].jobId,
          });
        }
      }
    }
    const totals = new Map();
    scans.forEach((s) => {
      const scanner = (s.scannerId || 'unknown').toString().trim() || 'unknown';
      const key = scanner.toLowerCase();
      totals.set(key, (totals.get(key) || 0) + 1);
    });
    return Array.from(perOp.values())
      .map((row) => ({
        ...row,
        rapidCount: row.events.length,
        affectedIsbns: new Set(row.events.map((e) => e.isbn)).size,
        totalScans: totals.get(row.scanner.toLowerCase()) || 0,
        events: row.events.sort((a, b) => a.repeatTs - b.repeatTs),
      }))
      .sort((a, b) => b.rapidCount - a.rapidCount);
  }, [scans]);

  const aiDaily = useMemo(() => {
    const m = new Map();
    aiUsage.forEach((u) => {
      const ts = u.timestamp?.toDate?.(); if (!ts) return;
      const k = dayKey(ts);
      if (!m.has(k)) m.set(k, { date: k, calls: 0, cost: 0 });
      const row = m.get(k);
      row.calls += 1;
      row.cost += Number(u.costUsd) || 0;
    });
    return Array.from(m.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ ...r, cost: Math.round(r.cost * 10000) / 10000 }));
  }, [aiUsage]);

  // ─── Top performers (scan docs; small ranges only) ───
  const topPerformers = useMemo(() => {
    const m = new Map();
    scans.forEach((s) => {
      const name = (s.scannerId || 'unknown').toString().trim();
      const key = name.toLowerCase();
      if (!m.has(key)) m.set(key, { name, count: 0 });
      m.get(key).count += 1;
    });
    return Array.from(m.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }, [scans]);

  // ─── AI model breakdown ───
  const aiByModel = useMemo(() => {
    const m = new Map();
    aiUsage.forEach((u) => {
      const key = u.model || 'unknown';
      if (!m.has(key)) m.set(key, { model: key, calls: 0, cost: 0, promptTokens: 0, completionTokens: 0, successes: 0 });
      const row = m.get(key);
      row.calls += 1;
      row.cost += Number(u.costUsd) || 0;
      row.promptTokens += Number(u.promptTokens) || 0;
      row.completionTokens += Number(u.completionTokens) || 0;
      if (u.success) row.successes += 1;
    });
    return Array.from(m.values()).map((r) => ({
      ...r,
      cost: Math.round(r.cost * 10000) / 10000,
      successRate: r.calls ? Math.round((r.successes / r.calls) * 100) : 0,
      avgCost: r.calls ? Math.round((r.cost / r.calls) * 10000) / 10000 : 0,
    })).sort((a, b) => b.calls - a.calls);
  }, [aiUsage]);

  const handleExport = () => {
    try {
      const wb = XLSX.utils.book_new();
      const fmt$ = (n) => Math.round(n * 100) / 100;

      // Sheet 1: Summary
      const jobLabel = jobId === 'all' ? 'All Jobs' : (jobs.find((j) => j.id === jobId)?.meta?.name || jobId);
      const summary = [
        ['Executive Report'],
        ['Job', jobLabel],
        ['Range', `${dayKey(start)} to ${dayKey(new Date(end.getTime() - 86400000))}`],
        ['Generated', new Date().toLocaleString()],
        [],
        ['Metric', 'Value'],
        ['Standard scans', metrics.standardCount],
        ['Exception units (manual + ai-match + logged)', metrics.exceptionUnits],
        ['Total units', metrics.totalUnits],
        ['Exception rate', `${(metrics.exceptionRate * 100).toFixed(1)}%`],
        ['Revenue', fmt$(metrics.revenue)],
        ['AI cost', fmt$(metrics.aiCost)],
        ['Labor cost', fmt$(metrics.labor)],
        ['Margin', fmt$(metrics.margin)],
        ['AI calls', metrics.aiCalls],
        ['Avg revenue / unit', metrics.totalUnits ? fmt$(metrics.revenue / metrics.totalUnits) : 0],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');

      // Sheet 2: Daily
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        daily.map((d) => ({
          Date: d.date,
          'Standard scans': d.standard,
          'Exception units': d.exceptions,
          'Revenue $': d.revenue,
          'AI cost $': d.aiCost,
          'Labor $': d.labor,
          'Margin $': d.margin,
        }))
      ), 'Daily');

      // Sheet 3: By Pod
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        byPod.map((p) => ({ Pod: p.pod, Scans: p.count }))
      ), 'By Pod');

      // Sheet 4: Top Performers
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        topPerformers.map((p, i) => ({ Rank: i + 1, Operator: p.name, Scans: p.count }))
      ), 'Top Performers');

      // Sheet 5: AI Usage
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        aiByModel.map((m) => ({
          Model: m.model,
          Calls: m.calls,
          'Success %': m.successRate,
          'Total cost $': m.cost,
          'Avg cost $': m.avgCost,
          'Prompt tokens': m.promptTokens,
          'Completion tokens': m.completionTokens,
        }))
      ), 'AI Usage');

      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const safeJob = (jobLabel || 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      downloadBlob(buf, `executive-report_${safeJob}_${dayKey(start)}_to_${dayKey(new Date(end.getTime() - 86400000))}.xlsx`);
      toast('Report downloaded', 'success');
    } catch (err) {
      toast('Export failed: ' + err.message, 'error');
    }
  };

  const fmtMoney = (n) => `$${(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtNum = (n) => (n || 0).toLocaleString();
  const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

  // Verify manager PIN against config/supervisor (hashed or legacy plaintext).
  const verifyManagerPin = async (pin) => {
    const entered = (pin || '').trim();
    if (!entered) return false;
    try {
      const snap = await getDoc(doc(db, 'config', 'supervisor'));
      if (snap.exists()) {
        const data = snap.data();
        if (data.pinHash) return await verifyPassword(entered, data.pinHash);
        if (data.pin) return entered === data.pin;
        return entered === '1234';
      }
      return entered === '1234';
    } catch { return entered === '1234'; }
  };

  // For each duplicate group, keep the earliest scan and delete the rest.
  // Writes an audit entry per deletion so the adjustment is traceable.
  const removeDuplicateExtras = async () => {
    if (!dupPinOpen || dupBusy) return;
    setDupBusy(true);
    const ok = await verifyManagerPin(dupPin);
    if (!ok) {
      setDupPinError('Invalid manager PIN'); setDupPin(''); setDupBusy(false);
      return;
    }
    const { scanner, dupes } = dupPinOpen;
    const toDelete = [];
    for (const g of dupes) {
      // docs already sorted earliest-first in the memo
      for (let i = 1; i < g.docs.length; i++) toDelete.push({ id: g.docs[i].id, isbn: g.isbn, jobId: g.jobId });
    }
    let deleted = 0;
    for (const d of toDelete) {
      try {
        await deleteDoc(doc(db, 'scans', d.id));
        try { await logAudit({ action: 'duplicate_scan_removed', target: d.id, meta: { scanner, isbn: d.isbn, jobId: d.jobId } }); } catch { /* best-effort */ }
        deleted += 1;
      } catch (err) { console.error('delete scan failed', d.id, err); }
    }
    const deletedIds = new Set(toDelete.map((d) => d.id));
    setScans((prev) => prev.filter((s) => !deletedIds.has(s.id)));
    toast(`Removed ${deleted} duplicate scan${deleted === 1 ? '' : 's'} for ${scanner}`, 'success');
    setDupPinOpen(null); setDupPin(''); setDupPinError(''); setDupBusy(false);
  };

  const removeRapidRepeats = async () => {
    if (!rapidPinOpen || rapidBusy) return;
    setRapidBusy(true);
    const ok = await verifyManagerPin(rapidPin);
    if (!ok) { setRapidPinError('Invalid manager PIN'); setRapidPin(''); setRapidBusy(false); return; }
    const { scanner, events } = rapidPinOpen;
    const ids = Array.from(new Set(events.map((e) => e.repeatId).filter(Boolean)));
    let deleted = 0;
    for (const id of ids) {
      try {
        await deleteDoc(doc(db, 'scans', id));
        try { await logAudit({ action: 'rapid_repeat_removed', target: id, meta: { scanner } }); } catch { /* best-effort */ }
        deleted += 1;
      } catch (err) { console.error('delete failed', id, err); }
    }
    const idSet = new Set(ids);
    setScans((prev) => prev.filter((s) => !idSet.has(s.id)));
    toast(`Removed ${deleted} rapid-repeat scan${deleted === 1 ? '' : 's'} for ${scanner}`, 'success');
    setRapidPinOpen(null); setRapidPin(''); setRapidPinError(''); setRapidBusy(false);
  };

  return (
    <div style={st.page}>
      <Link to="/" style={st.back}>← Back to Home</Link>
      <div style={st.headerRow}>
        <div>
          <h1 style={st.title}>📈 Executive Reports</h1>
          <p style={st.subtitle}>Productivity, billing, AI cost, labor and margin in one view.</p>
        </div>
        <button onClick={handleExport} disabled={loading} style={st.exportBtn}>📥 Export XLSX</button>
      </div>

      {/* Filters */}
      <div style={st.filters}>
        <div style={st.filterGroup}>
          <label style={st.label}>Job</label>
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} style={st.input}>
            <option value="all">All Jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.meta?.active ? '🟢 ' : '⏹️ '}{j.meta?.name || 'Unnamed'}
              </option>
            ))}
          </select>
        </div>
        <div style={st.filterGroup}>
          <label style={st.label}>Range</label>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} style={st.input}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="thisWeek">This Week (Mon–Sun)</option>
            <option value="lastWeek">Last Week</option>
            <option value="thisMonth">This Month</option>
            <option value="lastMonth">Last Month</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        {preset === 'custom' && (
          <>
            <div style={st.filterGroup}>
              <label style={st.label}>From</label>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={st.input} />
            </div>
            <div style={st.filterGroup}>
              <label style={st.label}>To</label>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={st.input} />
            </div>
          </>
        )}
        <div style={{ ...st.filterGroup, alignSelf: 'flex-end' }}>
          <span style={st.rangeLabel}>
            {dayKey(start)} → {dayKey(new Date(end.getTime() - 86400000))}
          </span>
        </div>
      </div>

      {loading && <p style={st.loading}>Loading…</p>}
      {loadError && !loading && (
        <div style={st.errorBox}>
          <strong>Some queries failed.</strong> {loadError}
          <div style={{ marginTop: 8, fontSize: 12, color: '#fca5a5' }}>
            If the message mentions “requires an index,” open the URL in the browser console to create it, then reload.
          </div>
        </div>
      )}
      {truncated && !loading && (
        <div style={st.warnBox}>
          ⚠️ Result truncated at 100,000 rows. Pick a job or narrow the date range for accurate totals.
        </div>
      )}

      {/* KPI cards */}
      <div style={st.kpiGrid}>
        <Kpi label="Total Units" value={fmtNum(metrics.totalUnits)} sub={`${fmtNum(metrics.standardCount)} std · ${fmtNum(metrics.exceptionUnits)} exc`} color={C.standard} />
        <Kpi label="Revenue" value={fmtMoney(metrics.revenue)} sub={`$0.50 / $0.85 rates`} color={C.revenue} />
        <Kpi label="Labor Cost" value={fmtMoney(metrics.labor)} sub={pay.length ? `${pay.length} days logged` : 'No payroll logged'} color={C.labor} />
        <Kpi label="AI Cost" value={fmtMoney(metrics.aiCost)} sub={`${fmtNum(metrics.aiCalls)} calls · ${fmtNum(metrics.aiMatchCount)} assists`} color={C.ai} />
        <Kpi label="Margin" value={fmtMoney(metrics.margin)} sub={metrics.revenue ? `${((metrics.margin / metrics.revenue) * 100).toFixed(1)}% of revenue` : '—'} color={metrics.margin >= 0 ? C.revenue : C.danger} />
        <Kpi label="Exception Rate" value={fmtPct(metrics.exceptionRate)} sub={`${fmtNum(metrics.exceptionUnits)} exception units`} color={C.exception} />
      </div>

      {/* Daily Labor editor (role-aggregated payroll) */}
      <div style={st.card}>
        <div style={st.payHeader}>
          <div>
            <h2 style={{ ...st.cardTitle, margin: 0 }}>Daily Labor</h2>
            <p style={st.paySub}>
              Enter # on shift, hours, and rate per role. Margin updates after save.
              {jobId === 'all' && ' Pick a specific job to edit.'}
            </p>
          </div>
          <label style={st.payDateLabel}>
            <span style={st.label}>Date</span>
            <input type="date" value={payEditDate}
              onChange={(e) => setPayEditDate(e.target.value)}
              style={st.input} />
          </label>
        </div>
        {jobId === 'all' ? (
          <p style={st.empty}>Select a single job above to enter labor for a day.</p>
        ) : (
          <RolePayEditor
            jobId={jobId}
            date={payEditDate}
            currentUser={currentUser}
            onSaved={() => setPayRefreshKey((k) => k + 1)}
          />
        )}
      </div>

      {/* Daily trend */}
      <div style={st.card}>
        <div style={st.cardHeader}>
          <h2 style={st.cardTitle}>Daily Production & Revenue</h2>
          <span style={st.cardHint}>Goal: {fmtNum(CREW_DAILY_GOAL)} units/day</span>
        </div>
        {daily.length === 0 ? <p style={st.empty}>No scans in this range.</p> : (
          <div style={{ width: '100%', height: 340 }}>
            <ResponsiveContainer>
              <ComposedChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.revenue} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={C.revenue} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickMargin={6} />
                <YAxis yAxisId="units" stroke={C.standard} fontSize={12} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                <YAxis yAxisId="rev" orientation="right" stroke={C.revenue} fontSize={12} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} labelStyle={{ color: '#cbd5e1' }} formatter={(v, n) => n === 'Revenue' ? fmtMoney(v) : fmtNum(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="units" dataKey="standard" stackId="u" fill={C.standard} name="Standard" barSize={daily.length > 14 ? 14 : 28} radius={[2, 2, 0, 0]} />
                <Bar yAxisId="units" dataKey="exceptions" stackId="u" fill={C.exception} name="Exceptions" barSize={daily.length > 14 ? 14 : 28} radius={[2, 2, 0, 0]} />
                <ReferenceLine yAxisId="units" y={CREW_DAILY_GOAL} stroke={C.goal} strokeDasharray="4 4" label={{ value: 'Goal', fill: C.goal, fontSize: 11, position: 'insideTopRight' }} />
                <Area yAxisId="rev" type="monotone" dataKey="revenue" stroke={C.revenue} strokeWidth={2.5} fill="url(#revGrad)" name="Revenue" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Margin chart — stacked-area cost breakdown + margin line on secondary axis */}
      <div style={st.card}>
        <h2 style={st.cardTitle}>Daily Cost Stack & Margin</h2>
        {daily.length === 0 ? <p style={st.empty}>No data.</p> : (
          <div style={{ width: '100%', height: 300 }}>
            <ResponsiveContainer>
              <ComposedChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickMargin={6} />
                <YAxis yAxisId="$" stroke="#94a3b8" fontSize={12} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} labelStyle={{ color: '#cbd5e1' }} formatter={(v) => fmtMoney(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area yAxisId="$" type="monotone" dataKey="labor" stackId="cost" stroke={C.labor} fill={C.labor} fillOpacity={0.55} name="Labor" />
                <Area yAxisId="$" type="monotone" dataKey="aiCost" stackId="cost" stroke={C.ai} fill={C.ai} fillOpacity={0.55} name="AI" />
                <Line yAxisId="$" type="monotone" dataKey="revenue" stroke={C.revenue} strokeWidth={2} name="Revenue" dot={false} />
                <Line yAxisId="$" type="monotone" dataKey="margin" stroke={C.margin} strokeWidth={2.5} name="Margin" dot={false} />
                <ReferenceLine yAxisId="$" y={0} stroke="#475569" strokeDasharray="2 2" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Operator & efficiency block (small ranges only — needs scan docs) */}
      <div style={st.card}>
        <div style={st.cardHeader}>
          <h2 style={st.cardTitle}>By Operator (Top 15)</h2>
          <span style={st.cardHint}>{scans.length ? `${fmtNum(scans.length)} scans analyzed` : ''}</span>
        </div>
        {operatorBreakdownDisabled ? (
          <p style={st.empty}>
            Operator breakdown is disabled for ranges over {OPERATOR_BREAKDOWN_MAX_DAYS} days to keep loads fast.<br />
            Pick a shorter range (Today, This Week, etc.) to see per-operator data.
          </p>
        ) : byOperator.length === 0 ? (
          <p style={st.empty}>No operator data.</p>
        ) : (
          <div style={{ width: '100%', height: Math.max(280, byOperator.length * 32) }}>
            <ResponsiveContainer>
              <BarChart data={byOperator} layout="vertical" margin={{ top: 8, right: 32, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                <XAxis type="number" stroke="#94a3b8" fontSize={12} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                <YAxis type="category" dataKey="operator" stroke="#cbd5e1" fontSize={12} width={130} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} labelStyle={{ color: '#cbd5e1' }} formatter={(v) => fmtNum(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="standard" stackId="o" fill={C.standard} name="Standard" radius={[0, 0, 0, 0]} />
                <Bar dataKey="exceptions" stackId="o" fill={C.exception} name="Exceptions" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Rapid same-ISBN repeats — THE inflation glitch we're catching */}
      <div style={st.card}>
        <div style={st.cardHeader}>
          <h2 style={st.cardTitle}>🚨 Rapid Same-ISBN Repeats (Inflation Glitch)</h2>
          <span style={st.cardHint}>
            {operatorBreakdownDisabled
              ? `Pick ≤ ${OPERATOR_BREAKDOWN_MAX_DAYS}-day range`
              : rapidRepeatsByScanner.length
                ? `${fmtNum(rapidRepeatsByScanner.reduce((s, r) => s + r.rapidCount, 0))} inflated scan${rapidRepeatsByScanner.reduce((s, r) => s + r.rapidCount, 0) === 1 ? '' : 's'} across ${rapidRepeatsByScanner.length} scanner${rapidRepeatsByScanner.length === 1 ? '' : 's'}`
                : 'None detected ✅'}
          </span>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>
          Same operator, same ISBN, scanned again within <strong>30 seconds</strong> of the previous scan.
          This is the exact glitch where someone scans one book 2-3x in quick succession to pad their numbers.
          Legitimate second copies of the same ISBN (minutes/hours later) are not counted here.
        </p>
        {operatorBreakdownDisabled ? (
          <p style={st.empty}>Switch to Today or Yesterday to audit rapid repeats.</p>
        ) : rapidRepeatsByScanner.length === 0 ? (
          <p style={st.empty}>No rapid same-ISBN repeats in this range. ✅</p>
        ) : (
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>Scanner</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Total scans</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Inflated scans</th>
                <th style={{ ...st.th, textAlign: 'right' }}>ISBNs abused</th>
                <th style={{ ...st.th, textAlign: 'right' }}>% inflated</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rapidRepeatsByScanner.map((row) => {
                const key = row.scanner.toLowerCase();
                const expanded = !!rapidExpanded[key];
                const pct = row.totalScans ? (row.rapidCount / row.totalScans) : 0;
                const pctColor = pct > 0.1 ? '#EF4444' : pct > 0.03 ? '#EAB308' : '#10B981';
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td style={st.td}>{row.scanner}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(row.totalScans)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: '#EF4444', fontWeight: 800, fontSize: 16 }}>{fmtNum(row.rapidCount)}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(row.affectedIsbns)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: pctColor, fontWeight: 700 }}>{(pct * 100).toFixed(1)}%</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>
                        <button
                          onClick={() => setRapidExpanded((p) => ({ ...p, [key]: !p[key] }))}
                          style={{ marginRight: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', fontSize: 12 }}>
                          {expanded ? 'Hide' : 'Show events'}
                        </button>
                        <button
                          onClick={() => { setRapidPinOpen({ scanner: row.scanner, events: row.events }); setRapidPin(''); setRapidPinError(''); }}
                          style={{ padding: '6px 10px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                          Remove inflated
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} style={{ ...st.td, background: '#0b1220' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ ...st.th, fontSize: 11 }}>ISBN</th>
                                <th style={{ ...st.th, fontSize: 11 }}>First scan</th>
                                <th style={{ ...st.th, fontSize: 11 }}>Inflated repeat</th>
                                <th style={{ ...st.th, fontSize: 11, textAlign: 'right' }}>Gap</th>
                                <th style={{ ...st.th, fontSize: 11 }}>Job</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.events.slice(0, 50).map((e, i) => (
                                <tr key={i}>
                                  <td style={{ ...st.td, fontFamily: 'monospace' }}>{e.isbn}</td>
                                  <td style={{ ...st.td, fontSize: 12, color: '#888' }}>{e.firstTs.toLocaleString()}</td>
                                  <td style={{ ...st.td, fontSize: 12, color: '#fca5a5' }}>{e.repeatTs.toLocaleString()}</td>
                                  <td style={{ ...st.td, textAlign: 'right', color: '#EF4444', fontWeight: 700 }}>{e.gapSec.toFixed(1)}s</td>
                                  <td style={{ ...st.td, fontSize: 12, color: '#888' }}>{e.jobId}</td>
                                </tr>
                              ))}
                              {row.events.length > 50 && (
                                <tr><td colSpan={5} style={{ ...st.td, color: '#888', fontStyle: 'italic' }}>
                                  …and {row.events.length - 50} more. All will be removed if you click "Remove inflated".
                                </td></tr>
                              )}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <p style={{ color: '#888', fontSize: 12, margin: '12px 0 0' }}>
          <strong>Remove inflated</strong> keeps the first scan of each burst and deletes every repeat within 30s.
          Going forward, the new 10s in-app cooldown prevents this glitch from happening at all.
        </p>
      </div>

      {/* Duplicate scans per scanner — only meaningful for short ranges where we have docs */}
      <div style={st.card}>
        <div style={st.cardHeader}>
          <h2 style={st.cardTitle}>Duplicate Scans by Scanner</h2>
          <span style={st.cardHint}>
            {operatorBreakdownDisabled
              ? `Pick ≤ ${OPERATOR_BREAKDOWN_MAX_DAYS}-day range`
              : duplicatesByOperator.length
                ? `${fmtNum(duplicatesByOperator.reduce((s, r) => s + r.extras, 0))} extra scan${duplicatesByOperator.reduce((s, r) => s + r.extras, 0) === 1 ? '' : 's'} across ${duplicatesByOperator.length} scanner${duplicatesByOperator.length === 1 ? '' : 's'}`
                : 'No duplicates in this range'}
          </span>
        </div>
        {operatorBreakdownDisabled ? (
          <p style={st.empty}>Switch to Today or Yesterday to audit duplicate scans.</p>
        ) : duplicatesByOperator.length === 0 ? (
          <p style={st.empty}>No duplicate ISBNs scanned in this range. ✅</p>
        ) : (
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>Scanner</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Total scans</th>
                <th style={{ ...st.th, textAlign: 'right' }}>ISBNs scanned 2+ times</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Extra (duplicate) scans</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Mgr-approved</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {duplicatesByOperator.map((row) => {
                const key = row.scanner.toLowerCase();
                const expanded = !!dupExpanded[key];
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td style={st.td}>{row.scanner}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(row.totalScans)}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(row.dupeIsbns)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: row.extras > 0 ? '#EF4444' : '#888', fontWeight: 700 }}>{fmtNum(row.extras)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: row.overrides > 0 ? '#EAB308' : '#666' }}>{fmtNum(row.overrides)}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>
                        <button
                          onClick={() => setDupExpanded((p) => ({ ...p, [key]: !p[key] }))}
                          style={{ marginRight: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid #374151', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', fontSize: 12 }}>
                          {expanded ? 'Hide' : 'Show ISBNs'}
                        </button>
                        <button
                          onClick={() => { setDupPinOpen({ scanner: row.scanner, dupes: row.dupes }); setDupPin(''); setDupPinError(''); }}
                          style={{ padding: '6px 10px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                          Remove extras
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} style={{ ...st.td, background: '#0b1220' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ ...st.th, fontSize: 11 }}>ISBN</th>
                                <th style={{ ...st.th, fontSize: 11 }}>Job</th>
                                <th style={{ ...st.th, fontSize: 11, textAlign: 'right' }}>Times</th>
                                <th style={{ ...st.th, fontSize: 11 }}>First</th>
                                <th style={{ ...st.th, fontSize: 11 }}>Last</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.dupes.map((g) => (
                                <tr key={`${g.jobId}-${g.isbn}`}>
                                  <td style={{ ...st.td, fontFamily: 'monospace' }}>{g.isbn}</td>
                                  <td style={{ ...st.td, color: '#888' }}>{g.jobId}</td>
                                  <td style={{ ...st.td, textAlign: 'right', color: '#EF4444', fontWeight: 700 }}>{g.docs.length}</td>
                                  <td style={{ ...st.td, color: '#888', fontSize: 12 }}>{g.docs[0].ts ? g.docs[0].ts.toLocaleTimeString() : '—'}</td>
                                  <td style={{ ...st.td, color: '#888', fontSize: 12 }}>{g.docs[g.docs.length - 1].ts ? g.docs[g.docs.length - 1].ts.toLocaleTimeString() : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <p style={{ color: '#888', fontSize: 12, margin: '12px 0 0' }}>
          “Extra” = scan-count minus one per ISBN per job. Clicking <strong>Remove extras</strong> keeps the earliest
          scan and deletes the rest after a manager PIN. Every deletion is audited.
        </p>
      </div>

      {/* Scan velocity — surface rapid-fire patterns across DIFFERENT ISBNs */}
      <div style={st.card}>
        <div style={st.cardHeader}>
          <h2 style={st.cardTitle}>Scan Velocity by Scanner (Rapid-Fire Detection)</h2>
          <span style={st.cardHint}>
            {operatorBreakdownDisabled
              ? `Pick ≤ ${OPERATOR_BREAKDOWN_MAX_DAYS}-day range`
              : velocityByScanner.length
                ? `${velocityByScanner.length} scanner-day${velocityByScanner.length === 1 ? '' : 's'} analyzed`
                : 'No scan data in this range'}
          </span>
        </div>
        {operatorBreakdownDisabled ? (
          <p style={st.empty}>Switch to Today or Yesterday to audit scan velocity.</p>
        ) : velocityByScanner.length === 0 ? (
          <p style={st.empty}>No data.</p>
        ) : (
          <>
            <table style={st.table}>
              <thead>
                <tr>
                  <th style={st.th}>Scanner</th>
                  <th style={st.th}>Day</th>
                  <th style={{ ...st.th, textAlign: 'right' }}>Total</th>
                  <th style={{ ...st.th, textAlign: 'right' }} title="Median seconds between consecutive scans">Median gap</th>
                  <th style={{ ...st.th, textAlign: 'right' }} title="Scans that arrived less than 2 seconds after the previous one">&lt;2s gaps</th>
                  <th style={{ ...st.th, textAlign: 'right' }} title="Most scans in any rolling 60-second window">Peak/min</th>
                  <th style={{ ...st.th, textAlign: 'right' }} title="Longest unbroken run of sub-2s gaps">Longest burst</th>
                  <th style={{ ...st.th, textAlign: 'right' }} title="Composite suspicion score (higher = more likely fraud). >60 worth investigating.">Suspicion</th>
                </tr>
              </thead>
              <tbody>
                {velocityByScanner.map((r) => {
                  const high = r.suspicion >= 60;
                  const warn = !high && r.suspicion >= 35;
                  const color = high ? '#EF4444' : warn ? '#EAB308' : '#10B981';
                  return (
                    <tr key={`${r.scanner}-${r.day}`}>
                      <td style={st.td}>{r.scanner}</td>
                      <td style={{ ...st.td, fontFamily: 'monospace', color: '#94a3b8' }}>{r.day}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(r.total)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: r.median < 2 ? '#EF4444' : r.median < 4 ? '#EAB308' : '#cbd5e1' }}>{r.median.toFixed(1)}s</td>
                      <td style={{ ...st.td, textAlign: 'right', color: r.sub2Pct > 0.25 ? '#EF4444' : r.sub2Pct > 0.1 ? '#EAB308' : '#cbd5e1' }}>
                        {fmtNum(r.sub2)} <span style={{ color: '#888', fontSize: 11 }}>({(r.sub2Pct * 100).toFixed(0)}%)</span>
                      </td>
                      <td style={{ ...st.td, textAlign: 'right', color: r.peakMin > 80 ? '#EF4444' : r.peakMin > 50 ? '#EAB308' : '#cbd5e1' }}>{fmtNum(r.peakMin)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: r.longestBurst >= 8 ? '#EF4444' : r.longestBurst >= 4 ? '#EAB308' : '#cbd5e1' }}>{fmtNum(r.longestBurst)}</td>
                      <td style={{ ...st.td, textAlign: 'right', fontWeight: 800, color }}>{r.suspicion}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p style={{ color: '#888', fontSize: 12, margin: '12px 0 0', lineHeight: 1.5 }}>
              <strong style={{ color: '#cbd5e1' }}>How to read this:</strong> a human picking up, orienting and scanning a different book
              takes ~3-5s minimum. Lots of sub-2s gaps means either a barcode strip or rapid re-triggers.
              <strong style={{ color: '#EF4444' }}> Red suspicion ≥ 60</strong> = investigate.
              <strong style={{ color: '#EAB308' }}> Yellow 35-59</strong> = monitor.
              <strong style={{ color: '#10B981' }}> Green &lt; 35</strong> = normal.
              Peak/min above ~60 is physically suspicious for non-conveyor workflows.
            </p>
          </>
        )}
      </div>

      {/* AI daily trend */}
      <div style={st.card}>
        <div style={st.cardHeader}>
          <h2 style={st.cardTitle}>AI Calls & Cost Per Day</h2>
          <span style={st.cardHint}>{fmtNum(metrics.aiCalls)} calls · {fmtNum(metrics.aiMatchCount)} matched · {fmtMoney(metrics.aiCost)}</span>
        </div>
        {aiDaily.length === 0 ? <p style={st.empty}>No AI calls in this range.</p> : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <ComposedChart data={aiDaily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickMargin={6} />
                <YAxis yAxisId="c" stroke={C.ai} fontSize={12} />
                <YAxis yAxisId="$" orientation="right" stroke={C.revenue} fontSize={12} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }} labelStyle={{ color: '#cbd5e1' }} formatter={(v, n) => n === 'Cost' ? fmtMoney(v) : fmtNum(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="c" dataKey="calls" fill={C.ai} name="Calls" barSize={aiDaily.length > 14 ? 12 : 24} radius={[2, 2, 0, 0]} />
                <Line yAxisId="$" type="monotone" dataKey="cost" stroke={C.revenue} strokeWidth={2.5} name="Cost" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* AI Usage table */}
      <div style={st.card}>
        <h2 style={st.cardTitle}>AI Usage by Model</h2>
        {aiByModel.length === 0 ? <p style={st.empty}>No AI calls in this range.</p> : (
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>Model</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Calls</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Success %</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Total cost</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Avg / call</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Prompt tokens</th>
                <th style={{ ...st.th, textAlign: 'right' }}>Completion tokens</th>
              </tr>
            </thead>
            <tbody>
              {aiByModel.map((m, i) => (
                <tr key={m.model + i}>
                  <td style={st.td}>{m.model}</td>
                  <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(m.calls)}</td>
                  <td style={{ ...st.td, textAlign: 'right' }}>{m.successRate}%</td>
                  <td style={{ ...st.td, textAlign: 'right' }}>{fmtMoney(m.cost)}</td>
                  <td style={{ ...st.td, textAlign: 'right' }}>${m.avgCost.toFixed(4)}</td>
                  <td style={{ ...st.td, textAlign: 'right', color: '#888' }}>{fmtNum(m.promptTokens)}</td>
                  <td style={{ ...st.td, textAlign: 'right', color: '#888' }}>{fmtNum(m.completionTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p style={st.footnote}>
        Rates: standard ${STANDARD_RATE.toFixed(2)} / exception ${EXCEPTION_RATE.toFixed(2)}.
        Labor pulled from <code>dailyPay</code>; log days on Dashboard → Crew & Pay.
        AI cost pulled from <code>ai-usage</code> (live per-call cost).
      </p>

      {dupPinOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ backgroundColor: '#0f172a', border: '2px solid #EF4444', borderRadius: 16, padding: 28, maxWidth: 460, width: '90%' }}>
            <h2 style={{ color: '#EF4444', margin: '0 0 8px', fontSize: 20, fontWeight: 800 }}>Remove duplicate scans</h2>
            <p style={{ color: '#cbd5e1', margin: '0 0 8px', fontSize: 14 }}>
              Scanner: <strong>{dupPinOpen.scanner}</strong>
            </p>
            <p style={{ color: '#94a3b8', margin: '0 0 16px', fontSize: 13 }}>
              {dupPinOpen.dupes.length} ISBN{dupPinOpen.dupes.length === 1 ? '' : 's'} affected ·{' '}
              {dupPinOpen.dupes.reduce((s, g) => s + g.docs.length - 1, 0)} scan{dupPinOpen.dupes.reduce((s, g) => s + g.docs.length - 1, 0) === 1 ? '' : 's'} will be deleted.
              The earliest scan of each ISBN is kept.
            </p>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={dupPin}
              onChange={(e) => { setDupPin(e.target.value); if (dupPinError) setDupPinError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); removeDuplicateExtras(); }
                if (e.key === 'Escape') { e.preventDefault(); setDupPinOpen(null); setDupPin(''); setDupPinError(''); }
              }}
              placeholder="Manager PIN"
              disabled={dupBusy}
              style={{ width: '100%', padding: '14px 16px', borderRadius: 8, border: `2px solid ${dupPinError ? '#EF4444' : '#374151'}`, backgroundColor: '#000', color: '#fff', fontSize: 22, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 4, textAlign: 'center', boxSizing: 'border-box' }}
            />
            {dupPinError && <p style={{ color: '#EF4444', fontSize: 13, fontWeight: 600, margin: '8px 0 0' }}>{dupPinError}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => { setDupPinOpen(null); setDupPin(''); setDupPinError(''); }}
                disabled={dupBusy}
                style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', fontSize: 14 }}>
                Cancel
              </button>
              <button onClick={removeDuplicateExtras}
                disabled={!dupPin || dupBusy}
                style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: (!dupPin || dupBusy) ? '#7f1d1d' : '#EF4444', color: '#fff', cursor: (!dupPin || dupBusy) ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, opacity: (!dupPin || dupBusy) ? 0.7 : 1 }}>
                {dupBusy ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {rapidPinOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ backgroundColor: '#0f172a', border: '2px solid #EF4444', borderRadius: 16, padding: 28, maxWidth: 460, width: '90%' }}>
            <h2 style={{ color: '#EF4444', margin: '0 0 8px', fontSize: 20, fontWeight: 800 }}>Remove inflated scans</h2>
            <p style={{ color: '#cbd5e1', margin: '0 0 8px', fontSize: 14 }}>
              Scanner: <strong>{rapidPinOpen.scanner}</strong>
            </p>
            <p style={{ color: '#94a3b8', margin: '0 0 16px', fontSize: 13 }}>
              {rapidPinOpen.events.length} rapid-repeat scan{rapidPinOpen.events.length === 1 ? '' : 's'} (same ISBN within 30s) will be deleted.
              The originating scan of each burst is kept.
            </p>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={rapidPin}
              onChange={(e) => { setRapidPin(e.target.value); if (rapidPinError) setRapidPinError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); removeRapidRepeats(); }
                if (e.key === 'Escape') { e.preventDefault(); setRapidPinOpen(null); setRapidPin(''); setRapidPinError(''); }
              }}
              placeholder="Manager PIN"
              disabled={rapidBusy}
              style={{ width: '100%', padding: '14px 16px', borderRadius: 8, border: `2px solid ${rapidPinError ? '#EF4444' : '#374151'}`, backgroundColor: '#000', color: '#fff', fontSize: 22, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 4, textAlign: 'center', boxSizing: 'border-box' }}
            />
            {rapidPinError && <p style={{ color: '#EF4444', fontSize: 13, fontWeight: 600, margin: '8px 0 0' }}>{rapidPinError}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => { setRapidPinOpen(null); setRapidPin(''); setRapidPinError(''); }}
                disabled={rapidBusy}
                style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', fontSize: 14 }}>
                Cancel
              </button>
              <button onClick={removeRapidRepeats}
                disabled={!rapidPin || rapidBusy}
                style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: (!rapidPin || rapidBusy) ? '#7f1d1d' : '#EF4444', color: '#fff', cursor: (!rapidPin || rapidBusy) ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, opacity: (!rapidPin || rapidBusy) ? 0.7 : 1 }}>
                {rapidBusy ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, color }) {
  return (
    <div style={{ ...st.kpi, borderLeft: `4px solid ${color}` }}>
      <div style={st.kpiLabel}>{label}</div>
      <div style={{ ...st.kpiValue, color }}>{value}</div>
      {sub && <div style={st.kpiSub}>{sub}</div>}
    </div>
  );
}

const st = {
  page: {
    minHeight: '100vh', background: 'var(--bg, #0a0a0a)', color: 'var(--text, #fff)',
    fontFamily: 'system-ui, -apple-system, sans-serif', padding: '24px 32px', maxWidth: 1400, margin: '0 auto',
  },
  back: { color: '#93c5fd', textDecoration: 'none', fontSize: 14, display: 'inline-block', marginBottom: 16 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24, flexWrap: 'wrap' },
  title: { fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.4px' },
  subtitle: { fontSize: 14, color: 'var(--text-secondary, #888)', margin: '4px 0 0 0' },
  exportBtn: {
    background: '#3B82F6', color: '#fff', border: 'none', padding: '12px 20px',
    fontSize: 14, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
  },
  filters: {
    display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
    background: 'var(--bg-card, #161616)', border: '1px solid var(--border, #222)',
    padding: 16, borderRadius: 12, marginBottom: 20,
  },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180 },
  label: { fontSize: 12, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: {
    background: '#0a0a0a', color: '#fff', border: '1px solid #333', borderRadius: 8,
    padding: '10px 12px', fontSize: 14, fontFamily: 'inherit',
  },
  rangeLabel: { fontSize: 13, color: '#888', padding: '10px 0', fontFamily: 'ui-monospace, monospace' },
  loading: { color: '#888', textAlign: 'center', padding: 24 },
  errorBox: {
    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
    color: '#fca5a5', padding: 14, borderRadius: 10, marginBottom: 16, fontSize: 13, lineHeight: 1.5,
  },
  warnBox: {
    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
    color: '#fcd34d', padding: 12, borderRadius: 10, marginBottom: 16, fontSize: 13,
  },
  payHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 14, flexWrap: 'wrap' },
  paySub: { fontSize: 13, color: '#888', margin: '4px 0 0 0' },
  payDateLabel: { display: 'flex', flexDirection: 'column', gap: 4 },
  kpiGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 12, marginBottom: 24,
  },
  kpi: {
    background: 'var(--bg-card, #161616)', border: '1px solid var(--border, #222)',
    padding: '14px 16px', borderRadius: 10,
  },
  kpiLabel: { fontSize: 12, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' },
  kpiValue: { fontSize: 26, fontWeight: 700, margin: '6px 0 2px 0', letterSpacing: '-0.5px' },
  kpiSub: { fontSize: 12, color: '#888' },
  card: {
    background: 'var(--bg-card, #161616)', border: '1px solid var(--border, #222)',
    borderRadius: 12, padding: 20, marginBottom: 20,
  },
  cardTitle: { fontSize: 16, fontWeight: 700, margin: '0 0 16px 0' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 12, flexWrap: 'wrap' },
  cardHint: { fontSize: 12, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 20 },
  empty: { color: '#666', textAlign: 'center', padding: 24, fontSize: 13 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #222', color: '#888', fontWeight: 600, fontSize: 12, textTransform: 'uppercase' },
  td: { padding: '10px 12px', borderBottom: '1px solid #181818' },
  footnote: { fontSize: 12, color: '#666', marginTop: 16, lineHeight: 1.6 },
};
