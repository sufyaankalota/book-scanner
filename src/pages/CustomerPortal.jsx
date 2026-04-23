import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  query, where, onSnapshot, orderBy, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { parseManifestFile } from '../utils/manifest';
import { downloadBlob } from '../utils/export';
import { verifyPassword } from '../utils/crypto';
import * as XLSX from 'xlsx';

const DEFAULT_COLORS = [
  '#EF4444', '#3B82F6', '#EAB308', '#22C55E', '#F97316',
  '#A855F7', '#EC4899', '#14B8A6', '#6366F1', '#84CC16',
];

export default function CustomerPortal() {
  // Auth
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Data
  const [job, setJob] = useState(null);
  const [allScans, setAllScans] = useState([]);
  const [allExceptions, setAllExceptions] = useState([]);
  const [bols, setBols] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('daily');

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

  // Exception photo viewer
  const [viewingPhoto, setViewingPhoto] = useState(null);
  // Billing reports
  const [billingReports, setBillingReports] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  // Customer Login
  const handleLogin = async () => {
    if (!password.trim()) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const configDoc = await getDoc(doc(db, 'config', 'customer'));
      if (!configDoc.exists()) {
        setAuthError('Customer access not configured. Contact the warehouse.');
      } else {
        const data = configDoc.data();
        let match = false;
        // Support both hashed and legacy plaintext passwords
        if (data.passwordHash) {
          match = await verifyPassword(password, data.passwordHash);
        } else if (data.password) {
          match = password === data.password;
        }
        if (match) {
          setAuthenticated(true);
          sessionStorage.setItem('customer-auth', 'true');
        } else {
          setAuthError('Incorrect password.');
        }
      }
    } catch {
      setAuthError('Login failed. Try again.');
    }
    setAuthLoading(false);
  };

  useEffect(() => {
    if (sessionStorage.getItem('customer-auth') === 'true') {
      setAuthenticated(true);
    }
  }, []);

  // Data Loading (only when authenticated)
  useEffect(() => {
    if (!authenticated) return;
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const d = snap.docs[0];
        setJob({ id: d.id, ...d.data() });
      } else setJob(null);
      setLoading(false);
    });
    return unsub;
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !job) return;
    const q = query(collection(db, 'scans'), where('jobId', '==', job.id));
    return onSnapshot(q, (snap) => {
      setAllScans(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [authenticated, job]);

  useEffect(() => {
    if (!authenticated || !job) return;
    const q = query(collection(db, 'exceptions'), where('jobId', '==', job.id));
    return onSnapshot(q, (snap) => {
      setAllExceptions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [authenticated, job]);

  useEffect(() => {
    if (!authenticated || !job) return;
    const q = query(collection(db, 'bols'), where('jobId', '==', job.id));
    return onSnapshot(q, (snap) => {
      setBols(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')));
    });
  }, [authenticated, job]);

  // Billing reports
  useEffect(() => {
    if (!authenticated || !job) return;
    const q = query(collection(db, 'billing-reports'), where('jobId', '==', job.id));
    return onSnapshot(q, (snap) => {
      setBillingReports(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.weekStart?.toDate?.()?.getTime() || 0) - (a.weekStart?.toDate?.()?.getTime() || 0)));
    });
  }, [authenticated, job]);

  // Computed
  const dailyBreakdown = useMemo(() => {
    const byDay = {};
    for (const s of allScans) {
      const d = s.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = { total: 0, standard: 0, exceptions: 0 };
      byDay[key].total++;
      if (s.type === 'exception') byDay[key].exceptions++;
      else byDay[key].standard++;
    }
    for (const ex of allExceptions) {
      const d = ex.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = { total: 0, standard: 0, exceptions: 0 };
      byDay[key].exceptions++;
    }
    return Object.entries(byDay)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, data]) => ({ date, ...data }));
  }, [allScans, allExceptions]);

  const dailyExceptions = useMemo(() => {
    const byDay = {};
    for (const s of allScans) {
      if (s.type !== 'exception') continue;
      const d = s.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push({
        isbn: s.isbn, reason: 'Not in Manifest', title: '',
        photo: null, time: d, podId: s.podId,
      });
    }
    for (const ex of allExceptions) {
      const d = ex.timestamp?.toDate?.();
      if (!d) continue;
      const key = d.toISOString().slice(0, 10);
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push({
        isbn: ex.isbn || '', reason: ex.reason, title: ex.title || '',
        photo: ex.photo || null, time: d, podId: ex.podId,
      });
    }
    return Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0]));
  }, [allScans, allExceptions]);

  const totalProcessed = allScans.filter((s) => s.type === 'standard').length;
  const totalExcCount = allScans.filter((s) => s.type === 'exception').length + allExceptions.length;
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayData = dailyBreakdown.find((d) => d.date === todayKey);

  const toDateStr = (ts) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  };

  // PO Upload
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
      if (job.meta.mode === 'multi') {
        const colors = {};
        poNames.forEach((po, i) => { colors[po] = DEFAULT_COLORS[i % DEFAULT_COLORS.length]; });
        await setDoc(doc(db, 'jobs', job.id), { poColors: colors }, { merge: true });
      }
      setUploadStatus('Uploaded ' + entries.length.toLocaleString() + ' ISBNs across ' + poNames.length + ' POs');
      setManifest(null); setPoNames([]);
    } catch (err) {
      setUploadStatus('Upload failed: ' + err.message);
    }
  };

  // BOL Upload
  const handleBOLFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 700 * 1024) {
      alert('File too large. Maximum size is 700 KB. Please compress or reduce the file.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBolFile({ name: file.name, data: reader.result, size: file.size });
    reader.readAsDataURL(file);
  };

  const submitBOL = async () => {
    if (!job || !bolFile) return;
    setBolUploading(true);
    try {
      await addDoc(collection(db, 'bols'), {
        jobId: job.id, date: bolDate,
        truckId: bolTruckId.trim() || null,
        notes: bolNotes.trim() || null,
        fileName: bolFile.name, fileData: bolFile.data, fileSize: bolFile.size,
        pickedUp: false, uploadedAt: serverTimestamp(),
      });
      setBolFile(null); setBolTruckId(''); setBolNotes('');
      setBolDate(new Date().toISOString().slice(0, 10));
    } catch (err) {
      alert('Failed to upload BOL: ' + err.message);
    }
    setBolUploading(false);
  };

  // Report Exports
  const exportDailyScans = (date) => {
    const dayScans = allScans.filter((s) => {
      const d = s.timestamp?.toDate?.();
      return d && d.toISOString().slice(0, 10) === date && s.type === 'standard';
    });
    const wb = XLSX.utils.book_new();
    const data = dayScans.map((s) => ({
      ISBN: s.isbn, PO: s.poName || '', Timestamp: toDateStr(s.timestamp),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'No scans' }]), 'Scanned Items');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { Metric: 'Date', Value: date },
      { Metric: 'Units Scanned', Value: data.length },
    ]), 'Summary');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, 'scans_' + date + '.xlsx');
  };

  const exportDailyExceptions = (date) => {
    const dayAutoExc = allScans.filter((s) => {
      const d = s.timestamp?.toDate?.();
      return d && d.toISOString().slice(0, 10) === date && s.type === 'exception';
    });
    const dayManualExc = allExceptions.filter((ex) => {
      const d = ex.timestamp?.toDate?.();
      return d && d.toISOString().slice(0, 10) === date;
    });
    const wb = XLSX.utils.book_new();
    const data = [
      ...dayAutoExc.map((s) => ({
        ISBN: s.isbn, Reason: 'Not in Manifest', Title: '', Timestamp: toDateStr(s.timestamp),
      })),
      ...dayManualExc.map((ex) => ({
        ISBN: ex.isbn || '', Reason: ex.reason, Title: ex.title || '',
        'Has Photo': ex.photo ? 'Yes' : 'No', Timestamp: toDateStr(ex.timestamp),
      })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ Note: 'No exceptions' }]), 'Exceptions');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(buf, 'exceptions_' + date + '.xlsx');
  };

  const handleLogout = () => {
    sessionStorage.removeItem('customer-auth');
    setAuthenticated(false);
    setPassword('');
  };

  // LOGIN SCREEN
  if (!authenticated) {
    return (
      <div style={st.loginContainer}>
        <div style={st.loginCard}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>&#128230;</div>
            <h1 style={{ color: '#fff', fontSize: 24, fontWeight: 800, margin: 0 }}>Customer Portal</h1>
            <p style={{ color: '#888', fontSize: 14, marginTop: 4 }}>Enter your access password to continue</p>
          </div>
          <input type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
            placeholder="Password..." autoFocus style={st.loginInput} />
          {authError && <p style={{ color: '#EF4444', fontSize: 14, marginTop: 8, textAlign: 'center' }}>{authError}</p>}
          <button onClick={handleLogin} disabled={!password.trim() || authLoading}
            style={{ ...st.loginBtn, opacity: !password.trim() || authLoading ? 0.5 : 1 }}>
            {authLoading ? 'Verifying...' : 'Sign In'}
          </button>
        </div>
      </div>
    );
  }

  // LOADING / NO JOB
  if (loading) return <div style={st.container}><p style={st.text}>Loading...</p></div>;
  if (!job) return (
    <div style={st.container}>
      <div style={st.topBar}>
        <span style={{ color: '#888', fontSize: 14 }}>&#128230; Customer Portal</span>
        <button onClick={handleLogout} style={st.logoutBtn}>Sign Out</button>
      </div>
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>&#128203;</div>
        <h2 style={{ color: '#fff', marginBottom: 8 }}>No Active Job</h2>
        <p style={{ color: '#888' }}>There is no active processing job at this time. Please check back later.</p>
      </div>
    </div>
  );

  // MAIN PORTAL
  return (
    <div style={st.container}>
      <div style={st.topBar}>
        <div>
          <span style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>&#128230; Customer Portal</span>
          <span style={{ color: '#666', fontSize: 14, marginLeft: 12 }}>{job.meta.name}</span>
        </div>
        <button onClick={handleLogout} style={st.logoutBtn}>Sign Out</button>
      </div>

      <div style={st.statsRow}>
        <div style={st.statBox}>
          <div style={st.statVal}>{(todayData?.standard || 0).toLocaleString()}</div>
          <div style={st.statLbl}>Today's Units</div>
        </div>
        <div style={st.statBox}>
          <div style={{ ...st.statVal, color: (todayData?.exceptions || 0) > 0 ? '#F97316' : '#888' }}>
            {todayData?.exceptions || 0}
          </div>
          <div style={st.statLbl}>Today's Exceptions</div>
        </div>
        <div style={st.statBox}>
          <div style={st.statVal}>{totalProcessed.toLocaleString()}</div>
          <div style={st.statLbl}>Total Units Processed</div>
        </div>
        <div style={st.statBox}>
          <div style={{ ...st.statVal, color: totalExcCount > 0 ? '#F97316' : '#888' }}>{totalExcCount}</div>
          <div style={st.statLbl}>Total Exceptions</div>
        </div>
      </div>

      <div style={st.tabBar}>
        {[['daily','Daily Volume'],['exceptions','Exceptions'],['billing','Billing'],['reports','Reports'],['upload','Upload POs'],['bols','BOLs']].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)}
            style={{ ...st.tab, ...(activeTab === key ? st.tabActive : {}) }}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'daily' && (
        <div>
          {dailyBreakdown.length === 0 && (
            <div style={st.card}><p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No processing data yet.</p></div>
          )}
          {dailyBreakdown.map((d) => (
            <div key={d.date} style={st.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>{d.date}</div>
                  <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>
                    {d.date === todayKey ? 'Today' : new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#fff', fontSize: 24, fontWeight: 800, fontFamily: 'monospace' }}>
                    {d.standard.toLocaleString()}
                  </div>
                  <div style={{ color: '#888', fontSize: 12 }}>units scanned</div>
                </div>
              </div>
              {d.exceptions > 0 && (
                <div style={{ marginTop: 8, padding: '6px 12px', backgroundColor: '#7f1d1d22', borderRadius: 6, display: 'inline-block' }}>
                  <span style={{ color: '#F97316', fontSize: 13, fontWeight: 600 }}>{d.exceptions} exception{d.exceptions > 1 ? 's' : ''}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => exportDailyScans(d.date)} style={st.smallBtn}>Scans Report</button>
                {d.exceptions > 0 && (
                  <button onClick={() => exportDailyExceptions(d.date)} style={st.smallBtn}>Exceptions Report</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'exceptions' && (
        <div>
          {dailyExceptions.length === 0 && (
            <div style={st.card}><p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No exceptions recorded.</p></div>
          )}
          {dailyExceptions.map(([date, excs]) => (
            <div key={date} style={st.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ color: '#fff', fontSize: 16, fontWeight: 700, margin: 0 }}>{date}</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: '#F97316', fontSize: 13, fontWeight: 600 }}>{excs.length} exception{excs.length > 1 ? 's' : ''}</span>
                  <button onClick={() => exportDailyExceptions(date)} style={st.smallBtn}>Export</button>
                </div>
              </div>
              {excs.map((exc, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: '1px solid #222', alignItems: 'flex-start' }}>
                  {exc.photo && (
                    <img src={exc.photo} alt="Exception"
                      onClick={() => setViewingPhoto(exc.photo)}
                      style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1px solid #444', cursor: 'pointer', flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: '#7f1d1d', color: '#fca5a5', fontSize: 12, fontWeight: 600 }}>
                        {exc.reason}
                      </span>
                      {exc.isbn && <span style={{ color: '#ccc', fontFamily: 'monospace', fontSize: 13 }}>{exc.isbn}</span>}
                    </div>
                    {exc.title && <div style={{ color: '#aaa', fontSize: 13, marginTop: 2 }}>"{exc.title}"</div>}
                    <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>{exc.time.toLocaleTimeString()}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {viewingPhoto && (
            <div onClick={() => setViewingPhoto(null)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, cursor: 'pointer', padding: 24 }}>
              <img src={viewingPhoto} alt="Exception photo" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 12, border: '2px solid #444' }} />
            </div>
          )}
        </div>
      )}

      {activeTab === 'billing' && (
        <div>
          <div style={st.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={st.cardTitle}>💰 Weekly Billing Reports</h3>
              <button onClick={() => setShowArchived(!showArchived)}
                style={{ ...st.smallBtn, color: showArchived ? '#3B82F6' : '#666' }}>
                {showArchived ? '📂 Hide Archived' : '📁 Show Archived'}
              </button>
            </div>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 16 }}>
              Billing reports are generated weekly by the warehouse. Each report contains unit counts broken down by day, pod, and operator.
            </p>
            {billingReports.filter((r) => showArchived || !r.archived).length === 0 && (
              <p style={{ color: '#666', fontSize: 14, textAlign: 'center', padding: 20 }}>
                {billingReports.length > 0 && !showArchived ? 'All reports are archived. Click "Show Archived" to view.' : 'No billing reports available yet.'}
              </p>
            )}
            {billingReports.filter((r) => showArchived || !r.archived).map((report) => {
              const start = report.weekStart?.toDate?.();
              const end = report.weekEnd?.toDate?.();
              const created = report.createdAt?.toDate?.();
              return (
                <div key={report.id} style={{ border: '1px solid #333', borderRadius: 12, padding: 16, marginBottom: 12, backgroundColor: 'var(--bg-input, #0a0a0a)', opacity: report.archived ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
                        {start ? start.toLocaleDateString() : '?'} – {end ? new Date(end.getTime() - 86400000).toLocaleDateString() : '?'}
                        {report.archived && <span style={{ color: '#666', fontSize: 12, marginLeft: 8 }}>(Archived)</span>}
                      </div>
                      <div style={{ color: '#888', fontSize: 13 }}>
                        Generated: {created ? created.toLocaleDateString() + ' ' + created.toLocaleTimeString() : 'Unknown'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => {
                        try {
                          const bytes = Uint8Array.from(atob(report.fileData), (c) => c.charCodeAt(0));
                          downloadBlob(bytes, report.fileName);
                        } catch { alert('Download failed'); }
                      }} style={{ ...st.smallBtn, padding: '8px 20px' }}>
                        📥 Download
                      </button>
                      <button onClick={() => updateDoc(doc(db, 'billing-reports', report.id), { archived: !report.archived })}
                        style={{ ...st.smallBtn, padding: '8px 12px' }}>
                        {report.archived ? '📂 Unarchive' : '📁 Archive'}
                      </button>
                      <button onClick={() => { if (confirm('Delete this report permanently?')) deleteDoc(doc(db, 'billing-reports', report.id)); }}
                        style={{ ...st.smallBtn, padding: '8px 12px', color: '#EF4444', borderColor: '#7f1d1d' }}>
                        🗑
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#22C55E', fontSize: 22, fontWeight: 800 }}>{(report.standardCount || 0).toLocaleString()}</div>
                      <div style={{ color: '#888', fontSize: 12 }}>Regular Units</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#F97316', fontSize: 22, fontWeight: 800 }}>{(report.exceptionCount || 0).toLocaleString()}</div>
                      <div style={{ color: '#888', fontSize: 12 }}>Exceptions</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#3B82F6', fontSize: 22, fontWeight: 800 }}>{(report.totalUnits || 0).toLocaleString()}</div>
                      <div style={{ color: '#888', fontSize: 12 }}>Total Units</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'reports' && (
        <div>
          <div style={st.card}>
            <h3 style={st.cardTitle}>Daily Scan Reports</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>Download a list of all items scanned on each day.</p>
            {dailyBreakdown.length === 0 && <p style={{ color: '#666', fontSize: 14 }}>No data yet.</p>}
            {dailyBreakdown.slice(0, 14).map((d) => (
              <div key={d.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                <div>
                  <span style={{ color: '#ccc', fontSize: 15, fontWeight: 600 }}>{d.date}</span>
                  <span style={{ color: '#888', fontSize: 13, marginLeft: 12 }}>{d.standard.toLocaleString()} units</span>
                </div>
                <button onClick={() => exportDailyScans(d.date)} style={st.smallBtn}>Download</button>
              </div>
            ))}
          </div>
          <div style={st.card}>
            <h3 style={st.cardTitle}>Daily Exception Reports</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>Download exception details for each day.</p>
            {dailyBreakdown.filter((d) => d.exceptions > 0).length === 0 && <p style={{ color: '#666', fontSize: 14 }}>No exceptions.</p>}
            {dailyBreakdown.filter((d) => d.exceptions > 0).map((d) => (
              <div key={d.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #222' }}>
                <div>
                  <span style={{ color: '#ccc', fontSize: 15, fontWeight: 600 }}>{d.date}</span>
                  <span style={{ color: '#F97316', fontSize: 13, marginLeft: 12 }}>{d.exceptions} exceptions</span>
                </div>
                <button onClick={() => exportDailyExceptions(d.date)} style={st.smallBtn}>Download</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'upload' && (
        <div>
          <div style={st.card}>
            <h3 style={st.cardTitle}>Upload Purchase Orders</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 16 }}>
              Upload a CSV or XLSX file with columns: <strong style={{ color: '#ccc' }}>ISBN</strong> and <strong style={{ color: '#ccc' }}>PO</strong>.
            </p>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handlePOUpload} style={st.input} />
            {fileError && <p style={{ color: '#EF4444', marginTop: 8, fontSize: 14 }}>{fileError}</p>}
            {manifest && (
              <div style={{ marginTop: 12 }}>
                <p style={{ color: '#22C55E', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                  Parsed {Object.keys(manifest).length.toLocaleString()} ISBNs across {poNames.length} POs
                </p>
                <div style={{ maxHeight: 200, overflowY: 'auto', backgroundColor: '#0a0a0a', borderRadius: 8, border: '1px solid #333', marginBottom: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={st.th}>PO Name</th><th style={st.th}>ISBN Count</th></tr></thead>
                    <tbody>
                      {poNames.map((po) => {
                        const count = Object.values(manifest).filter((v) => v === po).length;
                        return (<tr key={po}><td style={st.td}>{po}</td><td style={st.td}>{count.toLocaleString()}</td></tr>);
                      })}
                    </tbody>
                  </table>
                </div>
                <button onClick={submitPO} style={st.primaryBtn}>Upload to Job</button>
              </div>
            )}
            {uploadStatus && (
              <p style={{ color: uploadStatus.startsWith('Uploaded') ? '#22C55E' : uploadStatus === 'Uploading...' ? '#3B82F6' : '#EF4444', marginTop: 8, fontSize: 14, fontWeight: 600 }}>
                {uploadStatus}
              </p>
            )}
          </div>
          <div style={{ ...st.card, backgroundColor: '#1a1a2e' }}>
            <h4 style={{ color: '#818cf8', margin: '0 0 8px', fontSize: 14 }}>File Format</h4>
            <ul style={{ color: '#888', fontSize: 13, margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
              <li>First row must be headers (e.g., "ISBN", "PO")</li>
              <li>ISBN column: numeric ISBNs (10 or 13 digit)</li>
              <li>PO column: Purchase Order identifier</li>
              <li>Supported formats: .csv, .xlsx, .xls</li>
            </ul>
          </div>
        </div>
      )}

      {activeTab === 'bols' && (
        <div>
          <div style={st.card}>
            <h3 style={st.cardTitle}>Upload Bill of Lading</h3>
            <p style={{ color: '#888', fontSize: 14, marginBottom: 16 }}>
              Upload BOL documents for daily truckload pickups.
            </p>
            <label style={st.label}>Pickup Date</label>
            <input type="date" value={bolDate} onChange={(e) => setBolDate(e.target.value)} style={st.input} />
            <label style={st.label}>Truck / Carrier ID (optional)</label>
            <input type="text" value={bolTruckId} onChange={(e) => setBolTruckId(e.target.value)}
              placeholder="e.g. FEDEX-12345" style={st.input} />
            <label style={st.label}>Notes (optional)</label>
            <textarea value={bolNotes} onChange={(e) => setBolNotes(e.target.value)}
              placeholder="Pickup notes..." rows={3}
              style={{ ...st.input, resize: 'vertical', fontFamily: 'inherit' }} />
            <label style={st.label}>BOL Document</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={handleBOLFile} style={st.input} />
            {bolFile && (
              <p style={{ color: '#22C55E', fontSize: 13, marginTop: 4 }}>
                {bolFile.name} ({(bolFile.size / 1024).toFixed(1)} KB)
              </p>
            )}
            <button onClick={submitBOL} disabled={!bolFile || bolUploading}
              style={{ ...st.primaryBtn, marginTop: 16, opacity: !bolFile || bolUploading ? 0.5 : 1 }}>
              {bolUploading ? 'Uploading...' : 'Upload BOL'}
            </button>
          </div>

          {bols.length > 0 && (
            <div style={st.card}>
              <h3 style={st.cardTitle}>BOL History</h3>
              {bols.map((bol) => (
                <div key={bol.id} style={{ padding: '12px 0', borderBottom: '1px solid #222' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>{bol.date}</span>
                      {bol.truckId && <span style={{ color: '#888', fontSize: 13 }}>{bol.truckId}</span>}
                      <span style={{
                        padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                        backgroundColor: bol.pickedUp ? '#14532d' : '#422006',
                        color: bol.pickedUp ? '#22C55E' : '#EAB308',
                      }}>
                        {bol.pickedUp ? 'PICKED UP' : 'PENDING'}
                      </span>
                    </div>
                    <button onClick={() => {
                      const a = document.createElement('a');
                      a.href = bol.fileData;
                      a.download = bol.fileName;
                      a.click();
                    }} style={st.smallBtn}>Download</button>
                  </div>
                  {bol.notes && <p style={{ color: '#888', fontSize: 13, marginTop: 4, marginBottom: 0 }}>{bol.notes}</p>}
                  <p style={{ color: '#666', fontSize: 11, marginTop: 2, marginBottom: 0 }}>{bol.fileName}</p>
                </div>
              ))}
            </div>
          )}
          {bols.length === 0 && (
            <div style={st.card}>
              <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>No BOLs uploaded yet.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const st = {
  loginContainer: {
    minHeight: '100vh', backgroundColor: '#0a0a0a', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,sans-serif', padding: 24,
  },
  loginCard: {
    backgroundColor: '#1a1a1a', borderRadius: 16, padding: 40, width: '100%', maxWidth: 400,
    border: '1px solid #333',
  },
  loginInput: {
    width: '100%', padding: '14px 16px', borderRadius: 8, border: '1px solid #444',
    backgroundColor: '#222', color: '#fff', fontSize: 18, boxSizing: 'border-box',
    textAlign: 'center', letterSpacing: 2,
  },
  loginBtn: {
    width: '100%', padding: '14px', borderRadius: 8, border: 'none',
    backgroundColor: '#3B82F6', color: '#fff', fontSize: 16, fontWeight: 700,
    cursor: 'pointer', marginTop: 16,
  },
  container: {
    minHeight: '100vh', backgroundColor: 'var(--bg, #0a0a0a)', color: 'var(--text, #fff)',
    padding: '16px 16px 40px', fontFamily: 'system-ui,sans-serif', maxWidth: 900, margin: '0 auto',
  },
  topBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 24, paddingBottom: 16, borderBottom: '1px solid #222',
  },
  logoutBtn: {
    padding: '6px 16px', borderRadius: 6, border: '1px solid #444',
    backgroundColor: 'transparent', color: '#888', fontSize: 13, cursor: 'pointer',
  },
  text: { color: '#aaa', fontSize: 16 },
  statsRow: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 },
  statBox: {
    backgroundColor: '#1a1a1a', borderRadius: 10, padding: '16px 16px', flex: 1,
    minWidth: 100, textAlign: 'center', border: '1px solid #222',
  },
  statVal: { fontSize: 'clamp(22px, 4vw, 32px)', fontWeight: 800, color: '#fff', lineHeight: 1 },
  statLbl: { fontSize: 11, color: '#666', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  tabBar: { display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' },
  tab: {
    padding: '8px 16px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: '#222',
    backgroundColor: '#111', color: '#666', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  tabActive: { borderColor: '#3B82F6', color: '#3B82F6', backgroundColor: '#0f1d3a' },
  card: {
    backgroundColor: '#1a1a1a', borderRadius: 12, padding: 20, border: '1px solid #222', marginBottom: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: 700, color: '#ccc', marginTop: 0, marginBottom: 12 },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#888', marginBottom: 6, marginTop: 14 },
  input: {
    width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid #333',
    backgroundColor: '#222', color: '#fff', fontSize: 15, boxSizing: 'border-box',
  },
  smallBtn: {
    padding: '6px 12px', borderRadius: 6, border: '1px solid #333',
    backgroundColor: '#1a1a1a', color: '#aaa', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  primaryBtn: {
    padding: '14px 28px', borderRadius: 8, border: 'none',
    backgroundColor: '#22C55E', color: '#fff', fontSize: 16, fontWeight: 700,
    cursor: 'pointer', width: '100%',
  },
  th: { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #333', color: '#888', fontWeight: 600, position: 'sticky', top: 0, backgroundColor: '#0a0a0a' },
  td: { padding: '6px 12px', borderBottom: '1px solid #222', color: '#ccc' },
};