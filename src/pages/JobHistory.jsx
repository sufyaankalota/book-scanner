import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, getDocs, query, where, orderBy, Timestamp,
} from 'firebase/firestore';
import { downloadBlob } from '../utils/export';
import * as XLSX from 'xlsx';

export default function JobHistory() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState(null);
  const [jobScans, setJobScans] = useState([]);
  const [jobShifts, setJobShifts] = useState([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [viewMode, setViewMode] = useState('list'); // list | detail | trends

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'jobs'), where('meta.active', '==', false)));
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            const ta = a.meta.closedAt?.toDate?.() || new Date(0);
            const tb = b.meta.closedAt?.toDate?.() || new Date(0);
            return tb - ta;
          });
        setJobs(list);
      } catch (err) {
        console.error('Failed to load jobs:', err);
      }
      setLoading(false);
    })();
  }, []);

  const loadJobDetail = async (job) => {
    setSelectedJob(job);
    setViewMode('detail');
    setLoadingDetail(true);
    try {
      const scanSnap = await getDocs(query(collection(db, 'scans'), where('jobId', '==', job.id)));
      setJobScans(scanSnap.docs.map((d) => ({ id: d.id, ...d.data() })));

      const shiftSnap = await getDocs(query(collection(db, 'shifts'), where('jobId', '==', job.id)));
      setJobShifts(shiftSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error(err);
    }
    setLoadingDetail(false);
  };

  // Multi-day trends
  const trendData = useMemo(() => {
    if (!jobScans.length) return [];
    const byDay = {};
    for (const s of jobScans) {
      const d = s.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      byDay[key] = (byDay[key] || 0) + 1;
    }
    return Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }));
  }, [jobScans]);

  // Labor efficiency
  const laborMetrics = useMemo(() => {
    if (!jobShifts.length || !jobScans.length) return null;
    let totalHours = 0;
    for (const s of jobShifts) {
      if (s.startTime && s.endTime) {
        const start = s.startTime.toDate ? s.startTime.toDate() : new Date(s.startTime);
        const end = s.endTime.toDate ? s.endTime.toDate() : new Date(s.endTime);
        totalHours += (end - start) / 3600000;
      }
    }
    return {
      totalShifts: jobShifts.length,
      totalHours: totalHours.toFixed(1),
      scansPerHour: totalHours > 0 ? Math.round(jobScans.length / totalHours) : 0,
      totalScans: jobScans.length,
    };
  }, [jobShifts, jobScans]);

  const maxTrend = trendData.length ? Math.max(...trendData.map((d) => d.count)) : 1;

  // Week-over-week comparison
  const weeklyComparison = useMemo(() => {
    if (trendData.length < 2) return null;
    const weeks = {};
    for (const d of trendData) {
      const date = new Date(d.date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      if (!weeks[key]) weeks[key] = { total: 0, days: 0, label: key };
      weeks[key].total += d.count;
      weeks[key].days++;
    }
    const sorted = Object.values(weeks).sort((a, b) => a.label.localeCompare(b.label));
    if (sorted.length < 2) return null;
    const result = sorted.map((w, i) => {
      const avg = Math.round(w.total / w.days);
      const prevAvg = i > 0 ? Math.round(sorted[i - 1].total / sorted[i - 1].days) : null;
      const change = prevAvg ? Math.round(((avg - prevAvg) / prevAvg) * 100) : null;
      return { ...w, avg, change };
    });
    return result;
  }, [trendData]);

  // Operator breakdown
  const operatorBreakdown = useMemo(() => {
    if (!jobScans.length) return [];
    const byOp = {};
    for (const s of jobScans) {
      if (!s.scannerId) continue;
      if (!byOp[s.scannerId]) byOp[s.scannerId] = { scans: 0, exceptions: 0 };
      byOp[s.scannerId].scans++;
      if (s.type === 'exception') byOp[s.scannerId].exceptions++;
    }
    return Object.entries(byOp)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.scans - a.scans);
  }, [jobScans]);

  const handleExportJob = () => {
    if (!selectedJob || !jobScans.length) return;
    const wb = XLSX.utils.book_new();
    const data = jobScans.map((s) => ({
      ISBN: s.isbn, PO: s.poName || '', Pod: s.podId, Scanner: s.scannerId,
      Type: s.type, Timestamp: s.timestamp?.toDate?.()?.toLocaleString() || '',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Scans');
    if (trendData.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendData), 'Daily Trend');
    }
    if (laborMetrics) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([laborMetrics]), 'Labor');
    }
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, `${selectedJob.meta.name}_history.xlsx`);
  };

  if (loading) return <div style={s.container}><p style={s.text}>Loading...</p></div>;

  // Detail view
  if (viewMode === 'detail' && selectedJob) {
    return (
      <div style={s.container}>
        <button onClick={() => { setViewMode('list'); setSelectedJob(null); }} style={s.backBtn}>← Back to Job List</button>
        <h1 style={s.title}>{selectedJob.meta.name}</h1>
        <p style={s.subtitle}>
          {selectedJob.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} · 
          Target: {selectedJob.meta.dailyTarget?.toLocaleString()} ·
          Closed: {selectedJob.meta.closedAt?.toDate?.()?.toLocaleDateString() || 'Unknown'}
        </p>

        {loadingDetail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
            <div className="skeleton" style={{ height: 80 }}></div>
            <div className="skeleton" style={{ height: 140 }}></div>
            <div className="skeleton" style={{ height: 100 }}></div>
            <p style={{ ...s.text, textAlign: 'center', color: '#666' }}>Loading scans, shifts, and trends…</p>
          </div>
        ) : (
          <>
            {/* Summary */}
            <div style={s.statsRow}>
              <div style={s.statBox}>
                <div style={s.statVal}>{jobScans.length.toLocaleString()}</div>
                <div style={s.statLbl}>Total Scans</div>
              </div>
              <div style={s.statBox}>
                <div style={s.statVal}>{jobScans.filter((x) => x.type === 'exception').length}</div>
                <div style={s.statLbl}>Exceptions</div>
              </div>
              <div style={s.statBox}>
                <div style={s.statVal}>{trendData.length}</div>
                <div style={s.statLbl}>Days Active</div>
              </div>
              {laborMetrics && (
                <div style={s.statBox}>
                  <div style={s.statVal}>{laborMetrics.scansPerHour}</div>
                  <div style={s.statLbl}>Scans/Labor Hr</div>
                </div>
              )}
            </div>

            {/* Trends chart */}
            {trendData.length > 1 && (
              <div style={s.card}>
                <h3 style={s.cardTitle}>Daily Scan Volume</h3>
                <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 120, padding: '0 8px' }}>
                  {trendData.map((d) => (
                    <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ fontSize: 10, color: '#888', marginBottom: 4 }}>{d.count}</div>
                      <div style={{
                        width: '100%', maxWidth: 40,
                        height: `${(d.count / maxTrend) * 100}%`, minHeight: 4,
                        backgroundColor: '#3B82F6', borderRadius: '4px 4px 0 0',
                      }} />
                      <div style={{ fontSize: 9, color: '#666', marginTop: 4, transform: 'rotate(-45deg)', whiteSpace: 'nowrap' }}>
                        {d.date.slice(5)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Labor efficiency */}
            {laborMetrics && (
              <div style={s.card}>
                <h3 style={s.cardTitle}>Labor Efficiency</h3>
                <div style={s.statsRow}>
                  <div style={s.miniStat}><strong>{laborMetrics.totalShifts}</strong><br /><span style={s.miniLbl}>Shifts</span></div>
                  <div style={s.miniStat}><strong>{laborMetrics.totalHours}h</strong><br /><span style={s.miniLbl}>Labor Hours</span></div>
                  <div style={s.miniStat}><strong>{laborMetrics.scansPerHour}</strong><br /><span style={s.miniLbl}>Scans/Hr</span></div>
                </div>
              </div>
            )}

            {/* Week-over-week comparison */}
            {weeklyComparison && weeklyComparison.length > 1 && (
              <div style={s.card}>
                <h3 style={s.cardTitle}>📈 Week-over-Week Comparison</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {weeklyComparison.map((w) => (
                    <div key={w.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #222' }}>
                      <span style={{ color: '#888', fontSize: 13, minWidth: 90 }}>Week of {w.label.slice(5)}</span>
                      <span style={{ color: '#fff', fontWeight: 700, minWidth: 60 }}>{w.total.toLocaleString()}</span>
                      <span style={{ color: '#888', fontSize: 12 }}>({w.avg}/day avg)</span>
                      {w.change !== null && (
                        <span style={{ fontSize: 13, fontWeight: 700, color: w.change >= 0 ? '#22C55E' : '#EF4444', marginLeft: 'auto' }}>
                          {w.change >= 0 ? '▲' : '▼'} {Math.abs(w.change)}%
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Operator breakdown */}
            {operatorBreakdown.length > 0 && (
              <div style={s.card}>
                <h3 style={s.cardTitle}>👥 Operator Breakdown</h3>
                {operatorBreakdown.map((op, i) => (
                  <div key={op.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #222' }}>
                    <span style={{ color: i === 0 ? '#EAB308' : '#888', fontSize: 14, width: 24, textAlign: 'center', fontWeight: 700 }}>
                      {i + 1}
                    </span>
                    <span style={{ flex: 1, color: '#ddd', fontSize: 15, fontWeight: 600 }}>{op.name}</span>
                    <span style={{ fontFamily: 'monospace', color: '#fff', fontWeight: 700 }}>{op.scans.toLocaleString()}</span>
                    {op.exceptions > 0 && (
                      <span style={{ fontSize: 11, color: '#F97316', backgroundColor: '#7f1d1d', padding: '1px 6px', borderRadius: 4 }}>
                        {op.exceptions} exc
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button onClick={handleExportJob} style={s.exportBtn}>📥 Export Job Data</button>
          </>
        )}
      </div>
    );
  }

  // Job list
  return (
    <div style={s.container}>
      <Link to="/" style={s.backLink}>← Back to Home</Link>
      <h1 style={s.title}>Job History</h1>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[1,2,3].map((i) => <div key={i} className="skeleton" style={{ height: 70 }}></div>)}
        </div>
      ) : jobs.length === 0 ? (
        <div style={{ ...s.card, textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📁</div>
          <p style={{ ...s.text, marginBottom: 8, fontSize: 16, color: '#aaa' }}>No closed jobs yet</p>
          <p style={{ ...s.text, fontSize: 13 }}>Closed jobs will appear here. Active jobs are managed in <Link to="/setup" style={{ color: '#3B82F6' }}>Setup</Link>.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {jobs.map((j) => (
            <button key={j.id} onClick={() => loadJobDetail(j)} style={s.jobRow}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>{j.meta.name}</div>
                <div style={{ fontSize: 13, color: '#888' }}>
                  {j.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'} · 
                  Target: {j.meta.dailyTarget?.toLocaleString()} ·
                  {j.meta.location ? ` ${j.meta.location} ·` : ''}
                  Closed: {j.meta.closedAt?.toDate?.()?.toLocaleDateString() || '—'}
                </div>
              </div>
              <span style={{ color: '#666', fontSize: 20 }}>→</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', padding: '24px 20px', fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif", maxWidth: 900, margin: '0 auto' },
  title: { fontSize: 26, fontWeight: 800, margin: '8px 0 20px', letterSpacing: '-0.3px' },
  subtitle: { fontSize: 14, color: 'var(--text-secondary, #666)', marginBottom: 20 },
  text: { color: 'var(--text-secondary, #888)', fontSize: 14 },
  backLink: { color: 'var(--text-secondary, #555)', textDecoration: 'none', fontSize: 13, fontWeight: 600 },
  backBtn: { background: 'none', border: 'none', color: 'var(--text-secondary, #555)', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12, minHeight: 32, fontWeight: 600 },
  jobRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: 'var(--bg-card, #161616)', border: '1px solid var(--border, #222)', borderRadius: 12,
    padding: '14px 18px', cursor: 'pointer', textAlign: 'left', width: '100%',
  },
  statsRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 },
  statBox: { backgroundColor: 'var(--bg-card, #161616)', borderRadius: 10, padding: '14px 18px', flex: 1, minWidth: 100, textAlign: 'center', border: '1px solid var(--border, #222)' },
  statVal: { fontSize: 24, fontWeight: 800, color: 'var(--text, #f0f0f0)', letterSpacing: '-0.5px' },
  statLbl: { fontSize: 10, color: 'var(--text-secondary, #666)', marginTop: 4, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.3px' },
  card: { backgroundColor: 'var(--bg-card, #161616)', borderRadius: 12, padding: '18px 20px', border: '1px solid var(--border, #222)', marginBottom: 14 },
  cardTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-secondary, #aaa)', marginTop: 0, marginBottom: 14, letterSpacing: '-0.2px' },
  miniStat: { textAlign: 'center', flex: 1, color: 'var(--text, #f0f0f0)', fontSize: 16, fontWeight: 700 },
  miniLbl: { fontSize: 11, color: 'var(--text-secondary, #666)' },
  exportBtn: {
    padding: '12px 24px', borderRadius: 8, border: '1px solid rgba(59,130,246,0.3)',
    backgroundColor: 'rgba(59,130,246,0.06)', color: '#93c5fd', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    marginTop: 8,
  },
};
