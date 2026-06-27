import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Play, Pause, RotateCcw, ChevronLeft, ChevronRight, ScanLine, Camera, Keyboard,
  Package, Box as BoxIcon, Layers, Printer, Truck, CheckCircle2, FileText,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// Customer-facing demo. A self-running, narrated walkthrough of the whole
// flow — scan OR no-barcode lookup → PO box → box label → pallet → pallet
// labels → customer portal manifest. Pure front-end, no data writes.
// ─────────────────────────────────────────────────────────────────────────

const PO_BLUE = '#4d7cff';
const PO_AMBER = '#f5a524';

const STEPS = [
  { key: 'intro', label: 'Start' },
  { key: 'manifest', label: 'Manifest' },
  { key: 'scan', label: 'Scan' },
  { key: 'lookup', label: 'No barcode' },
  { key: 'box', label: 'Into box' },
  { key: 'boxlabel', label: 'Box label' },
  { key: 'handoff', label: 'To pallet' },
  { key: 'pallet', label: 'Palletize' },
  { key: 'palletlabel', label: 'Pallet labels' },
  { key: 'portal', label: 'Portal' },
  { key: 'outro', label: 'Done' },
];

const STEP_MS = 4200;

export default function Demo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timer = useRef(null);
  const last = STEPS.length - 1;

  const go = useCallback((n) => setStep(Math.max(0, Math.min(last, n))), [last]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!playing) return undefined;
    if (step >= last) { setPlaying(false); return undefined; }
    timer.current = setTimeout(() => setStep((s) => Math.min(last, s + 1)), STEP_MS);
    return () => clearTimeout(timer.current);
  }, [step, playing, last]);

  const restart = () => { setStep(0); setPlaying(true); };
  const cur = STEPS[step].key;

  return (
    <div style={st.page}>
      <style>{KEYFRAMES}</style>

      <div style={st.topRow}>
        <Link to="/" style={st.back}>{'\u2190 Home'}</Link>
        <div style={st.brand}>ZoomBooks <span style={{ color: 'var(--text-tertiary,#888)' }}>×</span> PrepFort</div>
        <div style={st.liveTag}>LIVE DEMO</div>
      </div>

      {/* Timeline */}
      <div style={st.timeline}>
        {STEPS.map((sp, i) => (
          <button key={sp.key} onClick={() => { setPlaying(false); go(i); }}
            style={{ ...st.tick, ...(i === step ? st.tickActive : i < step ? st.tickDone : {}) }}>
            <span style={st.tickDot} />
            <span style={st.tickLabel}>{sp.label}</span>
          </button>
        ))}
      </div>

      {/* Stage */}
      <div style={st.stage} key={cur}>
        <Scene step={cur} />
      </div>

      {/* Controls */}
      <div style={st.controls}>
        <button style={st.ctrlBtn} onClick={() => { setPlaying(false); go(step - 1); }} disabled={step === 0}><ChevronLeft size={18} /></button>
        {step >= last ? (
          <button style={st.playBtn} onClick={restart}><RotateCcw size={18} /> Replay</button>
        ) : (
          <button style={st.playBtn} onClick={() => setPlaying((p) => !p)}>
            {playing ? <Pause size={18} /> : <Play size={18} />} {playing ? 'Pause' : 'Play'}
          </button>
        )}
        <button style={st.ctrlBtn} onClick={() => { setPlaying(false); go(step + 1); }} disabled={step === last}><ChevronRight size={18} /></button>
      </div>
    </div>
  );
}

