import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Printer, CheckCircle2, AlertTriangle, GraduationCap, Plus } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import {
  openPallet, addBoxToPallet, closePallet, checkPalletLimits, watchOpenPallets,
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

  // Active packing job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.workflow', '==', 'pack'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      setJob(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() });
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
    <Shell wide>
      <div style={st.headerRow}>
        <div>
          <h1 style={st.h1}>{`Pallet \u2014 ${job.meta?.name || ''}${job.meta?.test ? ' (TEST)' : ''}`}</h1>
          <p style={st.dim}>{`${operator} \u00b7 ${station} \u00b7 limits ${MAX_PALLET_WEIGHT_LB} lb / ${MAX_PALLET_HEIGHT_IN} in`}</p>
        </div>
        <label style={st.trainToggle}>
          <input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />
          <GraduationCap size={15} /> Training (no save)
        </label>
      </div>

      {flash && (
        <div style={{ ...st.flash, ...(flash.tone === 'success' ? st.flashOk : flash.tone === 'warn' ? st.flashWarn : st.flashErr) }}>
          {flash.tone === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} {flash.msg}
        </div>
      )}

      <p style={st.hint}><Layers size={14} />{' Scan a box label to add it to its PO pallet. Pallets are single-PO. Enter weight + height to close.'}</p>

      <div style={st.palletGrid}>
        {openPallets.length === 0 && <p style={st.dim}>{'No open pallets - scan a box to open one, or start one below.'}</p>}
        {openPallets.map((p) => {
          const m = measure[p.id] || {};
          const over = checkPalletLimits({ weightLb: m.w === '' || m.w == null ? null : Number(m.w), heightIn: m.h === '' || m.h == null ? null : Number(m.h) });
          return (
            <div key={p.id} style={st.palletCard}>
              <div style={st.palletTop}><Layers size={16} /> <strong>{p.poName}</strong></div>
              <div style={st.palletId}>{p.id}</div>
              <div style={st.palletCount}>{p.boxCount || 0} boxes</div>
              <div style={st.measRow}>
                <input style={st.measInput} inputMode="decimal" placeholder="Weight lb" value={m.w ?? ''} onChange={(e) => setM(p.id, 'w', e.target.value)} />
                <input style={st.measInput} inputMode="decimal" placeholder="Height in" value={m.h ?? ''} onChange={(e) => setM(p.id, 'h', e.target.value)} />
              </div>
              {!over.ok && (m.w || m.h) ? <div style={st.limitWarn}><AlertTriangle size={13} /> {over.error}</div> : null}
              <button style={{ ...st.closeBtn, opacity: busy ? 0.6 : 1 }} onClick={() => handleClose(p)}>
                <Printer size={14} /> Close + label x4
              </button>
            </div>
          );
        })}
      </div>

      {pos.length > 0 && (
        <div style={st.startRow}>
          <span style={st.dim}>Start a new pallet:</span>
          {pos.map((po) => (
            <button key={po} style={st.startBtn} onClick={() => startPallet(po)}><Plus size={14} /> {po}</button>
          ))}
        </div>
      )}
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
  h1: { fontSize: 'clamp(20px, 3vw, 26px)', fontWeight: 800, margin: 0, fontFamily: 'var(--font-display)' },
  h2: { fontSize: 20, fontWeight: 800, margin: '0 0 12px', fontFamily: 'var(--font-display)' },
  dim: { color: 'var(--text-secondary, #888)', fontSize: 14, margin: '4px 0' },
  warn: { color: 'var(--warning, #f5a524)', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 },
  label: { display: 'block', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 700, margin: '14px 0 6px' },
  input: { width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #1a1a1a)', color: 'var(--text, #fff)', fontSize: 16, boxSizing: 'border-box' },
  primary: { marginTop: 16, padding: '12px 20px', borderRadius: 10, border: 'none', background: 'var(--accent, #4d7cff)', color: 'var(--accent-contrast, #fff)', fontSize: 16, fontWeight: 800, cursor: 'pointer' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 },
  trainToggle: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-secondary,#ccc)', cursor: 'pointer' },
  flash: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10, fontSize: 17, fontWeight: 800, marginBottom: 12 },
  flashOk: { background: 'var(--success-soft)', border: '1px solid var(--success)', color: 'var(--success)' },
  flashWarn: { background: 'var(--warning-soft)', border: '1px solid var(--warning)', color: 'var(--warning)' },
  flashErr: { background: 'var(--error-soft)', border: '1px solid var(--error)', color: 'var(--error)' },
  hint: { color: 'var(--text-secondary,#888)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 },
  palletGrid: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, marginBottom: 16 },
  palletCard: { background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 12, padding: 14, minWidth: 240, boxShadow: 'var(--shadow-card)' },
  palletTop: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 },
  palletId: { fontFamily: 'monospace', fontSize: 13, color: 'var(--text-secondary,#aaa)', marginTop: 4 },
  palletCount: { fontSize: 26, fontWeight: 800, fontFamily: 'var(--font-display)', margin: '6px 0' },
  measRow: { display: 'flex', gap: 8, margin: '6px 0' },
  measInput: { width: '50%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#1a1a1a)', color: 'var(--text,#fff)', fontSize: 15, boxSizing: 'border-box' },
  limitWarn: { color: 'var(--error)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 8px' },
  closeBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--success)', background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 800, fontSize: 13, cursor: 'pointer', width: '100%', justifyContent: 'center' },
  startRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  startBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text,#fff)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
};
