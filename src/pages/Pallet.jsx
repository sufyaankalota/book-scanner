import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Printer, CheckCircle2, AlertTriangle, GraduationCap, Plus, Trash2 } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import {
  openPallet, addBoxToPallet, closePallet, checkPalletLimits, watchOpenPallets, deletePallet,
  MAX_PALLET_WEIGHT_LB, MAX_PALLET_HEIGHT_IN,
} from '../utils/palletStore';
import { getBox } from '../utils/boxStore';
import { printPalletLabel } from '../utils/labels';
import { useScanInput } from '../hooks/useScanInput';

export default function Pallet() {
  const [job, setJob] = useState(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [operator, setOperator] = useState(() => localStorage.getItem('pallet_operator') || '');
  const [station, setStation] = useState(() => localStorage.getItem('pallet_station') || 'PALLET-1');
  const [entered, setEntered] = useState(() => Boolean(localStorage.getItem('pallet_operator')));
  const [training, setTraining] = useState(false);

  const [openPallets, setOpenPallets] = useState([]);
  const palletByPoRef = useRef({});
  const [measure, setMeasure] = useState({}); // { palletId: { w, h } }
  const [flash, setFlash] = useState(null);
  const [busy, setBusy] = useState(false);

  const flashTimer = useRef(null);
  const showFlash = useCallback((tone, msg) => {
    setFlash({ tone, msg });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2800);
  }, []);

  // Packing job: prefer the live (active) pack job; fall back to a test pack
  // job so the station works pre-launch without touching the live scan job.
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.workflow', '==', 'pack'));
    const unsub = onSnapshot(q, (snap) => {
      const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const active = jobs.find((j) => j.meta?.active);
      const test = jobs.find((j) => j.meta?.test);
      setJob(active || test || null);
      setJobLoading(false);
    }, () => setJobLoading(false));
    return unsub;
  }, []);

  // Open pallets (live) -> map PO -> newest open pallet
  useEffect(() => {
    if (!job) { setOpenPallets([]); palletByPoRef.current = {}; return undefined; }
    const unsub = watchOpenPallets(job.id, (pallets) => {
      setOpenPallets(pallets);
      const map = {};
      const sorted = [...pallets].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      for (const p of sorted) if (!map[p.poName]) map[p.poName] = p;
      palletByPoRef.current = map;
    });
    return unsub;
  }, [job]);

  // Scan a box QR -> attach to its PO's open pallet (open one if needed)
  const onScan = useCallback(async (raw) => {
    if (!job) { showFlash('error', 'No active packing job'); return; }
    const boxId = String(raw || '').trim();
    if (!boxId) return;
    setBusy(true);
    try {
      const box = await getBox(boxId);
      if (!box) { showFlash('error', `Unknown box: ${boxId}`); return; }
      if (box.status !== 'closed') { showFlash('error', `${boxId} is not closed yet`); return; }
      if (box.palletId) { showFlash('warn', `${boxId} already on ${box.palletId}`); return; }
      const po = box.poName;

      if (training) {
        showFlash('success', `TRAIN \u00b7 ${boxId} -> ${po} pallet`);
        return;
      }

      let pallet = palletByPoRef.current[po];
      if (!pallet) {
        pallet = await openPallet({ jobId: job.id, poName: po, assignedBy: operator, test: Boolean(job.meta?.test) });
        palletByPoRef.current[po] = pallet;
      }
      const res = await addBoxToPallet(pallet.id, boxId);
      showFlash('success', `${boxId} -> ${pallet.id} (${res.boxCount} boxes)`);
    } catch (e) {
      showFlash('error', e.message || 'Failed to add box');
    } finally {
      setBusy(false);
    }
  }, [job, training, operator, showFlash]);

  useScanInput(onScan, { enabled: entered });

  const startPallet = useCallback(async (po) => {
    if (training) { showFlash('warn', 'Training mode - pallet not saved'); return; }
    try {
      const p = await openPallet({ jobId: job.id, poName: po, assignedBy: operator, test: Boolean(job.meta?.test) });
      palletByPoRef.current[po] = p;
      showFlash('success', `Opened ${p.id}`);
    } catch (e) { showFlash('error', e.message || 'Failed to open pallet'); }
  }, [job, operator, training, showFlash]);

  const handleClose = useCallback(async (pallet) => {
    const m = measure[pallet.id] || {};
    const weightLb = m.w === '' || m.w == null ? null : Number(m.w);
    const heightIn = m.h === '' || m.h == null ? null : Number(m.h);
    const chk = checkPalletLimits({ weightLb, heightIn });
    if (!chk.ok) { showFlash('error', chk.error); return; }
    try {
      if (!training) await closePallet(pallet.id, { weightLb, heightIn });
      printPalletLabel({ palletId: pallet.id, po: pallet.poName, boxCount: pallet.boxCount || 0, jobName: job?.meta?.name }, 4);
      palletByPoRef.current[pallet.poName] = undefined;
      showFlash('success', `Closed ${pallet.id} - printing x4`);
    } catch (e) { showFlash('error', e.message || 'Failed to close pallet'); }
  }, [measure, training, job, showFlash]);

  const setM = (palletId, key, val) => setMeasure((prev) => ({ ...prev, [palletId]: { ...prev[palletId], [key]: val } }));

  // Undo an extra / mistaken pallet. Frees its boxes so they can be re-scanned.
  const removePallet = useCallback(async (pallet) => {
    const n = pallet.boxCount || 0;
    const msg = n > 0
      ? `Delete ${pallet.id}?\n\nIts ${n} box${n === 1 ? '' : 'es'} will be freed to scan onto another pallet.`
      : `Delete empty ${pallet.id}?`;
    if (!window.confirm(msg)) return;
    try {
      if (!training) await deletePallet(pallet.id);
      palletByPoRef.current[pallet.poName] = undefined;
      setMeasure((prev) => { const next = { ...prev }; delete next[pallet.id]; return next; });
      showFlash('success', `Removed ${pallet.id}`);
    } catch (e) { showFlash('error', e.message || 'Failed to remove pallet'); }
  }, [training, showFlash]);

  // ── Render ──
  if (jobLoading) return <Shell><p style={st.dim}>{'Loading\u2026'}</p></Shell>;

  if (!entered) {
    return (
      <Shell>
        <h2 style={st.h2}>Pallet station</h2>
        <label style={st.label}>Your name</label>
        <input style={st.input} value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="e.g. Sam" autoFocus />
        <label style={st.label}>Station</label>
        <input style={st.input} value={station} onChange={(e) => setStation(e.target.value)} placeholder="PALLET-1" />
        <button style={st.primary} disabled={!operator.trim()} onClick={() => {
          localStorage.setItem('pallet_operator', operator.trim());
          localStorage.setItem('pallet_station', station.trim() || 'PALLET-1');
          setEntered(true);
        }}>Start palletizing</button>
      </Shell>
    );
  }

  if (!job) {
    return <Shell><h2 style={st.h2}>Pallet station</h2><p style={st.warn}><AlertTriangle size={16} /> No active packing job.</p></Shell>;
  }

  const pos = Array.from(new Set([...(openPallets.map((p) => p.poName)), ...Object.keys(job.manifestMeta?.poCounts || {})])).filter(Boolean);

  return (
    <Shell>
      <div style={st.topBar}>
        <h1 style={st.h1}>{`Pallet${job.meta?.test ? ' \u00b7 TEST' : ''}`}</h1>
        <label style={st.trainToggle}>
          <input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />
          <GraduationCap size={14} /> Training
        </label>
      </div>
      <p style={st.sub}>{`${operator} \u00b7 ${station} \u00b7 max ${MAX_PALLET_WEIGHT_LB} lb / ${MAX_PALLET_HEIGHT_IN} in`}</p>

      {flash && (
        <div style={{ ...st.flash, ...(flash.tone === 'success' ? st.flashOk : flash.tone === 'warn' ? st.flashWarn : st.flashErr) }}>
          {flash.tone === 'success' ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />} {flash.msg}
        </div>
      )}

      <div style={st.scanCue}><Layers size={20} /> Scan a box label to add it to its pallet</div>

      {openPallets.length === 0 && (
        <div style={st.empty}>No open pallets yet. Scan a box, or start one below.</div>
      )}

      {openPallets.map((p) => {
        const m = measure[p.id] || {};
        const over = checkPalletLimits({ weightLb: m.w === '' || m.w == null ? null : Number(m.w), heightIn: m.h === '' || m.h == null ? null : Number(m.h) });
        const showWarn = !over.ok && (m.w || m.h);
        return (
          <div key={p.id} style={st.pCard}>
            <button style={st.pRemove} onClick={() => removePallet(p)} aria-label="Remove pallet" title="Remove this pallet">
              <Trash2 size={18} />
            </button>
            <div style={st.pPo}><Layers size={18} /> {p.poName}</div>
            <div style={st.pCount}>{p.boxCount || 0}<span style={st.pCountUnit}> boxes</span></div>
            <div style={st.pId}>{p.id}</div>
            <div style={st.measRow}>
              <input style={st.measInput} inputMode="decimal" placeholder="Weight lb" value={m.w ?? ''} onChange={(e) => setM(p.id, 'w', e.target.value)} />
              <input style={st.measInput} inputMode="decimal" placeholder="Height in" value={m.h ?? ''} onChange={(e) => setM(p.id, 'h', e.target.value)} />
            </div>
            {showWarn ? <div style={st.limitWarn}><AlertTriangle size={14} /> {over.error}</div> : null}
            <button style={st.closeBtn} onClick={() => handleClose(p)}>
              <Printer size={18} /> Close + print x4
            </button>
          </div>
        );
      })}

      {pos.length > 0 && (
        <div style={st.startWrap}>
          <div style={st.startLabel}>Start a new pallet</div>
          <div style={st.startRow}>
            {pos.map((po) => (
              <button key={po} style={st.startBtn} onClick={() => startPallet(po)}><Plus size={18} /> {po}</button>
            ))}
          </div>
        </div>
      )}

      <p style={st.syncNote}>Pallets sync live across every station {'\u2014'} numbers are assigned once and never repeat.</p>
    </Shell>
  );
}