// ─── Scenes ───
function Scene({ step }) {
  switch (step) {
    case 'intro': return <Narrate kicker="Receiving → Outbound" title="One scan to a fully traceable pallet" body="Watch a book travel from the receiving table all the way to an outbound-ready pallet — with a complete manifest at every step.">
      <div style={s2.heroIcons}>
        <Chip icon={ScanLine} label="Scan" /> <Arrow /> <Chip icon={BoxIcon} label="Box" /> <Arrow /> <Chip icon={Layers} label="Pallet" /> <Arrow /> <Chip icon={Truck} label="Truck" />
      </div>
    </Narrate>;

    case 'manifest': return <Narrate kicker="Step 1" title="The customer's manifest is loaded" body="Every title is matched by ISBN to its purchase order. Each PO gets its own color across the whole floor.">
      <div style={s2.table}>
        {[['The Great Gatsby', '9780743273565', 'PO-1001', PO_BLUE], ['1984', '9780451524935', 'PO-1001', PO_BLUE], ['The Hobbit', '9780547928227', 'PO-1001', PO_BLUE], ['Brave New World', '9780060850524', 'PO-2002', PO_AMBER], ['Animal Farm', '9780451526342', 'PO-2002', PO_AMBER]].map((r, i) => (
          <div key={r[1]} style={{ ...s2.tr, animation: `slideUp .4s ${i * 0.08}s both` }}>
            <span style={{ ...s2.dot, background: r[3] }} />
            <span style={s2.tTitle}>{r[0]}</span>
            <span style={s2.tIsbn}>{r[1]}</span>
            <span style={{ ...s2.tPo, color: r[3] }}>{r[2]}</span>
          </div>
        ))}
      </div>
    </Narrate>;

    case 'scan': return <Narrate kicker="Step 2 · Option A" title="Books with a barcode are scanned" body="A single trigger pull reads the ISBN and instantly routes the book to its PO — no typing, no lookups.">
      <div style={s2.scanWrap}>
        <BookCover title="The Great Gatsby" tone={PO_BLUE} />
        <div style={s2.barcodeBox}>
          <Barcode />
          <div style={s2.beam} />
          <div style={s2.isbnText}>9 780743 273565</div>
        </div>
        <Resolved color={PO_BLUE} po="PO-1001" title="The Great Gatsby" />
      </div>
    </Narrate>;

    case 'lookup': return <Narrate kicker="Step 2 · Option B" title="No barcode? Snap the cover or type the title" body="The app suggests matches as you type (or reads the cover with AI), then prints a fresh ISBN label to apply.">
      <div style={s2.scanWrap}>
        <BookCover title="The Hobbit" tone={PO_BLUE} noBarcode />
        <div style={s2.typeBox}>
          <div style={s2.typeRow}><Keyboard size={16} /> <span style={s2.typed}>the hobb<span style={s2.caret} /></span></div>
          <div style={s2.suggest}>
            <div style={{ ...s2.suggestRow, ...s2.suggestActive }}>The Hobbit <span style={s2.suggestMeta}>PO-1001 · 9780547928227</span></div>
            <div style={s2.suggestRow}>The Hobbit: Illustrated <span style={s2.suggestMeta}>—</span></div>
          </div>
          <div style={s2.aiHint}><Camera size={13} /> or AI cover scan</div>
        </div>
        <MiniIsbnLabel title="The Hobbit" />
      </div>
    </Narrate>;

    case 'box': return <Narrate kicker="Step 3" title="Each book drops into its PO box" body="Books are grouped by purchase order automatically. The box keeps a live count — and its own running manifest.">
      <div style={s2.boxScene}>
        <div style={s2.flyBook}>📕</div>
        <BoxBig color={PO_BLUE} po="PO-1001" count={3} animateCount />
      </div>
    </Narrate>;

    case 'boxlabel': return <Narrate kicker="Step 4" title="Box is closed → a QR box label prints" body="The QR is the box's license plate. Scanning it later reveals exactly which books are inside.">
      <div style={s2.labelScene}>
        <BoxLabel />
        <div style={s2.printOut}><Printer size={16} /> Printed to the box-label printer</div>
      </div>
    </Narrate>;

    case 'handoff': return <Narrate kicker="Step 5" title="The box moves to the pallet station" body="Closed boxes flow to palletizing, where they're stacked onto single-PO pallets.">
      <div style={s2.belt}>
        <BoxMini color={PO_BLUE} />
        <div style={s2.beltTrack}><div style={s2.beltBox}>📦</div></div>
        <div style={s2.palletIcon}><Layers size={40} /></div>
      </div>
    </Narrate>;

    case 'pallet': return <Narrate kicker="Step 6" title="Scan the box — the app says which pallet" body="The palletizer never guesses. Color + a clear 'Put it on Pallet N' keeps multiple POs from ever getting mixed.">
      <div style={s2.palletScene}>
        <div style={s2.hero}>
          <CheckCircle2 size={30} style={{ color: 'var(--success,#2fbf71)' }} />
          <div>
            <div style={s2.heroKicker}>Put this box on</div>
            <div style={s2.heroTitle}><span style={{ ...s2.dot, background: PO_BLUE }} /> Pallet 1 · PO-1001</div>
          </div>
        </div>
        <PalletBig color={PO_BLUE} boxes={3} />
      </div>
    </Narrate>;

    case 'palletlabel': return <Narrate kicker="Step 7" title="Pallet full → weighed → 4 labels print" body="Weight and height are captured (max 2,500 lb / 72 in). Each label is stamped 'Finalized by' the employee who closed it.">
      <div style={s2.palletLabels}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ ...s2.palletLabelWrap, animation: `popIn .4s ${i * 0.12}s both`, transform: `rotate(${(i - 1.5) * 3}deg)` }}>
            <PalletLabel />
          </div>
        ))}
      </div>
    </Narrate>;

    case 'portal': return <Narrate kicker="Step 8" title="The customer sees every pallet's manifest" body="In their portal, each pallet expands to the exact books on it — ready to confirm which pallets load onto each outbound truck.">
      <div style={s2.portalCard}>
        <div style={s2.portalHead}><Layers size={16} /> <strong>Pallet 1</strong> <span style={s2.portalTag}>CLOSED</span> <span style={s2.portalMeta}>PO-1001 · 3 boxes · 1,420 lb</span> <span style={{ marginLeft: 'auto', color: '#22C55E', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Truck size={13} /> Ready for outbound</span></div>
        <table style={s2.portalTable}><tbody>
          {[['The Great Gatsby', '9780743273565'], ['1984', '9780451524935'], ['The Hobbit', '9780547928227']].map((r) => (
            <tr key={r[1]}><td style={s2.ptd}>{r[0]}</td><td style={{ ...s2.ptd, fontFamily: 'monospace', color: '#9aa4b2' }}>{r[1]}</td></tr>
          ))}
        </tbody></table>
        <div style={s2.portalDownload}><FileText size={13} /> pallet-1-manifest.csv</div>
      </div>
    </Narrate>;

    case 'outro': return <Narrate kicker="Full chain of custody" title="Book → Box → Pallet → Truck" body="Every item is traceable end to end, and your team sees the manifest in real time. That's the Prepfort prep-and-ship workflow.">
      <div style={s2.heroIcons}>
        <Chip icon={ScanLine} label="Scan" done /> <Arrow /> <Chip icon={BoxIcon} label="Box" done /> <Arrow /> <Chip icon={Layers} label="Pallet" done /> <Arrow /> <Chip icon={Truck} label="Truck" done />
      </div>
    </Narrate>;

    default: return null;
  }
}

