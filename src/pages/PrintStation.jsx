import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Printer, Plus, Trash2, ExternalLink, Play, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import {
  watchPrinters, addPrinter, removePrinter, watchPrinterJobs,
  markJobPrinted, markJobError, clearPrintedJobs,
} from '../lib/printQueue';

// Print a full HTML document silently via a hidden iframe. With Chrome
// kiosk-printing enabled, no dialog appears and it goes to this window's
// default printer.
function printHtml(html) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, { position: 'fixed', right: 0, bottom: 0, width: 0, height: 0, border: 0 });
    document.body.appendChild(iframe);
    let done = false;
    const finish = () => { if (done) return; done = true; setTimeout(() => { try { iframe.remove(); } catch { /* noop */ } resolve(); }, 700); };
    iframe.onload = () => {
      try {
        const w = iframe.contentWindow;
        w.focus();
        setTimeout(() => { try { w.print(); } catch { /* noop */ } finish(); }, 400);
      } catch { finish(); }
    };
    iframe.srcdoc = html;
  });
}

export default function PrintStation() {
  const [params] = useSearchParams();
  const printerId = params.get('printer');
  const printerNameParam = params.get('name') || '';
  return printerId
    ? <Agent printerId={printerId} printerNameParam={printerNameParam} />
    : <Manager />;
}

