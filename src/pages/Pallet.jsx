import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Printer, CheckCircle2, AlertTriangle, GraduationCap, Trash2 } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import {
  openPallet, addBoxToPallet, closePallet, checkPalletLimits, watchOpenPallets, deletePallet,
} from '../utils/palletStore';
import { getBox } from '../utils/boxStore';
import { printPalletLabel } from '../utils/labels';
import { useScanInput } from '../hooks/useScanInput';
import { makePoColorFor } from '../utils/poColors';
import OperatorEntry from '../components/OperatorEntry';

// Human-friendly pallet name. `number` is the job-wide Pallet 1,2,3…; older
// pallets created before numbering fall back to the license-plate id.
function palletName(p) {
  return p && p.number != null ? `Pallet ${p.number}` : (p && p.id) || 'Pallet';
}

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
  const [lastAdd, setLastAdd] = useState(null); // { number, po, boxCount, boxId } — the box just scanned
  const [closingId, setClosingId] = useState(null); // pallet id currently being weighed + printed

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
      setLastAdd({ number: pallet.number ?? null, po, boxCount: res.boxCount, boxId });
    } catch (e) {
      showFlash('error', e.message || 'Failed to add box');
    } finally {
      setBusy(false);
    }
  }, [job, training, operator, showFlash]);

  useScanInput(onScan, { enabled: entered });

  const handleClose = useCallback(async (pallet) => {
    const m = measure[pallet.id] || {};
    const weightLb = m.w === '' || m.w == null ? null : Number(m.w);
    const heightIn = m.h === '' || m.h == null ? null : Number(m.h);
    const chk = checkPalletLimits({ weightLb, heightIn });
    if (!chk.ok) { showFlash('error', chk.error); return; }
    try {
      if (!training) await closePallet(pallet.id, { weightLb, heightIn, finalizedBy: operator });
      printPalletLabel({ palletId: pallet.id, number: pallet.number, po: pallet.poName, boxCount: pallet.boxCount || 0, jobName: job?.meta?.name, finalizedBy: operator }, 4);
      palletByPoRef.current[pallet.poName] = undefined;
      setClosingId(null);
      setLastAdd(null);
      setMeasure((prev) => { const next = { ...prev }; delete next[pallet.id]; return next; });
      showFlash('success', `${palletName(pallet)} done \u2014 printing 4 labels`);
    } catch (e) { showFlash('error', e.message || 'Failed to close pallet'); }
  }, [measure, training, job, operator, showFlash]);

  const setM = (palletId, key, val) => setMeasure((prev) => ({ ...prev, [palletId]: { ...prev[palletId], [key]: val } }));

  // Undo an extra / mistaken pallet. Frees its boxes so they can be re-scanned.
  const removePallet = useCallback(async (pallet) => {
    const n = pallet.boxCount || 0;
    const msg = n > 0
      ? `Remove ${palletName(pallet)}?\n\nIts ${n} box${n === 1 ? '' : 'es'} go back so you can scan them onto another pallet.`
      : `Remove empty ${palletName(pallet)}?`;
    if (!window.confirm(msg)) return;
    try {
      if (!training) await deletePallet(pallet.id);
      palletByPoRef.current[pallet.poName] = undefined;
      if (closingId === pallet.id) setClosingId(null);
      setMeasure((prev) => { const next = { ...prev }; delete next[pallet.id]; return next; });
      showFlash('success', `Removed ${palletName(pallet)}`);
    } catch (e) { showFlash('error', e.message || 'Failed to remove pallet'); }
  }, [training, closingId, showFlash]);

  // ── Render ──
  if (jobLoading) return <Shell><p style={st.dim}>{'Loading\u2026'}</p></Shell>;

  if (!entered) {
    return (
      <OperatorEntry
        title="Pallet station"
        subtitle="Scan boxes onto pallets, then print pallet labels."
        stationLabel="Station"
        stationDefault={station || 'PALLET-1'}
        stationPlaceholder="PALLET-1"
        cta="Start palletizing"
        onStart={({ name, station: st0 }) => {
          localStorage.setItem('pallet_operator', name);
          localStorage.setItem('pallet_station', st0);
          setOperator(name);
          setStation(st0);
          setEntered(true);
        }}
      />
    );
  }

  if (!job) {
    return <Shell><h2 style={st.h2}>Pallet station</h2><p style={st.warn}><AlertTriangle size={16} /> No active packing job.</p></Shell>;
  }

  const poColorFor = makePoColorFor(job);

  return (
    <Shell>
      <div style={st.topBar}>
        <h1 style={st.h1}>{`Pallets${job.meta?.test ? ' \u00b7 TEST' : ''}`}</h1>
        <label style={st.trainToggle}>
          <input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />
          <GraduationCap size={14} /> Training
        </label>
      </div>
      <p style={st.sub}>{`${operator} \u00b7 ${station}`}</p>

      {/* The one thing that matters after a scan: which pallet to stack it on */}
      {/* The one thing that matters after a scan: which PO pallet to stack it on */}
      {lastAdd ? (
        <div style={{ ...st.hero, borderLeftColor: poColorFor(lastAdd.po) }}>
          <div style={st.heroBody}>
            <div style={st.heroKicker}>Put this box on</div>
            <div style={st.heroTitle}><span style={{ ...st.dot, background: poColorFor(lastAdd.po) }} /> {lastAdd.po}</div>
            <div style={st.heroSub}>{`${lastAdd.number != null ? `Pallet ${lastAdd.number} \u00b7 ` : ''}${lastAdd.boxCount} box${lastAdd.boxCount === 1 ? '' : 'es'} now`}</div>
          </div>
          <CheckCircle2 size={32} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--success)' }} />
        </div>
      ) : (
        <div style={st.scanCue}><Layers size={24} /> Scan a box to begin</div>
      )}

      {flash && (
        <div style={{ ...st.flash, ...(flash.tone === 'success' ? st.flashOk : flash.tone === 'warn' ? st.flashWarn : st.flashErr) }}>
          {flash.tone === 'success' ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />} {flash.msg}
        </div>
      )}

      {openPallets.length > 0 && <div style={st.sectionLabel}>{'Pallets you\u2019re building'}</div>}

      {openPallets.map((p) => {
        const m = measure[p.id] || {};
        const over = checkPalletLimits({ weightLb: m.w === '' || m.w == null ? null : Number(m.w), heightIn: m.h === '' || m.h == null ? null : Number(m.h) });
        const showWarn = !over.ok && (m.w || m.h);
        const closing = closingId === p.id;
        const color = poColorFor(p.poName);
        const active = lastAdd && lastAdd.number != null && lastAdd.number === p.number;
        return (
          <div key={p.id} style={{ ...st.pCard, borderLeft: `8px solid ${color}`, ...(active ? { boxShadow: `0 0 0 2px ${color}`, borderColor: color } : null) }}>
            <div style={st.pHead}>
              <div style={{ minWidth: 0 }}>
                <div style={st.pName}><span style={{ ...st.dot, background: color }} /> {p.poName}</div>
                <div style={st.pMeta}>{`${palletName(p)} \u00b7 ${p.boxCount || 0} box${(p.boxCount || 0) === 1 ? '' : 'es'}`}</div>
              </div>
              <div style={{ ...st.pBig, color }}>{p.boxCount || 0}</div>
            </div>

            {closing ? (
              <div style={st.closeBox}>
                <div style={st.closeHint}>Weigh the pallet and measure its height, then print.</div>
                <div style={st.measRow}>
                  <input style={st.measInput} inputMode="decimal" placeholder="Weight lb" value={m.w ?? ''} onChange={(e) => setM(p.id, 'w', e.target.value)} autoFocus />
                  <input style={st.measInput} inputMode="decimal" placeholder="Height in" value={m.h ?? ''} onChange={(e) => setM(p.id, 'h', e.target.value)} />
                </div>
                {showWarn ? <div style={st.limitWarn}><AlertTriangle size={14} /> {over.error}</div> : null}
                <button style={st.closeBtn} onClick={() => handleClose(p)}><Printer size={18} /> Print 4 labels &amp; finish</button>
                <button style={st.linkBtn} onClick={() => setClosingId(null)}>Cancel</button>
              </div>
            ) : (
              <div style={st.cardActions}>
                <button style={st.fullBtn} onClick={() => setClosingId(p.id)}><Printer size={18} /> Pallet full {'\u2014'} weigh &amp; print</button>
                <button style={st.removeBtn} onClick={() => removePallet(p)} aria-label="Remove pallet"><Trash2 size={16} /></button>
              </div>
            )}
          </div>
        );
      })}

      <p style={st.help}>{'Each box already knows its pallet \u2014 just scan it and stack it where the app says.'}</p>
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
  sub: { color: 'var(--text-secondary,#888)', fontSize: 13, margin: '2px 0 16px' },
  warn: { color: 'var(--warning, #f5a524)', fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 },
  label: { display: 'block', color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 700, margin: '14px 0 6px' },
  input: { width: '100%', padding: '14px', borderRadius: 10, border: '1px solid var(--border, #444)', background: 'var(--bg-input, #1a1a1a)', color: 'var(--text, #fff)', fontSize: 17, boxSizing: 'border-box' },
  primary: { marginTop: 16, padding: '16px 20px', borderRadius: 12, border: 'none', background: 'var(--accent, #4d7cff)', color: 'var(--accent-contrast, #fff)', fontSize: 17, fontWeight: 800, cursor: 'pointer', width: '100%' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  trainToggle: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-secondary,#ccc)', cursor: 'pointer', flexShrink: 0 },
  hero: { display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 16, background: 'var(--success-soft)', border: '2px solid var(--success)', borderLeftWidth: 8, color: 'var(--text,#e8eef7)', marginBottom: 16 },
  heroBody: { minWidth: 0 },
  heroKicker: { fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--success)' },
  heroTitle: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 26, fontWeight: 800, fontFamily: 'var(--font-display)', lineHeight: 1.1, margin: '2px 0' },
  heroSub: { fontSize: 14, fontWeight: 700, color: 'var(--text-secondary,#9aa4b2)' },
  dot: { width: 14, height: 14, borderRadius: 4, flexShrink: 0, display: 'inline-block' },
  scanCue: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center', padding: '24px 16px', borderRadius: 16, border: '2px dashed var(--border,#3a4150)', color: 'var(--text-secondary,#bbb)', fontSize: 18, fontWeight: 800, marginBottom: 16 },
  flash: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderRadius: 12, fontSize: 16, fontWeight: 800, marginBottom: 14 },
  flashOk: { background: 'var(--success-soft)', border: '1px solid var(--success)', color: 'var(--success)' },
  flashWarn: { background: 'var(--warning-soft)', border: '1px solid var(--warning)', color: 'var(--warning)' },
  flashErr: { background: 'var(--error-soft)', border: '1px solid var(--error)', color: 'var(--error)' },
  sectionLabel: { color: 'var(--text-tertiary,#999)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, margin: '6px 0 10px' },
  pCard: { background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 16, padding: 18, marginBottom: 14, boxShadow: 'var(--shadow-card)' },
  pHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pName: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-display)' },
  pMeta: { fontSize: 14, color: 'var(--text-secondary,#9aa4b2)', marginTop: 2, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pBig: { fontSize: 44, fontWeight: 800, fontFamily: 'var(--font-display)', lineHeight: 1, color: 'var(--accent,#4d7cff)', flexShrink: 0 },
  cardActions: { display: 'flex', gap: 10, alignItems: 'stretch', marginTop: 14 },
  fullBtn: { flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, borderRadius: 12, border: '1px solid var(--success)', background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 800, fontSize: 16, cursor: 'pointer' },
  removeBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', borderRadius: 12, border: '1px solid var(--border,#3a2330)', background: 'var(--error-soft)', color: 'var(--error,#f0506e)', cursor: 'pointer', flexShrink: 0 },
  closeBox: { marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border,#252b3a)' },
  closeHint: { fontSize: 14, color: 'var(--text-secondary,#bbb)', fontWeight: 600, marginBottom: 10, textAlign: 'center' },
  measRow: { display: 'flex', gap: 10 },
  measInput: { width: '50%', padding: 16, borderRadius: 10, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#1a1a1a)', color: 'var(--text,#fff)', fontSize: 18, textAlign: 'center', boxSizing: 'border-box' },
  limitWarn: { color: 'var(--error)', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 0' },
  closeBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, borderRadius: 12, border: '1px solid var(--success)', background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 800, fontSize: 16, cursor: 'pointer', width: '100%', marginTop: 12 },
  linkBtn: { display: 'block', width: '100%', marginTop: 8, padding: 10, borderRadius: 10, border: 'none', background: 'transparent', color: 'var(--text-secondary,#9aa4b2)', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  help: { textAlign: 'center', color: 'var(--text-tertiary,#777)', fontSize: 13, marginTop: 20, lineHeight: 1.5 },
};
