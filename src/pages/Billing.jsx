import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Receipt, Download, Calendar } from 'lucide-react';
import { db } from '../firebase';
import {
  collection, doc, getDoc, getDocs, setDoc, query, where,
  Timestamp, serverTimestamp,
} from 'firebase/firestore';
import { exportBillingXLSX, downloadBlob } from '../utils/export';
import { logAudit } from '../utils/audit';
import { useToast } from '../components/Toast';
import { useAuth } from '../contexts/AuthContext';

/**
 * Standalone billing page — works for ANY job (active or closed).
 *
 * Existed previously only on Dashboard, which short-circuits when no job is
 * active. That blocked operators from billing a closed job (e.g. the prior
 * week's final invoice).
 */
export default function Billing() {
  const { show: toast } = useToast();
  const { currentUser } = useAuth();
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
  const [refreshKey, setRefreshKey] = useState(0);

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
  }, [selectedJobId, refreshKey]);

  // Snap any picked date to the Monday of that week so the export window is
  // always Mon–Sun. Prevents silent date-range drift when picking a Tue/Wed/etc.
  const snapToMonday = (isoDate) => {
    const d = new Date(isoDate + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return isoDate;
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const onBillingWeekChange = (v) => {
    const snapped = snapToMonday(v);
    if (snapped !== v) toast(`Snapped to week starting Monday ${snapped}`, 'info');
    setBillingWeek(snapped);
  };

  const selectedJob = jobs.find((j) => j.id === selectedJobId);
  const weekStartDate = new Date(billingWeek + 'T00:00:00');
  const weekEndDate = new Date(weekStartDate.getTime() + 7 * 86400000);

  const handleBillingExport = async () => {
    if (!selectedJob) { toast('Pick a job first', 'error'); return; }
    const weekStart = weekStartDate;
    const weekEnd = weekEndDate;

    // Deterministic doc id prevents accidental duplicate invoices for the same week.
    const weekKey = billingWeek; // YYYY-MM-DD (already snapped to Monday)
    const reportId = `${selectedJob.id}_${weekKey}`;
    const reportRef = doc(db, 'billing-reports', reportId);

    setExporting(true);
    try {
      // Check for existing report and confirm overwrite
      const existing = await getDoc(reportRef);
      if (existing.exists()) {
        const e = existing.data();
        const by = e.createdBy?.name || e.createdBy?.email || 'unknown';
        const when = e.createdAt?.toDate?.()?.toLocaleString?.() || 'earlier';
        const ok = window.confirm(
          `A billing report for ${weekStart.toLocaleDateString()} – ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString()} already exists.\n\n` +
          `Created by: ${by}\nCreated at: ${when}\nTotal: $${(e.totalAmount || 0).toFixed(2)} (${e.totalUnits || 0} units)\n\n` +
          `OVERWRITE this existing report with a fresh export?`
        );
        if (!ok) { setExporting(false); return; }
      }

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
      const standardCount = scans.filter((s) => s.type === 'standard' && s.source !== 'manual' && s.source !== 'ai-match').length;
      const manualCount = scans.filter((s) => s.source === 'manual').length;
      const aiMatchCount = scans.filter((s) => s.source === 'ai-match').length;
      const loggedExceptionCount = scans.filter((s) => s.type === 'exception').length + excs.length;
      const exceptionCount = manualCount + aiMatchCount + loggedExceptionCount;
      const totalAmount = standardCount * 0.50 + exceptionCount * 0.85;
      const { buf, fileName } = exportBillingXLSX(scans, excs, selectedJob.meta, weekStart, weekEnd);

      // Auto-download for the operator
      downloadBlob(buf, fileName);

      // Use chunked base64 conversion to avoid stack-overflow on large buffers
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const base64 = btoa(bin);

      // Firestore doc limit is 1 MiB. Base64 inflates by ~33%, so warn if the
      // serialized report would not fit. Don't silently truncate.
      const approxDocBytes = base64.length + 2048; // base64 + metadata overhead
      const FIRESTORE_DOC_LIMIT = 1_048_576;
      const tooLarge = approxDocBytes > FIRESTORE_DOC_LIMIT * 0.95;
      if (tooLarge) {
        const ok = window.confirm(
          `This week's XLSX is ${(approxDocBytes / 1024).toFixed(0)} KB which exceeds Firestore's 1 MiB document limit.\n\n` +
          `The file has already been downloaded to your computer. ` +
          `If you continue, the report metadata (totals, who/when) will be saved but the file blob will NOT be stored — the customer portal will show the totals but not have a re-download link.\n\n` +
          `Continue?`
        );
        if (!ok) { setExporting(false); return; }
      }

      // Deterministic write
      await setDoc(reportRef, {
        jobId: selectedJob.id,
        jobName: selectedJob.meta?.name || 'Unknown',
        weekStart: Timestamp.fromDate(weekStart),
        weekEnd: Timestamp.fromDate(weekEnd),
        weekKey,
        standardCount,
        exceptionCount,
        manualCount,
        aiMatchCount,
        loggedExceptionCount,
        totalUnits: standardCount + exceptionCount,
        totalAmount,
        fileName,
        fileData: tooLarge ? null : base64,
        fileOmitted: tooLarge,
        createdBy: {
          id: currentUser?.id || null,
          name: currentUser?.name || null,
          email: currentUser?.email || null,
          role: currentUser?.role || null,
        },
        createdAt: serverTimestamp(),
      });

      logAudit('billing.export', {
        jobId: selectedJob.id,
        reportId,
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        scans: scans.length,
        exceptions: excs.length,
        totalAmount,
        overwrote: existing.exists(),
        fileOmitted: tooLarge,
      });
      toast(`Billed ${standardCount + exceptionCount} units · $${totalAmount.toFixed(2)}`, 'success');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error('Billing export failed', err);
      toast('Billing export failed: ' + err.message, 'error');
    }
    setExporting(false);
  };

  // Permanent deletion is intentionally not exposed in the client. Firestore
  // rules block all deletes on billing-reports; an admin must remove via the
  // Firebase console. This is deliberate after the portal incident where an
  // unrestricted delete button caused a week's report to vanish.

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

  if (loading) return (
    <div style={{ ...st.container, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div className="spinner spinner-lg" />
    </div>
  );

  return (
    <div style={st.container} className="page-enter">
      <Link to="/" style={st.backLink}>← Back to Home</Link>
      <h1 style={st.title}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}><Receipt size={24} /> Billing</span></h1>
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
        <input type="date" value={billingWeek} onChange={(e) => onBillingWeekChange(e.target.value)} style={st.input} />
        <p style={st.hint}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Calendar size={13} /> {weekStartDate.toLocaleDateString()} – {new Date(weekEndDate.getTime() - 86400000).toLocaleDateString()} (Mon–Sun)</span>
        </p>

        <button onClick={handleBillingExport} disabled={exporting || !selectedJob}
          style={{ ...st.primaryBtn, opacity: exporting || !selectedJob ? 0.5 : 1, cursor: exporting || !selectedJob ? 'not-allowed' : 'pointer' }}>
          {exporting ? 'Generating…' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={15} /> Generate Billing Export</span>}
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
              const createdBy = r.createdBy?.name || r.createdBy?.email || (r.createdBy ? 'unknown' : 'legacy');
              const createdAt = r.createdAt?.toDate?.()?.toLocaleString?.() || '—';
              return (
                <div key={r.id} style={st.reportRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>{ws} – {we}</div>
                    <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                      {r.standardCount} standard · {r.exceptionCount} exceptions · ${r.totalAmount?.toFixed?.(2) || '?'}
                    </div>
                    <div style={{ color: '#666', fontSize: 11, marginTop: 4 }}>
                      Exported by {createdBy} · {createdAt}
                      {r.fileOmitted && <span style={{ color: '#F59E0B' }}> · file too large to store — re-export to download</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => downloadReport(r)} disabled={!r.fileData}
                      style={{ ...st.downloadBtn, opacity: r.fileData ? 1 : 0.4, cursor: r.fileData ? 'pointer' : 'not-allowed' }}
                      title={r.fileData ? 'Download XLSX' : 'File not stored — re-export to download'}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={14} /> Download</span>
                    </button>
                  </div>
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
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #0a0a0a)', color: 'var(--text, #fff)', padding: 'clamp(12px, 3vw, 24px)', maxWidth: 720, margin: '0 auto', fontFamily: 'var(--font-sans)' },
  backLink: { color: 'var(--text-secondary, #888)', textDecoration: 'none', fontSize: 14, fontWeight: 600 },
  title: { fontSize: 28, marginTop: 12, marginBottom: 4 },
  subtitle: { color: 'var(--text-secondary, #888)', fontSize: 14, marginTop: 0, marginBottom: 24 },
  text: { color: 'var(--text-secondary, #aaa)', fontSize: 14 },
  card: { background: 'linear-gradient(180deg, var(--bg-elev), var(--bg-card))', border: '1px solid var(--border, #333)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16, boxShadow: 'var(--shadow-card)' },
  label: { display: 'block', color: 'var(--text-secondary, #ccc)', fontSize: 13, fontWeight: 600, marginBottom: 6 },
  input: { width: '100%', padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #0a0a0a)', color: 'var(--text, #fff)', fontSize: 15, boxSizing: 'border-box' },
  hint: { color: 'var(--text-secondary, #888)', fontSize: 12, marginTop: 6, marginBottom: 0 },
  primaryBtn: { width: '100%', marginTop: 18, padding: '14px 20px', borderRadius: 'var(--radius-md)', border: 'none', backgroundColor: 'var(--accent)', color: 'var(--accent-contrast)', fontSize: 16, fontWeight: 700 },
  sectionTitle: { color: 'var(--text, #fff)', fontSize: 16, marginTop: 0, marginBottom: 12 },
  reportRow: { display: 'flex', alignItems: 'center', gap: 10, padding: 12, backgroundColor: 'var(--bg-subtle, #0f0f0f)', border: '1px solid var(--border, #2a2a2a)', borderRadius: 'var(--radius-sm)' },
  downloadBtn: { padding: '8px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--accent)', backgroundColor: 'transparent', color: 'var(--accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
