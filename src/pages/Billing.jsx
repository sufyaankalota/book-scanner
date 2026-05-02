import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, getDoc, getDocs, addDoc, query, where, orderBy,
  Timestamp, serverTimestamp,
} from 'firebase/firestore';
import { exportBillingXLSX, downloadBlob } from '../utils/export';
import { logAudit } from '../utils/audit';
import { useToast } from '../components/Toast';

/**
 * Standalone billing page — works for ANY job (active or closed).
 *
 * Existed previously only on Dashboard, which short-circuits when no job is
 * active. That blocked operators from billing a closed job (e.g. the prior
 * week's final invoice).
 */
export default function Billing() {
  const { show: toast } = useToast();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [billingWeek, setBillingWeek] = useState(() => {
    // Default to last Monday
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
    return d.toISOString().slice(0, 10);
  });
  const [exporting, setExporting] = useState(false);
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);

  // Load all jobs (active + closed)
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'jobs'));
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            // Active first, then most-recently-closed
            if (a.meta?.active !== b.meta?.active) return a.meta?.active ? -1 : 1;
            const ta = a.meta?.closedAt?.toDate?.() || a.meta?.createdAt?.toDate?.() || new Date(0);
            const tb = b.meta?.closedAt?.toDate?.() || b.meta?.createdAt?.toDate?.() || new Date(0);
            return tb - ta;
          });
        setJobs(list);
        const active = list.find((j) => j.meta?.active);
        if (active) setSelectedJobId(active.id);
        else if (list.length) setSelectedJobId(list[0].id);
      } catch (err) {
        toast('Failed to load jobs: ' + err.message, 'error');
      }
      setLoading(false);
    })();
  }, []); // eslint-disable-line

  // Load existing billing reports for the selected job
  useEffect(() => {
    if (!selectedJobId) { setReports([]); return; }
    setLoadingReports(true);
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'billing-reports'),
          where('jobId', '==', selectedJobId),
        ));
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            const ta = a.weekStart?.toDate?.() || new Date(0);
            const tb = b.weekStart?.toDate?.() || new Date(0);
            return tb - ta;
          });
        setReports(list);
      } catch (err) {
        console.error(err);
      }
      setLoadingReports(false);
    })();
  }, [selectedJobId, exporting]);

  const selectedJob = jobs.find((j) => j.id === selectedJobId);
  const weekStartDate = new Date(billingWeek + 'T00:00:00');
  const weekEndDate = new Date(weekStartDate.getTime() + 7 * 86400000);

  const handleBillingExport = async () => {
    if (!selectedJob) { toast('Pick a job first', 'error'); return; }
    setExporting(true);
    try {
      const weekStart = weekStartDate;
      const weekEnd = weekEndDate;
      const q1 = query(collection(db, 'scans'), where('jobId', '==', selectedJob.id),
        where('timestamp', '>=', Timestamp.fromDate(weekStart)),
        where('timestamp', '<', Timestamp.fromDate(weekEnd)));
      const q2 = query(collection(db, 'exceptions'), where('jobId', '==', selectedJob.id),
        where('timestamp', '>=', Timestamp.fromDate(weekStart)),
        where('timestamp', '<', Timestamp.fromDate(weekEnd)));
      const [scanSnap, excSnap] = await Promise.all([getDocs(q1), getDocs(q2)]);
      const scans = scanSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const excs = excSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (scans.length === 0 && excs.length === 0) {
        toast('No scans or exceptions in this week — nothing to bill.', 'error');
        setExporting(false);
        return;
      }
      const standardCount = scans.filter((s) => s.type === 'standard' && s.source !== 'manual').length;
      const exceptionCount = scans.filter((s) => s.type === 'exception' || s.source === 'manual').length + excs.length;
      const totalAmount = standardCount * 0.40 + exceptionCount * 0.60;
      const { buf, fileName } = exportBillingXLSX(scans, excs, selectedJob.meta, weekStart, weekEnd);

      // Auto-download for the operator
      downloadBlob(buf, fileName);

      // Save report to Firestore (so it shows up in Customer Portal too)
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      await addDoc(collection(db, 'billing-reports'), {
        jobId: selectedJob.id,
        jobName: selectedJob.meta?.name || 'Unknown',
        weekStart: Timestamp.fromDate(weekStart),
        weekEnd: Timestamp.fromDate(weekEnd),
        standardCount,
        exceptionCount,
        totalUnits: standardCount + exceptionCount,
        totalAmount,
        fileName,
        fileData: base64,
        createdAt: serverTimestamp(),
      });
      logAudit('billing_export', {
        jobId: selectedJob.id,
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        scans: scans.length,
        exceptions: excs.length,
      });
      toast(`Billed ${standardCount + exceptionCount} units`, 'success');
    } catch (err) {
      toast('Billing export failed: ' + err.message, 'error');
    }
    setExporting(false);
  };

  const downloadReport = (r) => {
    try {
      const bin = atob(r.fileData);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBlob(blob, r.fileName);
    } catch (err) {
      toast('Download failed: ' + err.message, 'error');
    }
  };

  if (loading) return <div style={st.container}><p style={st.text}>Loading...</p></div>;

  return (
    <div style={st.container}>
      <Link to="/" style={st.backLink}>← Back to Home</Link>
      <h1 style={st.title}>💰 Billing</h1>
      <p style={st.subtitle}>Export weekly billing for any job — active or closed.</p>

      {/* Job picker */}
      <div style={st.card}>
        <label style={st.label}>Job</label>
        <select value={selectedJobId} onChange={(e) => setSelectedJobId(e.target.value)} style={st.input}>
          {jobs.length === 0 && <option value="">No jobs found</option>}
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.meta?.active ? '🟢 ' : '⏹️ '}
              {j.meta?.name || 'Unnamed'}
              {!j.meta?.active && j.meta?.closedAt?.toDate ? ` (closed ${j.meta.closedAt.toDate().toLocaleDateString()})` : ''}
            </option>
          ))}
        </select>

        {selectedJob && (
          <p style={st.hint}>
            {selectedJob.meta?.mode === 'multi' ? 'Multi-PO' : 'Single PO'}
            {selectedJob.meta?.location && ` · ${selectedJob.meta.location}`}
            {!selectedJob.meta?.active && ' · Closed'}
          </p>
        )}

        <label style={{ ...st.label, marginTop: 18 }}>Week starting (Monday)</label>
        <input type="date" value={billingWeek} onChange={(e) => setBillingWeek(e.target.value)} style={st.input} />
        <p style={st.hint}>
          📅 {weekStartDate.toLocaleDateString()} – {new Date(weekEndDate.getTime() - 86400000).toLocaleDateString()} (7 days)
        </p>

        <button onClick={handleBillingExport} disabled={exporting || !selectedJob}
          style={{ ...st.primaryBtn, opacity: exporting || !selectedJob ? 0.5 : 1, cursor: exporting || !selectedJob ? 'not-allowed' : 'pointer' }}>
          {exporting ? '⏳ Generating...' : '📥 Generate Billing Export'}
        </button>
      </div>

      {/* Existing reports */}
      <div style={st.card}>
        <h2 style={st.sectionTitle}>Past billing reports {selectedJob ? `for ${selectedJob.meta?.name || ''}` : ''}</h2>
        {loadingReports && <p style={st.text}>Loading…</p>}
        {!loadingReports && reports.length === 0 && (
          <p style={st.text}>No billing reports yet for this job.</p>
        )}
        {!loadingReports && reports.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {reports.map((r) => {
              const ws = r.weekStart?.toDate?.()?.toLocaleDateString?.() || '?';
              const we = r.weekEnd?.toDate ? new Date(r.weekEnd.toDate().getTime() - 86400000).toLocaleDateString() : '?';
              return (
                <div key={r.id} style={st.reportRow}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>{ws} – {we}</div>
                    <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                      {r.standardCount} standard · {r.exceptionCount} exceptions · ${r.totalAmount?.toFixed?.(2) || '?'}
                    </div>
                  </div>
                  <button onClick={() => downloadReport(r)} style={st.downloadBtn}>
                    📥 Download
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const st = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0a0a0a)', color: '#fff', padding: 'clamp(12px, 3vw, 24px)', maxWidth: 720, margin: '0 auto', fontFamily: "system-ui, -apple-system, sans-serif" },
  backLink: { color: '#888', textDecoration: 'none', fontSize: 14, fontWeight: 600 },
  title: { fontSize: 28, marginTop: 12, marginBottom: 4 },
  subtitle: { color: '#888', fontSize: 14, marginTop: 0, marginBottom: 24 },
  text: { color: '#aaa', fontSize: 14 },
  card: { backgroundColor: 'var(--bg-card, #1a1a1a)', border: '1px solid var(--border, #333)', borderRadius: 12, padding: 20, marginBottom: 16 },
  label: { display: 'block', color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 6 },
  input: { width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #444', backgroundColor: '#0a0a0a', color: '#fff', fontSize: 15, boxSizing: 'border-box' },
  hint: { color: '#888', fontSize: 12, marginTop: 6, marginBottom: 0 },
  primaryBtn: { width: '100%', marginTop: 18, padding: '14px 20px', borderRadius: 10, border: 'none', backgroundColor: '#22C55E', color: '#fff', fontSize: 16, fontWeight: 700 },
  sectionTitle: { color: '#fff', fontSize: 16, marginTop: 0, marginBottom: 12 },
  reportRow: { display: 'flex', alignItems: 'center', gap: 10, padding: 12, backgroundColor: '#0f0f0f', border: '1px solid #2a2a2a', borderRadius: 8 },
  downloadBtn: { padding: '8px 14px', borderRadius: 6, border: '1px solid #22C55E', backgroundColor: 'transparent', color: '#22C55E', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