// ─── Reusable visual atoms ───
function Narrate({ kicker, title, body, children }) {
  return (
    <div style={s2.narrate}>
      <div style={s2.copy}>
        <div style={s2.kicker}>{kicker}</div>
        <h2 style={s2.title}>{title}</h2>
        <p style={s2.body}>{body}</p>
      </div>
      <div style={s2.visual}>{children}</div>
    </div>
  );
}
function Chip({ icon: Icon, label, done }) {
  return <div style={{ ...s2.chip, ...(done ? s2.chipDone : {}) }}><Icon size={22} /><span>{label}</span></div>;
}
function Arrow() { return <ChevronRight size={20} style={{ color: 'var(--text-tertiary,#888)', flexShrink: 0 }} />; }
function BookCover({ title, tone, noBarcode }) {
  return (
    <div style={{ ...s2.cover, borderColor: tone }}>
      <div style={{ ...s2.coverBand, background: tone }} />
      <div style={s2.coverTitle}>{title}</div>
      {noBarcode ? <div style={s2.noBc}>no barcode</div> : <div style={s2.coverBars}><Barcode small /></div>}
    </div>
  );
}
function Barcode({ small }) {
  const bars = '1 3 1 2 4 1 2 1 3 2 1 4 2 1 3 1 2 2 4 1 2 1 3 1 2 4 1 2 1 3'.split(' ').map(Number);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: small ? 26 : 64 }}>
      {bars.map((w, i) => <div key={i} style={{ width: w * (small ? 1.4 : 3), height: '100%', background: i % 2 ? 'transparent' : '#111' }} />)}
    </div>
  );
}
function QrFaux({ size = 84 }) {
  const cells = [];
  for (let i = 0; i < 49; i++) cells.push(((i * 7 + (i % 5) * 3 + Math.floor(i / 7)) % 3) !== 0);
  return (
    <div style={{ width: size, height: size, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1, background: '#fff', padding: 4, borderRadius: 4 }}>
      {cells.map((on, i) => <div key={i} style={{ background: on ? '#111' : '#fff' }} />)}
    </div>
  );
}
function Resolved({ color, po, title }) {
  return (
    <div style={{ ...s2.resolved, animation: 'popIn .4s 1.2s both' }}>
      <CheckCircle2 size={20} style={{ color: 'var(--success,#2fbf71)' }} />
      <div><div style={{ fontWeight: 800 }}>{title}</div><div style={{ color, fontWeight: 700, fontSize: 13 }}>{po}</div></div>
    </div>
  );
}
function MiniIsbnLabel({ title }) {
  return (
    <div style={{ ...s2.miniLabel, animation: 'popIn .4s 1.1s both' }}>
      <div style={s2.miniTitle}>{title}</div>
      <Barcode small />
      <div style={s2.miniDigits}>9 780547 928227</div>
    </div>
  );
}
function BoxBig({ color, po, count }) {
  return (
    <div style={{ ...s2.boxBig, borderLeft: `8px solid ${color}` }}>
      <div style={s2.boxTop}><BoxIcon size={18} /> <strong>{po}</strong></div>
      <div style={{ ...s2.boxCount, color }}>{count}<span style={s2.boxUnit}> books</span></div>
      <div style={s2.boxBar}><div style={{ ...s2.boxBarFill, width: '60%', background: color }} /></div>
    </div>
  );
}
function BoxMini({ color }) {
  return <div style={{ ...s2.boxMini, borderLeft: `6px solid ${color}` }}><BoxIcon size={16} /> Box</div>;
}
function BoxLabel() {
  return (
    <div style={s2.label46}>
      <div style={s2.brand}>ZoomBooks × PrepFort</div>
      <QrFaux size={96} />
      <div style={s2.labelBig}>BOX</div>
      <div style={s2.labelMono}>BOX-PO1001-00001</div>
      <div style={s2.labelMid}>PO: PO-1001</div>
      <div style={s2.labelSmall}>3 items</div>
    </div>
  );
}
function PalletLabel() {
  return (
    <div style={s2.label46sm}>
      <div style={s2.brandSm}>ZoomBooks × PrepFort</div>
      <QrFaux size={70} />
      <div style={s2.labelBigSm}>PALLET 1</div>
      <div style={s2.labelMonoSm}>PLT-PO1001-001</div>
      <div style={s2.labelMidSm}>PO: PO-1001 · 3 boxes</div>
      <div style={s2.finalizedBy}>Finalized by Maria</div>
    </div>
  );
}
function PalletBig({ color, boxes }) {
  return (
    <div style={s2.palletBig}>
      <div style={s2.palletStack}>
        {Array.from({ length: boxes }).map((_, i) => (
          <div key={i} style={{ ...s2.stackBox, background: color, animation: `popIn .4s ${0.3 + i * 0.18}s both` }}>📦</div>
        ))}
        <div style={s2.palletBase} />
      </div>
      <div style={s2.palletMeta}><strong style={{ fontSize: 18 }}>Pallet 1</strong><div style={{ color, fontWeight: 700 }}>PO-1001 · {boxes} boxes</div></div>
    </div>
  );
}

