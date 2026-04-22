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

        {loadingDetail ? <p style={s.text}>Loading details...</p> : (
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
      {jobs.length === 0 ? (
        <p style={s.text}>No closed jobs found.</p>
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
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #111)', color: 'var(--text, #fff)', padding: '24px 16px', fontFamily: 'system-ui,sans-serif', maxWidth: 1000, margin: '0 auto' },
  title: { fontSize: 32, fontWeight: 800, margin: '8px 0 24px' },
  subtitle: { fontSize: 15, color: 'var(--text-secondary, #888)', marginBottom: 24 },
  text: { color: 'var(--text-secondary, #aaa)', fontSize: 16 },
  backLink: { color: 'var(--text-secondary, #666)', textDecoration: 'none', fontSize: 14 },
  backBtn: { background: 'none', border: 'none', color: 'var(--text-secondary, #666)', fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 12, minHeight: 32 },
  jobRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: 'var(--bg-card, #1a1a1a)', border: '1px solid var(--border, #333)', borderRadius: 12,
    padding: '16px 20px', cursor: 'pointer', textAlign: 'left', width: '100%',
  },
  statsRow: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 },
  statBox: { backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 10, padding: '16px 20px', flex: 1, minWidth: 120, textAlign: 'center', border: '1px solid var(--border, #333)' },
  statVal: { fontSize: 28, fontWeight: 800, color: 'var(--text, #fff)' },
  statLbl: { fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 4 },
  card: { backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 12, padding: 20, border: '1px solid var(--border, #333)', marginBottom: 16 },
  cardTitle: { fontSize: 16, fontWeight: 700, color: 'var(--text-secondary, #ccc)', marginTop: 0, marginBottom: 16 },
  miniStat: { textAlign: 'center', flex: 1, color: 'var(--text, #fff)', fontSize: 18 },
  miniLbl: { fontSize: 12, color: 'var(--text-secondary, #888)' },
  exportBtn: {
    padding: '14px 28px', borderRadius: 8, border: '1px solid var(--accent, #3B82F6)',
    backgroundColor: 'var(--bg-input, #1e3a5f)', color: 'var(--text, #fff)', fontSize: 16, fontWeight: 600, cursor: 'pointer',
    marginTop: 8,
  },
};