// ─── Single-printer agent: auto-prints this printer's queued jobs ───
function Agent({ printerId, printerNameParam }) {
  const [armed, setArmed] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [printerName, setPrinterName] = useState(printerNameParam);
  const armedRef = useRef(false);
  const busyRef = useRef(false);
  const handledRef = useRef(new Set());
  const jobsRef = useRef([]);

  useEffect(() => { armedRef.current = armed; }, [armed]);

  useEffect(() => watchPrinters((list) => {
    const p = list.find((x) => x.id === printerId);
    if (p) setPrinterName(p.name);
  }), [printerId]);

  const pump = useCallback(async () => {
    if (!armedRef.current || busyRef.current) return;
    const next = jobsRef.current.find((j) => j.status === 'queued' && !handledRef.current.has(j.id));
    if (!next) return;
    busyRef.current = true; setBusy(true);
    handledRef.current.add(next.id);
    try {
      await printHtml(next.doc?.html || '');
      await markJobPrinted(next.id);
    } catch (e) {
      try { await markJobError(next.id, e.message); } catch { /* noop */ }
    }
    busyRef.current = false; setBusy(false);
    setTimeout(() => pump(), 250);
  }, []);

  useEffect(() => watchPrinterJobs(printerId, (all) => {
    jobsRef.current = all;
    setJobs(all);
    pump();
  }), [printerId, pump]);

  const queued = jobs.filter((j) => j.status === 'queued');
  const recent = [...jobs].reverse().slice(0, 12);

  return (
    <div style={st.page}>
      <div style={st.topRow}>
        <Link to="/print-station" style={st.back}>{'\u2190 All printers'}</Link>
        <span style={st.liveTag}>PRINT AGENT</span>
      </div>
      <div style={st.agentCard}>
        <div style={st.agentHead}>
          <Printer size={28} />
          <div>
            <div style={st.agentName}>{printerName || 'Printer'}</div>
            <div style={st.agentSub}>{`${queued.length} waiting \u00b7 ${busy ? 'printing\u2026' : armed ? 'ready' : 'paused'}`}</div>
          </div>
          {!armed ? (
            <button style={st.armBtn} onClick={() => { setArmed(true); setTimeout(() => pump(), 50); }}><Play size={18} /> Start printing</button>
          ) : (
            <span style={{ ...st.statusPill, ...(busy ? st.pillBusy : st.pillReady) }}>{busy ? 'PRINTING' : 'READY'}</span>
          )}
        </div>
        {!armed && (
          <p style={st.kioskNote}>
            Click <strong>Start printing</strong> once. For fully silent labels, launch Chrome with{' '}
            <code style={st.code}>--kiosk-printing</code> and set this window{"\u2019"}s default printer to{' '}
            <strong>{printerName || 'this device'}</strong>.
          </p>
        )}
      </div>

      <div style={st.feed}>
        <div style={st.feedTitle}>Recent</div>
        {recent.length === 0 && <p style={st.dim}>No jobs yet.</p>}
        {recent.map((j) => (
          <div key={j.id} style={st.feedRow}>
            {j.status === 'printed' ? <CheckCircle2 size={16} style={{ color: 'var(--success,#2fbf71)' }} />
              : j.status === 'error' ? <AlertTriangle size={16} style={{ color: 'var(--error,#f0506e)' }} />
              : <Clock size={16} style={{ color: 'var(--warning,#f5a524)' }} />}
            <span style={st.feedType}>{j.type}</span>
            <span style={st.feedMeta}>{j.meta?.label || j.doc?.title || ''}</span>
            <span style={st.feedBy}>{j.createdBy || ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Manager: register printers + open agent windows ───
function Manager() {
  const [printers, setPrinters] = useState([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('any');

  useEffect(() => watchPrinters(setPrinters), []);

  const add = async () => {
    if (!name.trim()) return;
    await addPrinter({ name: name.trim(), kind });
    setName('');
  };

  return (
    <div style={st.page}>
      <div style={st.topRow}>
        <Link to="/" style={st.back}>{'\u2190 Home'}</Link>
        <span style={st.liveTag}>PRINT STATION</span>
      </div>
      <h1 style={st.h1}>Printers</h1>
      <p style={st.dim}>Register each physical label printer, then open its print agent on the computer wired to it. Pack &amp; pallet stations send labels to these by name.</p>

      <div style={st.addCard}>
        <input style={st.input} value={name} placeholder="Printer name (e.g. Barcode-1, Pallet-2)"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <select style={st.select} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="any">Any label</option>
          <option value="barcode">Barcode (2.25x1.25)</option>
          <option value="box">Box (4x6)</option>
          <option value="pallet">Pallet (4x6)</option>
        </select>
        <button style={st.addBtn} onClick={add} disabled={!name.trim()}><Plus size={16} /> Add</button>
      </div>

      {printers.length === 0 && <p style={st.dim}>No printers yet. Add one above.</p>}
      {printers.map((p) => <PrinterRow key={p.id} printer={p} />)}
    </div>
  );
}

function PrinterRow({ printer }) {
  const [jobs, setJobs] = useState([]);
  useEffect(() => watchPrinterJobs(printer.id, setJobs), [printer.id]);
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const printed = jobs.filter((j) => j.status === 'printed').length;
  const agentUrl = `/print-station?printer=${printer.id}&name=${encodeURIComponent(printer.name)}`;
  return (
    <div style={st.printerRow}>
      <Printer size={20} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={st.printerName}>{printer.name} <span style={st.kindTag}>{printer.kind}</span></div>
        <div style={st.printerStat}>{queued} waiting · {printed} printed</div>
      </div>
      <a href={agentUrl} target="_blank" rel="noreferrer" style={st.openBtn}><ExternalLink size={15} /> Open agent</a>
      <button style={st.clearBtn} onClick={() => clearPrintedJobs(printer.id)} title="Clear printed jobs">Clear</button>
      <button style={st.delBtn} onClick={() => { if (window.confirm(`Remove printer "${printer.name}"?`)) removePrinter(printer.id); }} aria-label="Remove"><Trash2 size={16} /></button>
    </div>
  );
}

const st = {
  page: { minHeight: '100vh', background: 'var(--bg,#0f0f0f)', color: 'var(--text,#f0f0f0)', fontFamily: 'var(--font-sans)', padding: '20px clamp(16px,2.5vw,36px) 40px', boxSizing: 'border-box', maxWidth: 760, margin: '0 auto' },
  topRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  back: { color: 'var(--text-tertiary,#888)', textDecoration: 'none', fontSize: 13, fontWeight: 600 },
  liveTag: { fontSize: 11, fontWeight: 800, letterSpacing: 1, color: 'var(--accent,#4d7cff)', border: '1px solid var(--accent,#4d7cff)', borderRadius: 999, padding: '3px 10px' },
  h1: { fontSize: 26, fontWeight: 800, margin: '0 0 6px', fontFamily: 'var(--font-display)' },
  dim: { color: 'var(--text-secondary,#888)', fontSize: 14, margin: '4px 0 16px' },
  addCard: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 },
  input: { flex: '1 1 240px', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#1a1a1a)', color: 'var(--text,#fff)', fontSize: 15, boxSizing: 'border-box' },
  select: { padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#1a1a1a)', color: 'var(--text,#fff)', fontSize: 14 },
  addBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '12px 18px', borderRadius: 10, border: 'none', background: 'var(--accent,#4d7cff)', color: 'var(--accent-contrast,#fff)', fontWeight: 800, fontSize: 14, cursor: 'pointer' },
  printerRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'var(--bg-input,#161a24)', border: '1px solid var(--border,#252b3a)', borderRadius: 12, marginBottom: 10 },
  printerName: { fontWeight: 800, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 },
  kindTag: { fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary,#888)', border: '1px solid var(--border,#333)', borderRadius: 6, padding: '1px 6px', textTransform: 'uppercase' },
  printerStat: { color: 'var(--text-secondary,#9aa4b2)', fontSize: 13, marginTop: 2 },
  openBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 9, border: '1px solid var(--accent,#4d7cff)', background: 'var(--accent-soft,rgba(77,124,255,.14))', color: 'var(--accent,#7da2ff)', fontWeight: 700, fontSize: 13, textDecoration: 'none' },
  clearBtn: { padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text-secondary,#bbb)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  delBtn: { width: 38, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, border: '1px solid var(--border,#3a2330)', background: 'var(--error-soft,rgba(240,80,110,.12))', color: 'var(--error,#f0506e)', cursor: 'pointer' },
  // agent
  agentCard: { background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 16, padding: 22, marginBottom: 18, boxShadow: 'var(--shadow-card)' },
  agentHead: { display: 'flex', alignItems: 'center', gap: 16 },
  agentName: { fontSize: 26, fontWeight: 800, fontFamily: 'var(--font-display)' },
  agentSub: { color: 'var(--text-secondary,#9aa4b2)', fontSize: 14, marginTop: 2 },
  armBtn: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '14px 22px', borderRadius: 12, border: 'none', background: 'var(--success,#2fbf71)', color: '#04130b', fontWeight: 800, fontSize: 16, cursor: 'pointer' },
  statusPill: { marginLeft: 'auto', fontWeight: 800, fontSize: 13, padding: '8px 16px', borderRadius: 999 },
  pillReady: { background: 'var(--success-soft,rgba(47,191,113,.14))', color: 'var(--success,#2fbf71)', border: '1px solid var(--success,#2fbf71)' },
  pillBusy: { background: 'var(--accent-soft,rgba(77,124,255,.14))', color: 'var(--accent,#7da2ff)', border: '1px solid var(--accent,#4d7cff)' },
  kioskNote: { marginTop: 14, color: 'var(--text-secondary,#9aa4b2)', fontSize: 13, lineHeight: 1.5 },
  code: { background: '#0a0a0a', padding: '1px 6px', borderRadius: 5, fontFamily: 'monospace', fontSize: 12 },
  feed: { background: 'var(--bg-input,#161a24)', border: '1px solid var(--border,#252b3a)', borderRadius: 12, padding: 12 },
  feedTitle: { color: 'var(--text-tertiary,#999)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  feedRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: '1px solid var(--border,#1e1e1e)' },
  feedType: { fontWeight: 700, fontSize: 13, textTransform: 'capitalize', minWidth: 56 },
  feedMeta: { flex: 1, color: 'var(--text-secondary,#bbb)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  feedBy: { color: 'var(--text-tertiary,#888)', fontSize: 12 },
};