const KEYFRAMES = `
@keyframes slideUp { from { opacity:0; transform: translateY(10px) } to { opacity:1; transform:none } }
@keyframes popIn { from { opacity:0; transform: scale(.7) } to { opacity:1; transform: scale(1) } }
@keyframes beamMove { 0% { top: 4% } 100% { top: 88% } }
@keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0 } }
@keyframes flyIn { 0% { opacity:0; transform: translate(-60px,-30px) scale(1.4) } 60% { opacity:1 } 100% { opacity:0; transform: translate(70px,28px) scale(.3) } }
@keyframes beltRun { 0% { transform: translateX(-120px) } 100% { transform: translateX(120px) } }
@keyframes countUp { from { opacity:0; transform: translateY(-6px) } to { opacity:1; transform:none } }
`;

const st = {
  page: { minHeight: '100vh', background: 'var(--bg,#0f0f0f)', color: 'var(--text,#f0f0f0)', fontFamily: 'var(--font-sans)', padding: '16px clamp(16px,3vw,48px) 32px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' },
  topRow: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 },
  back: { color: 'var(--text-tertiary,#888)', textDecoration: 'none', fontSize: 13, fontWeight: 600 },
  brand: { fontWeight: 800, fontSize: 18, fontFamily: 'var(--font-display)', marginLeft: 4 },
  liveTag: { marginLeft: 'auto', fontSize: 11, fontWeight: 800, letterSpacing: 1, color: 'var(--success,#2fbf71)', border: '1px solid var(--success,#2fbf71)', borderRadius: 999, padding: '3px 10px' },
  timeline: { display: 'flex', gap: 4, justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap' },
  tick: { flex: 1, minWidth: 64, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, opacity: 0.4 },
  tickActive: { opacity: 1 },
  tickDone: { opacity: 0.75 },
  tickDot: { width: '100%', height: 4, borderRadius: 2, background: 'currentColor' },
  tickLabel: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary,#aaa)' },
  stage: { flex: 1, minHeight: 420, background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 20, padding: 'clamp(20px,3vw,40px)', display: 'flex', alignItems: 'center', boxShadow: 'var(--shadow-card)', animation: 'slideUp .4s both' },
  controls: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 18 },
  ctrlBtn: { width: 44, height: 44, borderRadius: 12, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text,#fff)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  playBtn: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '12px 22px', borderRadius: 12, border: 'none', background: 'var(--accent,#4d7cff)', color: 'var(--accent-contrast,#fff)', fontWeight: 800, fontSize: 15, cursor: 'pointer' },
};

