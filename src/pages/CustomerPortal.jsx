import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDocs, getDoc, addDoc,
  query, where, onSnapshot, Timestamp, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { parseManifestFile } from '../utils/manifest';
import { downloadBlob } from '../utils/export';
import * as XLSX from 'xlsx';

const DEFAULT_COLORS = [
  '#EF4444', '#3B82F6', '#EAB308', '#22C55E', '#F97316',
  '#A855F7', '#EC4899', '#14B8A6', '#6366F1', '#84CC16',
];

export default function CustomerPortal() {
  const [job, setJob] = useState(null);
  const [allScans, setAllScans] = useState([]);
  const [allExceptions, setAllExceptions] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [bols, setBols] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  // PO Upload
  const [manifest, setManifest] = useState(null);
  const [poNames, setPoNames] = useState([]);
  const [fileError, setFileError] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');

  // BOL Upload
  const [bolFile, setBolFile] = useState(null);
  const [bolDate, setBolDate] = useState(new Date().toISOString().slice(0, 10));
  const [bolTruckId, setBolTruckId] = useState('');
  const [bolNotes, setBolNotes] = useState('');
  const [bolUploading, setBolUploading] = useState(false);

  // Load active job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const d = snap.docs[0];
        setJob({ id: d.id, ...d.data() });
      } else setJob(null);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Scans
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'scans'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setAllScans(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [job]);

  // Exceptions
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'exceptions'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setAllExceptions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [job]);

  // Shifts
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'shifts'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setShifts(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, [job]);

  // BOLs
  useEffect(() => {
    if (!job) return;
    const q = query(collection(db, 'bols'), where('jobId', '==', job.id));
    const unsub = onSnapshot(q, (snap) => {
      setBols(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')));
    });
    return unsub;
  }, [job]);

  // ─── Computed Data ───
  const dailyBreakdown = useMemo(() => {
    const byDay = {};
    for (const s of allScans) {
      const d = s.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = { scans: 0, exceptions: 0 };
      byDay[key].scans++;
      if (s.type === 'exception') byDay[key].exceptions++;
    }
    for (const ex of allExceptions) {
      const d = ex.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = { scans: 0, exceptions: 0 };
      byDay[key].exceptions++;
    }
    return Object.entries(byDay)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, data]) => ({ date, ...data }));
  }, [allScans, allExceptions]);

  const weeklyBreakdown = useMemo(() => {
    const weeks = {};
    for (const s of allScans) {
      const d = s.timestamp?.toDate?.();
      if (!d) continue;
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      if (!weeks[key]) weeks[key] = { scans: 0, exceptions: 0 };
      weeks[key].scans++;
      if (s.type === 'exception') weeks[key].exceptions++;
    }
    return Object.entries(weeks)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([weekOf, data]) => ({ weekOf, ...data }));
  }, [allScans]);

  const byPOBreakdown = useMemo(() => {
    const byPO = {};
    for (const s of allScans) {
      if (s.type === 'exception') continue;
      const po = s.poName || 'UNASSIGNED';
      byPO[po] = (byPO[po] || 0) + 1;
    }
    return Object.entries(byPO)
      .sort((a, b) => b[1] - a[1])
      .map(([po, count]) => ({ po, count }));
  }, [allScans]);

  const totalStandard = allScans.filter((s) => s.type === 'standard').length;
  const totalExceptions = allScans.filter((s) => s.type === 'exception').length + allExceptions.length;

  // ─── PO Upload ───
  const handlePOUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setFileError(''); setUploadStatus('');
    try {
      const result = await parseManifestFile(file);
      setManifest(result.manifest);
      setPoNames(result.poNames);
    } catch (err) {
      setFileError(err.message);
      setManifest(null); setPoNames([]);
    }
  };

  const submitPO = async () => {
    if (!manifest || !job) return;
    setUploadStatus('Uploading...');
    try {
      const entries = Object.entries(manifest);
      const BATCH_SIZE = 400;
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        entries.slice(i, i + BATCH_SIZE).forEach(([isbn, poName]) => {
          batch.set(doc(db, 'jobs', job.id, 'manifest', isbn), { poName });
        });
        await batch.commit();
      }
      // Auto-assign PO colors if multi-mode
      if (job.meta.mode === 'multi') {
        const colors = {};
        poNames.forEach((po, i) => { colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length]; });
        await setDoc(doc(db, 'jobs', job.id), { poColors: colors }, { merge: true });
      }
      setUploadStatus(`✓ Uploaded ${entries.length.toLocaleString()} ISBNs across ${poNames.length} POs`);
      setManifest(null); setPoNames([]);
    } catch (err) {
      setUploadStatus('Upload failed: ' + err.message);
    }
  };

  // ─── BOL Upload ───
  const handleBOLFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBolFile({ name: file.name, data: reader.result, size: file.size });
    reader.readAsDataURL(file);
  };

  const submitBOL = async () => {
    if (!job || !bolFile) return;
    setBolUploading(true);
    try {
      await addDoc(collection(db, 'bols'), {
        jobId: job.id,
        date: bolDate,
        truckId: bolTruckId.trim() || null,
        notes: bolNotes.trim() || null,
        fileName: bolFile.name,
        fileData: bolFile.data,
        fileSize: bolFile.size,
        uploadedAt: serverTimestamp(),
      });
      setBolFile(null); setBolTruckId(''); setBolNotes('');
      setBolDate(new Date().toISOString().slice(0, 10));
    } catch (err) {
      alert('Failed to upload BOL: ' + err.message);
    }
    setBolUploading(false);
  };

  // ─── Report Exports ───
  const toDateStr = (ts) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  };

  const exportDaily = (date) => {
    const dayScans = allScans.filter((s) => {
      const d = s.timestamp?.toDate?.();
      return d && d.toISOString().slice(0, 10) === date;
    });
    const dayExcs = allExceptions.filter((ex) => {
      const d = ex.timestamp?.toDate?.();
      return d && d.toISOString().slice(0, 10) === date;
    });
    const wb = XLSX.utils.book_new();
    const scanData = dayScans.filter((s) => s.type === 'standard').map((s) => ({
      ISBN: s.isbn, PO: s.poName || '', Pod: s.podId, Scanner: s.scannerId, Time: toDateStr(s.timestamp),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(scanData.length ? scanData : [{ Note: 'No scans' }]), 'Scans');
    const excData = [
      ...dayScans.filter((s) => s.type === 'exception').map((s) => ({
        ISBN: s.isbn, Reason: 'Not in Manifest', Pod: s.podId, Scanner: s.scannerId, Time: toDateStr(s.timestamp),
      })),
      ...dayExcs.map((ex) => ({
        ISBN: ex.isbn || '', Title: ex.title || '', Reason: ex.reason, Pod: ex.podId, Scanner: ex.scannerId, Time: toDateStr(ex.timestamp),
      })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excData.length ? excData : [{ Note: 'No exceptions' }]), 'Exceptions');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { Metric: 'Date', Value: date },
      { Metric: 'Standard Scans', Value: scanData.length },
      { Metric: 'Exceptions', Value: excData.length },
    ]), 'Summary');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, `${job.meta.name}_daily_${date}.xlsx`);
  };

  const exportWeekly = (weekOf) => {
    const weekStart = new Date(weekOf);
    const weekEnd = new Date(weekOf);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekScans = allScans.filter((s) => {
      const d = s.timestamp?.toDate?.();
      return d && d >= weekStart && d < weekEnd;
    });
    const wb = XLSX.utils.book_new();
    const data = weekScans.filter((s) => s.type === 'standard').map((s) => ({
      ISBN: s.isbn, PO: s.poName || '', Pod: s.podId, Scanner: s.scannerId, Time: toDateStr(s.timestamp),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'No scans' }]), 'Scans');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { Metric: 'Week Of', Value: weekOf },
      { Metric: 'Standard Scans', Value: data.length },
      { Metric: 'Exceptions', Value: weekScans.filter((s) => s.type === 'exception').length },
    ]), 'Summary');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, `${job.meta.name}_weekly_${weekOf}.xlsx`);
  };

  const exportByPO = (po) => {
    const poScans = allScans.filter((s) => s.type === 'standard' && s.poName === po);
    const wb = XLSX.utils.book_new();
    const data = poScans.map((s) => ({
      ISBN: s.isbn, Pod: s.podId, Scanner: s.scannerId, Time: toDateStr(s.timestamp),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'No scans' }]), po);
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, `${job.meta.name}_${po}.xlsx`);
  };

  const exportAllData = () => {
    const wb = XLSX.utils.book_new();
    const scanData = allScans.filter((s) => s.type === 'standard').map((s) => ({
      ISBN: s.isbn, PO: s.poName || '', Pod: s.podId, Scanner: s.scannerId, Time: toDateStr(s.timestamp),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(scanData.length ? scanData : [{ Note: 'No scans' }]), 'All Scans');
    const excData = [
      ...allScans.filter((s) => s.type === 'exception').map((s) => ({
        ISBN: s.isbn, Reason: 'Not in Manifest', Pod: s.podId, Scanner: s.scannerId, Time: toDateStr(s.timestamp),
      })),
      ...allExceptions.map((ex) => ({
        ISBN: ex.isbn || '', Title: ex.title || '', Reason: ex.reason, Pod: ex.podId, Time: toDateStr(ex.timestamp),
      })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excData.length ? excData : [{ Note: 'No exceptions' }]), 'All Exceptions');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { Metric: 'Job Name', Value: job.meta.name },
      { Metric: 'Total Standard Scans', Value: scanData.length },
      { Metric: 'Total Exceptions', Value: excData.length },
      { Metric: 'Export Date', Value: new Date().toLocaleString() },
    ]), 'Summary');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, `${job.meta.name}_complete_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ─── Render ───
  if (loading) return <div style={s.container}><p style={s.text}>Loading...</p></div>;
  if (!job) return (
    <div style={s.container}>
      <Link to="/" style={s.backLink}>← Back to Home</Link>
      <h1 style={s.title}>Customer Portal</h1>
      <p style={s.text}>No active job. Contact the warehouse supervisor to activate a job.</p>
    </div>
  );

  return (
    <div style={s.container}>
      <Link to="/" style={s.backLink}>← Back to Home</Link>

      <div style={s.headerRow}>
        <div>
          <h1 style={s.title}>📦 Customer Portal</h1>
          <p style={s.subtitle}>{job.meta.name} · {job.meta.mode === 'multi' ? 'Multi-PO' : 'Single PO'}</p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {[
          ['overview', '📊 Overview'],
          ['reports', '📥 Reports'],
          ['upload', '📤 Upload POs'],
          ['bols', '🚛 BOLs'],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)}
            style={{ ...s.tab, ...(activeTab === key ? s.tabActive : {}) }}>
            {label}
          </button>
        ))}
      </div>

      {/* ═══ Overview Tab ═══ */}
      {activeTab === 'overview' && (
        <div>
          <div style={s.statsRow}>
            <div style={s.statBox}>
              <div style={s.statVal}>{totalStandard.toLocaleString()}</div>
              <div style={s.statLbl}>Scans Completed</div>
            </div>
            <div style={s.statBox}>
              <div style={{ ...s.statVal, color: totalExceptions > 0 ? '#F97316' : '#888' }}>{totalExceptions}</div>
              <div style={s.statLbl}>Exceptions</div>
            </div>
            <div style={s.statBox}>
              <div style={s.statVal}>{dailyBreakdown.length}</div>
              <div style={s.statLbl}>Days Active</div>
            </div>
            <div style={s.statBox}>
              <div style={s.statVal}>{job.meta.dailyTarget?.toLocaleString() || '—'}</div>
              <div style={s.statLbl}>Daily Target</div>
            </div>
          </div>

          {/* Progress */}
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: '#aaa', fontSize: 14 }}>Today's Progress</span>
              <span style={{ color: '#3B82F6', fontWeight: 700 }}>
                {dailyBreakdown[0]?.scans.toLocaleString() || 0} / {job.meta.dailyTarget?.toLocaleString()}
              </span>
            </div>
            <div style={{ height: 8, backgroundColor: '#333', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', backgroundColor: '#3B82F6', borderRadius: 4, width: `${Math.min(100, ((dailyBreakdown[0]?.scans || 0) / (job.meta.dailyTarget || 1)) * 100)}%`, transition: 'width 0.5s' }} />
            </div>
          </div>

          {/* By PO summary */}
          {byPOBreakdown.length > 0 && (
            <div style={s.card}>
              <h3 style={s.cardTitle}>Scans by PO</h3>
              {byPOBreakdown.map((item) => (
                <div key={item.po} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #222' }}>
                  <span style={{ color: '#ccc', fontSize: 14 }}>{item.po}</span>
                  <span style={{ color: '#fff', fontWeight: 700, fontFamily: 'monospace' }}>{item.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* Recent daily */}
          {dailyBreakdown.length > 0 && (
            <div style={s.card}>
              <h3 style={s.cardTitle}>Recent Daily Totals</h3>
              {dailyBreakdown.slice(0, 7).map((d) => (
                <div key={d.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #222' }}>
                  <span style={{ color: '#888', fontSize: 14 }}>{d.date}</span>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <span style={{ color: '#fff', fontWeight: 600 }}>{d.scans.toLocaleString()} scans</span>
                    {d.exceptions > 0 && <span style={{ color: '#F97316', fontSize: 13 }}>{d.exceptions} exc</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ Reports Tab ═══ */}
      {activeTab === 'reports' && (
        <div>
          <div style={s.card}>
            <h3 style={s.cardTitle}>📊 Export All Data</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>
              Complete dataset with all scans, exceptions, and summary.
            </p>
            <button onClick={exportAllData} style={s.exportBtn}>📥 Download Complete Report</button>
          </div>

          {/* Daily reports */}
          <div style={s.card}>
            <h3 style={s.cardTitle}>📅 Daily Reports</h3>
            {dailyBreakdown.length === 0 && <p style={{ color: '#888', fontSize: 14 }}>No scan data yet.</p>}
            {dailyBreakdown.slice(0, 14).map((d) => (
              <div key={d.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                <div>
                  <span style={{ color: '#ccc', fontSize: 15, fontWeight: 600 }}>{d.date}</span>
                  <span style={{ color: '#888', fontSize: 13, marginLeft: 12 }}>{d.scans} scans · {d.exceptions} exceptions</span>
                </div>
                <button onClick={() => exportDaily(d.date)} style={s.smallBtn}>📥 Export</button>
              </div>
            ))}
          </div>

          {/* Weekly reports */}
          {weeklyBreakdown.length > 0 && (
            <div style={s.card}>
              <h3 style={s.cardTitle}>📆 Weekly Reports</h3>
              {weeklyBreakdown.map((w) => (
                <div key={w.weekOf} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                  <div>
                    <span style={{ color: '#ccc', fontSize: 15, fontWeight: 600 }}>Week of {w.weekOf}</span>
                    <span style={{ color: '#888', fontSize: 13, marginLeft: 12 }}>{w.scans} scans</span>
                  </div>
                  <button onClick={() => exportWeekly(w.weekOf)} style={s.smallBtn}>📥 Export</button>
                </div>
              ))}
            </div>
          )}

          {/* By PO reports */}
          {byPOBreakdown.length > 0 && (
            <div style={s.card}>
              <h3 style={s.cardTitle}>📋 Reports by PO</h3>
              {byPOBreakdown.map((item) => (
                <div key={item.po} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                  <div>
                    <span style={{ color: '#ccc', fontSize: 15, fontWeight: 600 }}>{item.po}</span>
                    <span style={{ color: '#888', fontSize: 13, marginLeft: 12 }}>{item.count.toLocaleString()} scans</span>
                  </div>
                  <button onClick={() => exportByPO(item.po)} style={s.smallBtn}>📥 Export</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ Upload POs Tab ═══ */}
      {activeTab === 'upload' && (
        <div>
          <div style={s.card}>
            <h3 style={s.cardTitle}>📤 Upload Purchase Orders</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 16 }}>
              Upload a CSV or XLSX file with columns: <strong style={{ color: '#ccc' }}>ISBN</strong> and <strong style={{ color: '#ccc' }}>PO</strong>.
              This will add ISBNs to the scanning manifest.
            </p>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handlePOUpload}
              style={s.input} />
            {fileError && <p style={{ color: '#EF4444', marginTop: 8, fontSize: 14 }}>{fileError}</p>}
            {manifest && (
              <div style={{ marginTop: 12 }}>
                <p style={{ color: '#22C55E', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                  ✓ Parsed {Object.keys(manifest).length.toLocaleString()} ISBNs across {poNames.length} POs
                </p>
                <div style={{ maxHeight: 200, overflowY: 'auto', backgroundColor: '#0a0a0a', borderRadius: 8, border: '1px solid #333', marginBottom: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={s.th}>PO Name</th>
                        <th style={s.th}>ISBN Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poNames.map((po) => {
                        const count = Object.values(manifest).filter((v) => v === po).length;
                        return (
                          <tr key={po}>
                            <td style={s.td}>{po}</td>
                            <td style={s.td}>{count.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <button onClick={submitPO} style={s.primaryBtn}>
                  Upload to Active Job
                </button>
              </div>
            )}
            {uploadStatus && (
              <p style={{ color: uploadStatus.startsWith('✓') ? '#22C55E' : uploadStatus === 'Uploading...' ? '#3B82F6' : '#EF4444', marginTop: 8, fontSize: 14, fontWeight: 600 }}>
                {uploadStatus}
              </p>
            )}
          </div>

          <div style={{ ...s.card, backgroundColor: '#1a1a2e' }}>
            <h4 style={{ color: '#818cf8', margin: '0 0 8px', fontSize: 14 }}>💡 File Format Requirements</h4>
            <ul style={{ color: '#888', fontSize: 13, margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
              <li>First row must be headers (e.g., "ISBN", "PO")</li>
              <li>ISBN column: numeric ISBNs (10 or 13 digit, dashes optional)</li>
              <li>PO column: Purchase Order identifier (text)</li>
              <li>Supported formats: .csv, .xlsx, .xls</li>
              <li>Duplicate ISBNs are automatically deduplicated</li>
            </ul>
          </div>
        </div>
      )}

      {/* ═══ BOLs Tab ═══ */}
      {activeTab === 'bols' && (
        <div>
          <div style={s.card}>
            <h3 style={s.cardTitle}>🚛 Upload Bill of Lading</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 16 }}>
              Upload BOL documents for daily truckload pickups.
            </p>

            <label style={s.label}>Pickup Date</label>
            <input type="date" value={bolDate} onChange={(e) => setBolDate(e.target.value)} style={s.input} />

            <label style={s.label}>Truck / Carrier ID (optional)</label>
            <input type="text" value={bolTruckId} onChange={(e) => setBolTruckId(e.target.value)}
              placeholder="e.g. FEDEX-12345" style={s.input} />

            <label style={s.label}>Notes (optional)</label>
            <textarea value={bolNotes} onChange={(e) => setBolNotes(e.target.value)}
              placeholder="Any pickup notes..." rows={3}
              style={{ ...s.input, resize: 'vertical', fontFamily: 'inherit' }} />

            <label style={s.label}>BOL Document (PDF, image, or scan)</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={handleBOLFile} style={s.input} />
            {bolFile && (
              <p style={{ color: '#22C55E', fontSize: 13, marginTop: 4 }}>
                ✓ {bolFile.name} ({(bolFile.size / 1024).toFixed(1)} KB)
              </p>
            )}

            <button onClick={submitBOL} disabled={!bolFile || bolUploading}
              style={{ ...s.primaryBtn, marginTop: 16, opacity: !bolFile || bolUploading ? 0.5 : 1 }}>
              {bolUploading ? 'Uploading...' : '📤 Upload BOL'}
            </button>
          </div>

          {/* BOL history */}
          {bols.length > 0 && (
            <div style={s.card}>
              <h3 style={s.cardTitle}>📋 BOL History</h3>
              {bols.map((bol) => (
                <div key={bol.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #222', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <span style={{ color: '#ccc', fontSize: 15, fontWeight: 600 }}>{bol.date}</span>
                    {bol.truckId && <span style={{ color: '#888', fontSize: 13, marginLeft: 8 }}>🚛 {bol.truckId}</span>}
                    <span style={{ color: '#666', fontSize: 12, marginLeft: 8 }}>{bol.fileName}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {bol.notes && (
                      <span style={{ fontSize: 12, color: '#888', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {bol.notes}
                      </span>
                    )}
                    <button onClick={() => {
                      const a = document.createElement('a');
                      a.href = bol.fileData;
                      a.download = bol.fileName;
                      a.click();
                    }} style={s.smallBtn}>📥 Download</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {bols.length === 0 && (
            <div style={s.card}>
              <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No BOLs uploaded yet.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  container: { minHeight: '100vh', backgroundColor: 'var(--bg, #111)', color: 'var(--text, #fff)', padding: '24px 16px', fontFamily: 'system-ui,sans-serif', maxWidth: 1000, margin: '0 auto' },
  backLink: { color: '#666', textDecoration: 'none', fontSize: 14, marginBottom: 8, display: 'inline-block' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 16 },
  title: { fontSize: 'clamp(24px, 4vw, 32px)', fontWeight: 800, margin: '8px 0 0' },
  subtitle: { fontSize: 15, color: 'var(--text-secondary, #888)', marginTop: 4, marginBottom: 0 },
  text: { color: 'var(--text-secondary, #aaa)', fontSize: 16 },
  tabBar: { display: 'flex', gap: 4, marginBottom: 24, flexWrap: 'wrap' },
  tab: {
    padding: '10px 18px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: '#333',
    backgroundColor: '#1a1a1a', color: '#888', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', transition: 'all 0.2s',
  },
  tabActive: { borderColor: '#3B82F6', color: '#3B82F6', backgroundColor: '#1e3a5f' },
  statsRow: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 },
  statBox: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: '16px 20px', flex: 1, minWidth: 120, textAlign: 'center', border: '1px solid #333' },
  statVal: { fontSize: 28, fontWeight: 800, color: '#fff', lineHeight: 1 },
  statLbl: { fontSize: 12, color: '#888', marginTop: 4 },
  card: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 20, border: '1px solid #333', marginBottom: 16 },
  cardTitle: { fontSize: 16, fontWeight: 700, color: '#ccc', marginTop: 0, marginBottom: 16 },
  label: { display: 'block', fontSize: 14, fontWeight: 600, color: '#aaa', marginBottom: 6, marginTop: 16 },
  input: { width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #333', backgroundColor: '#222', color: '#fff', fontSize: 16, boxSizing: 'border-box' },
  exportBtn: { padding: '12px 24px', borderRadius: 8, border: '1px solid #3B82F6', backgroundColor: '#1e3a5f', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  smallBtn: { padding: '6px 12px', borderRadius: 6, border: '1px solid #444', backgroundColor: '#222', color: '#ccc', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  primaryBtn: { padding: '14px 28px', borderRadius: 8, border: 'none', backgroundColor: '#22C55E', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', width: '100%' },
  th: { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #333', color: '#888', fontWeight: 600, position: 'sticky', top: 0, backgroundColor: '#0a0a0a' },
  td: { padding: '6px 12px', borderBottom: '1px solid #222', color: '#ccc' },
};
