import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  collection, getDocs, query, where, Timestamp, limit as qLimit, orderBy, startAfter,
} from 'firebase/firestore';
import {
  BarChart, Bar, LineChart, Line, ComposedChart, Area, AreaChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import * as XLSX from 'xlsx';
import { db } from '../firebase';
import { useToast } from '../components/Toast';
import { downloadBlob } from '../utils/export';
import RolePayEditor from '../components/RolePayEditor';
import { dailyPayTotal } from '../utils/roles';
import { useAuth } from '../contexts/AuthContext';

const STANDARD_RATE = 0.50;
const EXCEPTION_RATE = 0.85;

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
  const [scans, setScans] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [aiUsage, setAiUsage] = useState([]);
  const [pay, setPay] = useState([]);

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
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setTruncated(false);
    (async () => {
      try {
        const jobFilter = jobId !== 'all' ? [where('jobId', '==', jobId)] : [];

        // Firestore caps a single query at 10k rows. For multi-day ranges we
        // split into per-day windows and fetch them in parallel — much faster
        // than serial cursor pagination at 15k–20k scans/day.
        const HARD_LIMIT = 100_000;
        const PAGE_SIZE = 10_000;

        // Build day windows covering [start, end)
        const dayWindows = [];
        {
          const d = new Date(start);
          d.setHours(0, 0, 0, 0);
          while (d < end) {
            const next = new Date(d); next.setDate(next.getDate() + 1);
            dayWindows.push([new Date(d), next > end ? end : next]);
            d.setDate(d.getDate() + 1);
          }
        }
        // Cap parallel fan-out so we don't slam Firestore on a huge custom range
        const MAX_PARALLEL = 12;

        const fetchDay = async (collName, dStart, dEnd) => {
          const out = [];
          let cursor = null;
          const dayFilters = [
            where('timestamp', '>=', Timestamp.fromDate(dStart)),
            where('timestamp', '<', Timestamp.fromDate(dEnd)),
          ];
          while (true) {
            const parts = [
              collection(db, collName), ...jobFilter, ...dayFilters,
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

        const fetchPaged = async (collName) => {
          if (dayWindows.length === 0) return [];
          // Special-case single-day so we don't add a layer of overhead
          if (dayWindows.length === 1) {
            return fetchDay(collName, dayWindows[0][0], dayWindows[0][1]);
          }
          const all = [];
          for (let i = 0; i < dayWindows.length; i += MAX_PARALLEL) {
            const batch = dayWindows.slice(i, i + MAX_PARALLEL);
            const results = await Promise.all(
              batch.map(([s, e]) => fetchDay(collName, s, e))
            );
            for (const r of results) all.push(...r);
            if (all.length >= HARD_LIMIT) break;
          }
          return all.slice(0, HARD_LIMIT);
        };

        // dailyPay uses a string `date` field (YYYY-MM-DD), not Timestamp
        const startKey = dayKey(start);
        const endKey = dayKey(new Date(end.getTime() - 86400000));
        const qPay = jobId !== 'all'
          ? query(collection(db, 'dailyPay'), where('jobId', '==', jobId),
              where('date', '>=', startKey), where('date', '<=', endKey))
          : query(collection(db, 'dailyPay'),
              where('date', '>=', startKey), where('date', '<=', endKey));

        // allSettled so a missing index on one collection doesn't block the rest.
        const [sRes, eRes, aRes, pRes] = await Promise.allSettled([
          fetchPaged('scans'),
          fetchPaged('exceptions'),
          fetchPaged('ai-usage'),
          getDocs(qPay),
        ]);
        if (cancelled) return;

        const errors = [];
        const grab = (res, label, isSnap = false) => {
          if (res.status === 'fulfilled') {
            return isSnap ? res.value.docs.map((d) => ({ id: d.id, ...d.data() })) : res.value;
          }
          console.error(`Reports: ${label} query failed`, res.reason);
          errors.push(`${label}: ${res.reason?.message || res.reason}`);
          return [];
        };
        const sDocs = grab(sRes, 'scans');
        const eDocs = grab(eRes, 'exceptions');
        const aDocs = grab(aRes, 'ai-usage');
        const pDocs = grab(pRes, 'dailyPay', true);

        setScans(sDocs);
        setExceptions(eDocs);
        setAiUsage(aDocs);
        setPay(pDocs);
        if (sDocs.length >= HARD_LIMIT || eDocs.length >= HARD_LIMIT || aDocs.length >= HARD_LIMIT) {
          setTruncated(true);
        }
        if (errors.length) setLoadError(errors.join(' — '));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message || 'Load failed');
          toast('Load failed: ' + err.message, 'error');
        }
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, start, end, payRefreshKey]); // eslint-disable-line

  // ─── Derived metrics ───
  const metrics = useMemo(() => {
    const standardCount = scans.filter((s) => s.type === 'standard' && s.source !== 'manual' && s.source !== 'ai-match').length;
    const manualCount = scans.filter((s) => s.source === 'manual').length;
    const aiMatchCount = scans.filter((s) => s.source === 'ai-match').length;
    const loggedExceptionCount = scans.filter((s) => s.type === 'exception').length + exceptions.length;
    const exceptionUnits = manualCount + aiMatchCount + loggedExceptionCount;
    const totalUnits = standardCount + exceptionUnits;
    const revenue = standardCount * STANDARD_RATE + exceptionUnits * EXCEPTION_RATE;
    const aiCost = aiUsage.reduce((s, u) => s + (Number(u.costUsd) || 0), 0);
    const aiCalls = aiUsage.length;
    const labor = pay.reduce((s, p) => s + dailyPayTotal(p), 0);
    const margin = revenue - labor - aiCost;
    const exceptionRate = totalUnits ? (exceptionUnits / totalUnits) : 0;
    const aiUsageRate = totalUnits ? (aiCalls / totalUnits) : 0;
    return { standardCount, manualCount, aiMatchCount, loggedExceptionCount, exceptionUnits, totalUnits, revenue, aiCost, aiCalls, labor, margin, exceptionRate, aiUsageRate };
  }, [scans, exceptions, aiUsage, pay]);

  // ─── Daily breakdown for chart ───
  const daily = useMemo(() => {
    const byDay = new Map();
    const ensure = (k) => {
      if (!byDay.has(k)) byDay.set(k, { date: k, standard: 0, exceptions: 0, revenue: 0, aiCost: 0, labor: 0 });
      return byDay.get(k);
    };
    scans.forEach((s) => {
      const ts = s.timestamp?.toDate?.(); if (!ts) return;
      const row = ensure(dayKey(ts));
      const isException = s.type === 'exception' || s.source === 'manual' || s.source === 'ai-match';
      if (isException) { row.exceptions += 1; row.revenue += EXCEPTION_RATE; }
      else { row.standard += 1; row.revenue += STANDARD_RATE; }
    });
    exceptions.forEach((e) => {
      const ts = e.timestamp?.toDate?.(); if (!ts) return;
      const row = ensure(dayKey(ts));
      row.exceptions += 1; row.revenue += EXCEPTION_RATE;
    });
    aiUsage.forEach((u) => {
      const ts = u.timestamp?.toDate?.(); if (!ts) return;
      const row = ensure(dayKey(ts));
      row.aiCost += Number(u.costUsd) || 0;
    });
    pay.forEach((p) => {
      if (!p.date) return;
      const row = ensure(p.date);
      row.labor += dailyPayTotal(p);
    });
    return Array.from(byDay.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        ...r,
        revenue: Math.round(r.revenue * 100) / 100,
        aiCost: Math.round(r.aiCost * 100) / 100,
        labor: Math.round(r.labor * 100) / 100,
        margin: Math.round((r.revenue - r.aiCost - r.labor) * 100) / 100,
      }));
  }, [scans, exceptions, aiUsage, pay]);

  // ─── By-pod productivity ───
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

  // ─── By-operator productivity (chart-ready, top 15) ───
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

  // ─── AI usage per day (calls / cost / success) ───
  const aiDaily = useMemo(() => {
    const m = new Map();
    const ensure = (k) => {
      if (!m.has(k)) m.set(k, { date: k, calls: 0, successes: 0, cost: 0 });
      return m.get(k);
    };
    aiUsage.forEach((u) => {
      const ts = u.timestamp?.toDate?.(); if (!ts) return;
      const row = ensure(dayKey(ts));
      row.calls += 1;
      if (u.success) row.successes += 1;
      row.cost += Number(u.costUsd) || 0;
    });
    return Array.from(m.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ ...r, cost: Math.round(r.cost * 10000) / 10000, successRate: r.calls ? Math.round((r.successes / r.calls) * 100) : 0 }));
  }, [aiUsage]);

  // ─── Top performers ───
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
        <Kpi label="Total Units" value={fmtNum(metrics.totalUnits)} sub={`${fmtNum(metrics.standardCount)} std + ${fmtNum(metrics.exceptionUnits)} exc`} color="#3B82F6" />
        <Kpi label="Revenue" value={fmtMoney(metrics.revenue)} sub={`$0.50 / $0.85 rates`} color="#10B981" />
        <Kpi label="Labor Cost" value={fmtMoney(metrics.labor)} sub={pay.length ? `${pay.length} days logged` : 'No payroll logged'} color="#F59E0B" />
        <Kpi label="AI Cost" value={fmtMoney(metrics.aiCost)} sub={`${fmtNum(metrics.aiCalls)} calls · ${fmtNum(metrics.aiMatchCount)} assists`} color="#8B5CF6" />
        <Kpi label="Margin" value={fmtMoney(metrics.margin)} sub={metrics.revenue ? `${((metrics.margin / metrics.revenue) * 100).toFixed(1)}% of revenue` : '—'} color={metrics.margin >= 0 ? '#10B981' : '#EF4444'} />
        <Kpi label="Exception Rate" value={fmtPct(metrics.exceptionRate)} sub={`${fmtNum(metrics.exceptionUnits)} exception units`} color="#EC4899" />
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
        <h2 style={st.cardTitle}>Daily Productivity & Revenue</h2>
        {daily.length === 0 ? <p style={st.empty}>No scans in this range.</p> : (
          <div style={{ width: '100%', height: 340 }}>
            <ResponsiveContainer>
              <ComposedChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10B981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="date" stroke="#888" fontSize={12} />
                <YAxis yAxisId="units" stroke="#3B82F6" fontSize={12} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                <YAxis yAxisId="rev" orientation="right" stroke="#10B981" fontSize={12} tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`} />
                <Tooltip contentStyle={{ background: '#161616', border: '1px solid #333' }} formatter={(v, n) => n === 'Revenue $' ? fmtMoney(v) : fmtNum(v)} />
                <Legend />
                <Bar yAxisId="units" dataKey="standard" stackId="units" fill="#3B82F6" name="Standard" barSize={28} radius={[4, 4, 0, 0]} />
                <Bar yAxisId="units" dataKey="exceptions" stackId="units" fill="#EC4899" name="Exceptions" barSize={28} radius={[4, 4, 0, 0]} />
                <Area yAxisId="rev" type="monotone" dataKey="revenue" stroke="#10B981" strokeWidth={2.5} fill="url(#revGrad)" name="Revenue $" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Margin chart */}
      <div style={st.card}>
        <h2 style={st.cardTitle}>Daily Margin (Revenue − Labor − AI)</h2>
        {daily.length === 0 ? <p style={st.empty}>No data.</p> : (
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="date" stroke="#888" fontSize={12} />
                <YAxis stroke="#888" fontSize={12} />
                <Tooltip contentStyle={{ background: '#161616', border: '1px solid #333' }} />
                <Legend />
                <Line type="monotone" dataKey="revenue" stroke="#10B981" name="Revenue" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="labor" stroke="#F59E0B" name="Labor" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="aiCost" stroke="#8B5CF6" name="AI" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="margin" stroke="#3B82F6" name="Margin" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Two-column grid: By Operator + Top Performers */}
      <div style={st.twoCol}>
        <div style={st.card}>
          <h2 style={st.cardTitle}>By Operator (Top 15)</h2>
          {byOperator.length === 0 ? <p style={st.empty}>No operator data.</p> : (
            <div style={{ width: '100%', height: Math.max(280, byOperator.length * 28) }}>
              <ResponsiveContainer>
                <BarChart data={byOperator} layout="vertical" margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222" horizontal={false} />
                  <XAxis type="number" stroke="#888" fontSize={12} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                  <YAxis type="category" dataKey="operator" stroke="#888" fontSize={12} width={120} />
                  <Tooltip contentStyle={{ background: '#161616', border: '1px solid #333' }} formatter={(v) => fmtNum(v)} />
                  <Legend />
                  <Bar dataKey="standard" stackId="o" fill="#3B82F6" name="Standard" />
                  <Bar dataKey="exceptions" stackId="o" fill="#EC4899" name="Exceptions" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div style={st.card}>
          <h2 style={st.cardTitle}>Top Performers</h2>
          {topPerformers.length === 0 ? <p style={st.empty}>No operator data.</p> : (
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table style={st.table}>
                <thead>
                  <tr>
                    <th style={st.th}>#</th>
                    <th style={st.th}>Operator</th>
                    <th style={{ ...st.th, textAlign: 'right' }}>Scans</th>
                    <th style={{ ...st.th, textAlign: 'right' }}>% of total</th>
                  </tr>
                </thead>
                <tbody>
                  {topPerformers.map((p, i) => (
                    <tr key={p.name + i}>
                      <td style={st.td}>{i + 1}</td>
                      <td style={st.td}>{p.name}</td>
                      <td style={{ ...st.td, textAlign: 'right' }}>{fmtNum(p.count)}</td>
                      <td style={{ ...st.td, textAlign: 'right', color: '#888' }}>
                        {scans.length ? ((p.count / scans.length) * 100).toFixed(1) : '0.0'}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* AI daily trend */}
      <div style={st.card}>
        <h2 style={st.cardTitle}>AI Calls & Cost Per Day</h2>
        <p style={{ ...st.paySub, marginTop: -8, marginBottom: 12 }}>
          {fmtNum(metrics.aiCalls)} calls · {fmtNum(metrics.aiMatchCount)} resulted in AI-matched scans · {fmtMoney(metrics.aiCost)} total cost
        </p>
        {aiDaily.length === 0 ? <p style={st.empty}>No AI calls in this range.</p> : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <ComposedChart data={aiDaily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis dataKey="date" stroke="#888" fontSize={12} />
                <YAxis yAxisId="c" stroke="#8B5CF6" fontSize={12} />
                <YAxis yAxisId="$" orientation="right" stroke="#10B981" fontSize={12} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                <Tooltip contentStyle={{ background: '#161616', border: '1px solid #333' }} formatter={(v, n) => n === 'Cost $' ? fmtMoney(v) : fmtNum(v)} />
                <Legend />
                <Bar yAxisId="c" dataKey="calls" fill="#8B5CF6" name="Calls" barSize={24} radius={[4, 4, 0, 0]} />
                <Line yAxisId="$" type="monotone" dataKey="cost" stroke="#10B981" strokeWidth={2} name="Cost $" dot={false} />
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
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 20 },
  empty: { color: '#666', textAlign: 'center', padding: 24, fontSize: 13 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid #222', color: '#888', fontWeight: 600, fontSize: 12, textTransform: 'uppercase' },
  td: { padding: '10px 12px', borderBottom: '1px solid #181818' },
  footnote: { fontSize: 12, color: '#666', marginTop: 16, lineHeight: 1.6 },
};