const s2 = {
  narrate: { display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) 1.2fr', gap: 'clamp(20px,4vw,56px)', alignItems: 'center', width: '100%' },
  copy: {},
  kicker: { color: 'var(--accent,#4d7cff)', fontWeight: 800, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  title: { fontSize: 'clamp(22px,3vw,34px)', fontWeight: 800, fontFamily: 'var(--font-display)', margin: '0 0 12px', lineHeight: 1.1 },
  body: { color: 'var(--text-secondary,#aaa)', fontSize: 16, lineHeight: 1.6, margin: 0 },
  visual: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 280 },
  heroIcons: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'center' },
  chip: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '18px 22px', borderRadius: 16, border: '1px solid var(--border,#333)', background: 'var(--bg-input,#1a1f2b)', fontWeight: 700, fontSize: 14, minWidth: 92 },
  chipDone: { borderColor: 'var(--success,#2fbf71)', color: 'var(--success,#2fbf71)' },
  table: { width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 6 },
  tr: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-input,#161a24)', border: '1px solid var(--border,#252b3a)', borderRadius: 10 },
  dot: { width: 12, height: 12, borderRadius: 4, flexShrink: 0 },
  tTitle: { flex: 1, fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tIsbn: { fontFamily: 'monospace', fontSize: 12, color: 'var(--text-tertiary,#888)' },
  tPo: { fontWeight: 800, fontSize: 13, minWidth: 64, textAlign: 'right' },
  scanWrap: { display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', justifyContent: 'center' },
  cover: { width: 110, height: 150, borderRadius: 8, border: '2px solid', background: 'var(--bg-input,#10141d)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 10, boxShadow: 'var(--shadow-card)' },
  coverBand: { height: 8, borderRadius: 4 },
  coverTitle: { fontWeight: 800, fontSize: 14, lineHeight: 1.15 },
  coverBars: { display: 'flex', justifyContent: 'center' },
  noBc: { fontSize: 11, color: 'var(--error,#f0506e)', fontWeight: 700, textAlign: 'center' },
  barcodeBox: { position: 'relative', padding: '14px 16px', background: '#fff', borderRadius: 8, overflow: 'hidden' },
  beam: { position: 'absolute', left: 8, right: 8, height: 3, background: 'rgba(240,80,110,0.9)', boxShadow: '0 0 10px 2px rgba(240,80,110,0.7)', animation: 'beamMove 1.1s ease-in-out infinite alternate' },
  isbnText: { textAlign: 'center', fontFamily: 'monospace', fontSize: 12, color: '#111', marginTop: 4, letterSpacing: 1 },
  resolved: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, background: 'var(--success-soft,rgba(47,191,113,.12))', border: '1px solid var(--success,#2fbf71)' },
  typeBox: { width: 230, padding: 14, borderRadius: 12, background: 'var(--bg-input,#10141d)', border: '1px solid var(--border,#333)' },
  typeRow: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 },
  typed: { fontFamily: 'monospace', fontSize: 15 },
  caret: { display: 'inline-block', width: 2, height: 16, background: 'var(--accent,#4d7cff)', marginLeft: 1, verticalAlign: '-2px', animation: 'blink 1s steps(1) infinite' },
  suggest: { marginTop: 10, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border,#333)' },
  suggestRow: { padding: '9px 10px', fontSize: 13, fontWeight: 600, display: 'flex', justifyContent: 'space-between', gap: 8, background: 'var(--bg-card,#161a24)' },
  suggestActive: { background: 'var(--accent-soft,rgba(77,124,255,.16))', color: 'var(--accent,#7da2ff)' },
  suggestMeta: { color: 'var(--text-tertiary,#888)', fontSize: 11, fontFamily: 'monospace' },
  aiHint: { marginTop: 8, fontSize: 12, color: 'var(--text-secondary,#9aa4b2)', display: 'flex', alignItems: 'center', gap: 6 },
  miniLabel: { width: 140, padding: 10, background: '#fff', color: '#111', borderRadius: 6, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center', boxShadow: 'var(--shadow-card)' },
  miniTitle: { fontWeight: 700, fontSize: 12 },
  miniDigits: { fontFamily: 'monospace', fontSize: 11, letterSpacing: 1 },
  boxScene: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 40, width: '100%' },
  flyBook: { position: 'absolute', left: '24%', fontSize: 30, animation: 'flyIn 1.6s ease-in infinite' },
  boxBig: { width: 220, padding: 18, borderRadius: 14, background: 'var(--bg-input,#161a24)', border: '1px solid var(--border,#252b3a)', boxShadow: 'var(--shadow-card)' },
  boxTop: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 },
  boxCount: { fontSize: 46, fontWeight: 800, fontFamily: 'var(--font-display)', animation: 'countUp .5s both' },
  boxUnit: { fontSize: 15, color: 'var(--text-secondary,#888)', fontWeight: 700 },
  boxBar: { height: 8, borderRadius: 4, background: '#222', overflow: 'hidden', marginTop: 6 },
  boxBarFill: { height: '100%', borderRadius: 4 },
  labelScene: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 },
  label46: { width: 200, padding: 14, background: '#fff', color: '#111', borderRadius: 8, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, boxShadow: 'var(--shadow-elev)', animation: 'popIn .4s both' },
  brand: { fontWeight: 800, fontSize: 12 },
  labelBig: { fontWeight: 800, fontSize: 22 },
  labelMono: { fontFamily: 'monospace', fontSize: 12 },
  labelMid: { fontSize: 13, fontWeight: 700 },
  labelSmall: { fontSize: 11 },
  printOut: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary,#9aa4b2)', fontSize: 14, fontWeight: 600 },
  belt: { display: 'flex', alignItems: 'center', gap: 20, width: '100%', justifyContent: 'center' },
  beltTrack: { flex: 1, maxWidth: 220, height: 56, borderRadius: 10, background: 'repeating-linear-gradient(90deg, #1a1f2b 0 14px, #232a3a 14px 28px)', position: 'relative', overflow: 'hidden', border: '1px solid var(--border,#333)' },
  beltBox: { position: 'absolute', top: 8, fontSize: 30, animation: 'beltRun 1.8s linear infinite' },
  palletIcon: { color: 'var(--accent,#4d7cff)' },
  palletScene: { display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center', width: '100%' },
  hero: { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRadius: 14, background: 'var(--success-soft,rgba(47,191,113,.12))', border: '2px solid var(--success,#2fbf71)', minWidth: 280 },
  heroKicker: { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', color: 'var(--success,#2fbf71)' },
  heroTitle: { fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: 8 },
  palletBig: { display: 'flex', alignItems: 'flex-end', gap: 16 },
  palletStack: { display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', gap: 4 },
  stackBox: { width: 80, height: 36, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, opacity: 0.92 },
  palletBase: { width: 110, height: 12, borderRadius: 3, background: '#6b4f2a', marginTop: 4 },
  palletMeta: { paddingBottom: 8 },
  palletLabels: { display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%' },
  palletLabelWrap: { margin: '0 -14px' },
  label46sm: { width: 130, padding: 10, background: '#fff', color: '#111', borderRadius: 6, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, boxShadow: 'var(--shadow-elev)' },
  brandSm: { fontWeight: 800, fontSize: 9 },
  labelBigSm: { fontWeight: 800, fontSize: 16 },
  labelMonoSm: { fontFamily: 'monospace', fontSize: 9 },
  labelMidSm: { fontSize: 10, fontWeight: 700 },
  finalizedBy: { fontSize: 10, fontWeight: 700, marginTop: 2, padding: '2px 6px', background: '#eee', borderRadius: 4 },
  portalCard: { width: '100%', maxWidth: 460, background: 'var(--bg-input,#161a24)', border: '1px solid var(--border,#252b3a)', borderRadius: 14, padding: 16, animation: 'slideUp .5s both' },
  portalHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14, marginBottom: 10 },
  portalTag: { padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 800, background: '#14532d', color: '#22C55E' },
  portalMeta: { color: 'var(--text-secondary,#9aa4b2)', fontSize: 12 },
  portalTable: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  ptd: { padding: '7px 8px', borderBottom: '1px solid #222', color: '#ddd' },
  portalDownload: { marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent,#7da2ff)', fontFamily: 'monospace' },
};