function Shell({ children, wide }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', fontFamily: 'var(--font-sans)', padding: '20px clamp(16px, 2.5vw, 36px) 40px', boxSizing: 'border-box' }}>
      <Link to="/" style={{ color: 'var(--text-tertiary, #888)', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>{'\u2190 Home'}</Link>
      <div style={{ maxWidth: wide ? 1100 : 460, margin: wide ? '12px 0' : '12px auto' }}>{children}</div>
    </div>
  );
}

const st = {
  h1: { fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-display)' },
  h2: { fontSize: 20, fontWeight: 800, margin: '0 0 12px', fontFamily: 'var(--font-display)' },
  dim: { color: 'var(--text-secondary, #888)', fontSize: 14, margin: '4px 0' },
  sub: { color: 'var(--text-secondary,#888)', fontSize: 13, margin: '2px 0 14px' },
  warn: { color: 'var(--warning, #f5a524)', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 },
  label: { display: 'block', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 700, margin: '14px 0 6px' },
  input: { width: '100%', padding: '14px', borderRadius: 10, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #1a1a1a)', color: 'var(--text, #fff)', fontSize: 17, boxSizing: 'border-box' },
  primary: { marginTop: 16, padding: '16px 20px', borderRadius: 12, border: 'none', background: 'var(--accent, #4d7cff)', color: 'var(--accent-contrast, #fff)', fontSize: 17, fontWeight: 800, cursor: 'pointer', width: '100%' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  trainToggle: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-secondary,#ccc)', cursor: 'pointer', flexShrink: 0 },
  flash: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderRadius: 12, fontSize: 18, fontWeight: 800, margin: '8px 0 14px' },
  flashOk: { background: 'var(--success-soft)', border: '1px solid var(--success)', color: 'var(--success)' },
  flashWarn: { background: 'var(--warning-soft)', border: '1px solid var(--warning)', color: 'var(--warning)' },
  flashErr: { background: 'var(--error-soft)', border: '1px solid var(--error)', color: 'var(--error)' },
  scanCue: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: '14px 16px', borderRadius: 12, border: '1px dashed var(--border,#3a4150)', color: 'var(--text-secondary,#bbb)', fontSize: 15, fontWeight: 700, marginBottom: 16 },
  empty: { color: 'var(--text-secondary,#888)', fontSize: 15, textAlign: 'center', padding: '16px 0' },
  pCard: { position: 'relative', background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 16, padding: 18, marginBottom: 14, boxShadow: 'var(--shadow-card)' },
  pRemove: { position: 'absolute', top: 12, right: 12, width: 40, height: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid var(--border,#3a2330)', background: 'var(--error-soft)', color: 'var(--error,#f0506e)', cursor: 'pointer' },
  pPo: { fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: 8, paddingRight: 48 },
  pCount: { fontSize: 44, fontWeight: 800, fontFamily: 'var(--font-display)', lineHeight: 1.05, margin: '6px 0' },
  pCountUnit: { fontSize: 16, fontWeight: 700, color: 'var(--text-secondary,#888)' },
  pId: { fontFamily: 'monospace', fontSize: 13, color: 'var(--text-secondary,#aaa)', marginBottom: 10 },
  measRow: { display: 'flex', gap: 10, margin: '6px 0' },
  measInput: { width: '50%', padding: '14px', borderRadius: 10, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#1a1a1a)', color: 'var(--text,#fff)', fontSize: 17, textAlign: 'center', boxSizing: 'border-box' },
  limitWarn: { color: 'var(--error)', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0' },
  closeBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '16px', borderRadius: 12, border: '1px solid var(--success)', background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 800, fontSize: 16, cursor: 'pointer', width: '100%', marginTop: 10 },
  startWrap: { marginTop: 8, marginBottom: 8 },
  startLabel: { textAlign: 'center', color: 'var(--text-tertiary,#999)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  startRow: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' },
  startBtn: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderRadius: 12, border: '1px solid var(--accent,#4d7cff)', background: 'var(--accent-soft)', color: 'var(--accent,#4d7cff)', fontWeight: 800, fontSize: 16, cursor: 'pointer' },
  syncNote: { textAlign: 'center', color: 'var(--text-tertiary,#777)', fontSize: 12, marginTop: 18 },
};
