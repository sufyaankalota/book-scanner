import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Hash, Search, Package, Printer, CheckCircle2, AlertTriangle, Box as BoxIcon, GraduationCap, X, Download, Camera } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { cleanISBN, isValidISBN, isbnAlternates } from '../utils/isbn';
import { lookupEntry, loadTitleIndex } from '../utils/manifestStore';
import { suggestTitles } from '../utils/fuzzy';
import { openBox, addBoxItem, closeBox, watchOpenBoxes, listBoxesWithItems } from '../utils/boxStore';
import { listPalletsForJob } from '../utils/palletStore';
import { printBookLabel, printBoxLabel, bookLabelDoc, boxLabelDoc } from '../utils/labels';
import { watchPrinters, enqueuePrintJob, getAssignment, setAssignment } from '../lib/printQueue';
import { exportBoxPalletXLSX } from '../utils/export';
import { makePoColorFor } from '../utils/poColors';
import { isScanEngineConfigured, scanEngine } from '../lib/scanEngine';
import { useScanInput } from '../hooks/useScanInput';
import BookCamera from '../components/BookCamera';
import OperatorEntry from '../components/OperatorEntry';

const CLAIM_TTL = 60 * 24 * 3600; // 60 days — a packing job can span weeks

// Live ISBN type-ahead: manifest entries whose ISBN starts with the typed
// digits, deduped to one row per book.
function suggestIsbns(digits, index, limit = 7) {
  const d = String(digits || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (d.length < 3 || !index?.length) return [];
  const seen = new Map();
  for (const row of index) {
    if (!String(row.isbn).toUpperCase().startsWith(d)) continue;
    const key = isbnAlternates(row.isbn).isbn13 || row.isbn;
    if (!seen.has(key)) { seen.set(key, row); if (seen.size >= limit) break; }
  }
  return Array.from(seen.values());
}

export default function Pack() {
  const [job, setJob] = useState(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [operator, setOperator] = useState(() => localStorage.getItem('pack_operator') || '');
  const [station, setStation] = useState(() => localStorage.getItem('pack_station') || 'PACK-1');
  const [entered, setEntered] = useState(() => Boolean(localStorage.getItem('pack_operator')));
  const [training, setTraining] = useState(false);

  const [openBoxes, setOpenBoxes] = useState([]);
  const boxesByPoRef = useRef({});
  const [flash, setFlash] = useState(null); // { tone, msg }
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [printers, setPrinters] = useState([]);
  const [barcodeAssign, setBarcodeAssign] = useState(() => getAssignment('pack_barcode'));
  const [boxAssign, setBoxAssign] = useState(() => getAssignment('pack_box'));
  const [showPrinters, setShowPrinters] = useState(false);
  const [recent, setRecent] = useState([]); // [{ isbn, title, po, boxId, t }]
  const [trainCount, setTrainCount] = useState(0);

  const [showTitle, setShowTitle] = useState(false);
  const [titleQuery, setTitleQuery] = useState('');
  const [candidates, setCandidates] = useState(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [isbnSugg, setIsbnSugg] = useState([]);
  const titleIndexRef = useRef(null);

  const [showManual, setShowManual] = useState(false);
  const [manualIsbn, setManualIsbn] = useState('');

  const [showCamera, setShowCamera] = useState(false);
  const [camCandidates, setCamCandidates] = useState(null); // null = capturing; [] = no match; [...] = pick
  const [camTitle, setCamTitle] = useState('');

  const flashTimer = useRef(null);
  const showFlash = useCallback((tone, msg) => {
    setFlash({ tone, msg });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2600);
  }, []);

  const exportContent = useCallback(async () => {
    if (!job) return;
    setExporting(true);
    try {
      const [boxes, pallets] = await Promise.all([listBoxesWithItems(job.id), listPalletsForJob(job.id)]);
      exportBoxPalletXLSX(boxes, pallets, job.meta || {});
    } catch (e) {
      showFlash('error', e.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [job, showFlash]);

  // ── Packing job: prefer the live (active) pack job; fall back to a test
  //    pack job so the stations can be exercised before go-live WITHOUT
  //    deactivating the live scan job (book-scanner allows one active job). ──
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

  const manifestPath = job ? (job.manifestSource || `jobs/${job.id}`) : null;
  const numChunks = job?.manifestMeta?.numChunks || 0;
  const hasManifest = Boolean(job?.manifestMeta?.chunked);

  // ── Open boxes (live) → map PO -> box ──
  useEffect(() => {
    if (!job) { setOpenBoxes([]); boxesByPoRef.current = {}; return undefined; }
    const unsub = watchOpenBoxes(job.id, (boxes) => {
      setOpenBoxes(boxes);
      const map = {};
      // newest open box per PO wins
      const sorted = [...boxes].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      for (const b of sorted) if (!map[b.poName]) map[b.poName] = b;
      boxesByPoRef.current = map;
    });
    return unsub;
  }, [job]);

  const pushRecent = useCallback((r) => setRecent((prev) => [r, ...prev].slice(0, 8)), []);

  useEffect(() => watchPrinters(setPrinters), []);

  // Route a label to its assigned print-station printer, else print locally.
  const emitBookLabel = useCallback((payload) => {
    if (barcodeAssign?.printerId) {
      enqueuePrintJob({ printerId: barcodeAssign.printerId, printerName: barcodeAssign.printerName, type: 'book', labelDoc: bookLabelDoc(payload), meta: { label: payload.title || payload.isbn13 }, createdBy: operator })
        .catch((e) => showFlash('error', e.message || 'Print queue failed'));
    } else { printBookLabel(payload); }
  }, [barcodeAssign, operator, showFlash]);

  const emitBoxLabel = useCallback((payload) => {
    if (boxAssign?.printerId) {
      enqueuePrintJob({ printerId: boxAssign.printerId, printerName: boxAssign.printerName, type: 'box', labelDoc: boxLabelDoc(payload), meta: { label: payload.boxId }, createdBy: operator })
        .catch((e) => showFlash('error', e.message || 'Print queue failed'));
    } else { printBoxLabel(payload); }
  }, [boxAssign, operator, showFlash]);

  // ── Core: resolve a book to its manifest entry, then pack it ──
  const resolveAndPack = useCallback(async (rawIsbn, { source }) => {
    if (!job || !hasManifest) { showFlash('error', 'No active packing job with a manifest'); return; }
    const isbn = cleanISBN(rawIsbn);
    if (!isValidISBN(isbn)) { showFlash('error', `Not a valid ISBN: ${rawIsbn}`); return; }
    setBusy(true);
    try {
      const entry = await lookupEntry(manifestPath, isbn, numChunks);
      if (!entry || !entry.po) { showFlash('error', `Not in manifest: ${isbn}`); return; }
      const canonical = isbnAlternates(isbn).isbn13 || isbn;
      const po = entry.po;
      const title = entry.title || '';
      const needsPrint = source === 'title' || source === 'manual' || source === 'camera';

      if (training) {
        if (needsPrint) emitBookLabel({ isbn13: canonical, title, po });
        setTrainCount((n) => n + 1);
        showFlash('success', `TRAIN · ${po} · ${title || canonical}`);
        return;
      }

      // Global consume-once (reuse the cross-pod dedup hub). Fail-open if the
      // engine is unreachable, matching the live scan flow's philosophy.
      if (isScanEngineConfigured) {
        try {
          const r = await scanEngine.claim({ jobId: job.id, barcode: canonical, podId: station, scannerId: operator, ttlSeconds: CLAIM_TTL });
          const claimed = (r && typeof r.claimed === 'boolean') ? r.claimed : (r?.result?.claimed ?? true);
          if (!claimed) { showFlash('error', `Already packed: ${title || canonical}`); return; }
        } catch { /* fail-open */ }
      }

      // Route to (or open) this PO's box.
      let box = boxesByPoRef.current[po];
      if (!box) {
        box = await openBox({ jobId: job.id, poName: po, packedBy: operator, station, test: Boolean(job.meta?.test) });
        boxesByPoRef.current[po] = box; // sync guard against rapid double-open
      }
      const res = await addBoxItem(box.id, { isbn13: canonical, title, source: source || 'scan' });
      if (needsPrint) emitBookLabel({ isbn13: canonical, title, po });
      if (res.added === false) showFlash('warn', `Already in ${box.id}`);
      else showFlash('success', `${po} \u2192 ${box.id}`);
      pushRecent({ isbn: canonical, title, po, boxId: box.id, t: Date.now() });
    } catch (e) {
      showFlash('error', e.message || 'Failed to pack');
    } finally {
      setBusy(false);
    }
  }, [job, hasManifest, manifestPath, numChunks, training, station, operator, showFlash, pushRecent, emitBookLabel]);

  // ── Scan input (wedge / native bridge / manual) ──
  const submitScan = useScanInput((code) => resolveAndPack(code, { source: 'scan' }), { enabled: entered && !showTitle && !showManual && !showCamera });

  // ── Live type-ahead (title + ISBN): load the title index when a typeahead
  //    modal opens, then suggest from it (debounced) as the packer types. ──
  useEffect(() => {
    if (!(showTitle || showManual) || !hasManifest || titleIndexRef.current) return undefined;
    let cancelled = false;
    setIndexLoading(true);
    loadTitleIndex(manifestPath, numChunks)
      .then((idx) => { if (!cancelled) titleIndexRef.current = idx; })
      .catch((e) => { if (!cancelled) showFlash('error', e.message || 'Could not load suggestions'); })
      .finally(() => { if (!cancelled) setIndexLoading(false); });
    return () => { cancelled = true; };
  }, [showTitle, showManual, hasManifest, manifestPath, numChunks, showFlash]);

  useEffect(() => {
    if (!showTitle) return undefined;
    const q = titleQuery.trim();
    if (!q) { setCandidates(null); return undefined; }
    const t = setTimeout(() => {
      if (titleIndexRef.current) setCandidates(suggestTitles(q, titleIndexRef.current, 7));
    }, 120);
    return () => clearTimeout(t);
  }, [titleQuery, showTitle, indexLoading]);

  useEffect(() => {
    if (!showManual) return undefined;
    const t = setTimeout(() => {
      setIsbnSugg(titleIndexRef.current ? suggestIsbns(manualIsbn, titleIndexRef.current, 7) : []);
    }, 120);
    return () => clearTimeout(t);
  }, [manualIsbn, showManual, indexLoading]);

  const pickCandidate = useCallback((cand) => {
    setShowTitle(false); setCandidates(null); setTitleQuery('');
    resolveAndPack(cand.isbn, { source: 'title' });
  }, [resolveAndPack]);

  // ── AI cover camera (no-barcode books): extract title + match manifest server-side ──
  const openCamera = useCallback(() => { setCamCandidates(null); setCamTitle(''); setShowCamera(true); }, []);
  const closeCamera = useCallback(() => { setShowCamera(false); setCamCandidates(null); setCamTitle(''); }, []);

  const onCameraResult = useCallback(({ title, candidates }) => {
    setCamTitle(title || '');
    setCamCandidates(Array.isArray(candidates) ? candidates : []);
  }, []);

  const pickCamCandidate = useCallback((cand) => {
    closeCamera();
    resolveAndPack(cand.isbn, { source: 'camera' });
  }, [closeCamera, resolveAndPack]);

  // Couldn't auto-match — hand the extracted title to the title-search modal.
  const camTitleFallback = useCallback(() => {
    const t = camTitle;
    closeCamera();
    setTitleQuery(t); setCandidates(null); setShowTitle(true);
  }, [camTitle, closeCamera]);

  const handleCloseBox = useCallback(async (box) => {
    try {
      if (!training) await closeBox(box.id);
      emitBoxLabel({ boxId: box.id, po: box.poName, itemCount: box.itemCount || 0, jobName: job?.meta?.name });
      boxesByPoRef.current[box.poName] = undefined;
      showFlash('success', `Closed ${box.id}`);
    } catch (e) {
      showFlash('error', e.message || 'Failed to close box');
    }
  }, [training, job, showFlash, emitBoxLabel]);

  // ── Render ──
  if (jobLoading) return <Shell><p style={st.dim}>{'Loading\u2026'}</p></Shell>;

  if (!entered) {
    return (
      <OperatorEntry
        title="Pack station"
        subtitle="Scan or look up each book, pack it into its PO box, then close the box."
        stationLabel="Station"
        stationDefault={station || 'PACK-1'}
        stationPlaceholder="PACK-1"
        cta="Start packing"
        onStart={({ name, station: st0 }) => {
          localStorage.setItem('pack_operator', name);
          localStorage.setItem('pack_station', st0);
          setOperator(name);
          setStation(st0);
          setEntered(true);
        }}
      />
    );
  }

  if (!job) {
    return <Shell><h2 style={st.h2}>Pack station</h2><p style={st.warn}><AlertTriangle size={16} /> No active packing job. Create one in Setup (Workflow = Packing) and activate it.</p></Shell>;
  }

  const poColorFor = makePoColorFor(job);

  return (
    <Shell wide>
      <div style={st.headerRow}>
        <div>
          <h1 style={st.h1}>{`Pack \u2014 ${job.meta?.name || ''}${job.meta?.test ? ' (TEST)' : ''}`}</h1>
          <p style={st.dim}>{`${operator} \u00b7 ${station} \u00b7 ${hasManifest ? `${(job.manifestMeta?.totalIsbns || 0).toLocaleString()} ISBNs` : 'no manifest'}`}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <button style={st.exportBtn} onClick={() => setShowPrinters(true)}>
            <Printer size={15} /> Printers
          </button>
          <button style={st.exportBtn} disabled={exporting} onClick={exportContent}>
            <Download size={15} /> {exporting ? 'Exporting\u2026' : 'Export content'}
          </button>
          <label style={st.trainToggle}>
            <input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />
            <GraduationCap size={15} /> Training (no save)
          </label>
        </div>
      </div>

      {flash && (
        <div style={{ ...st.flash, ...(flash.tone === 'success' ? st.flashOk : flash.tone === 'warn' ? st.flashWarn : st.flashErr) }}>
          {flash.tone === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} {flash.msg}
        </div>
      )}

      {/* Open boxes per PO */}
      <div style={st.boxRow}>
        {openBoxes.length === 0 && <p style={st.dim}>{'No open boxes yet \u2014 scan a book to open one.'}</p>}
        {openBoxes.map((b) => {
          const color = poColorFor(b.poName);
          return (
            <div key={b.id} style={{ ...st.boxCard, borderLeft: `8px solid ${color}` }}>
              <div style={st.boxTop}><span style={{ ...st.dot, background: color }} /> <strong>{b.poName}</strong></div>
              <div style={st.boxId}>{b.id}</div>
              <div style={{ ...st.boxCount, color }}>{b.itemCount || 0} items</div>
              <button style={st.closeBtn} onClick={() => handleCloseBox(b)}><Printer size={14} /> Close + label</button>
            </div>
          );
        })}
      </div>

      {/* Action buttons */}
      <div style={st.scanFocal}>
        <div style={st.scanFocalIcon}><BoxIcon size={26} /></div>
        <div>
          <div style={st.scanFocalTitle}>Scan a book to pack it</div>
          <div style={st.scanFocalSub}>It drops into the matching PO{'\u2019'}s open box automatically.</div>
        </div>
      </div>

      <div style={st.noBarcode}>No barcode?</div>
      <div style={st.actions}>
        <button style={{ ...st.actionTile, ...st.tileAI }} disabled={busy} onClick={openCamera}>
          <Camera size={26} /> Scan cover (AI)
        </button>
        <button style={{ ...st.actionTile, ...st.tileTitle }} disabled={busy} onClick={() => { setShowTitle(true); setCandidates(null); setTitleQuery(''); }}>
          <Search size={26} /> Type title
        </button>
        <button style={{ ...st.actionTile, ...st.tileIsbn }} disabled={busy} onClick={() => { setShowManual(true); setManualIsbn(''); }}>
          <Hash size={26} /> Type ISBN
        </button>
      </div>

      {/* Recent */}
      {(recent.length > 0 || training) && (
        <div style={st.recent}>
          <div style={st.recentTitle}>{training ? `Training \u00b7 ${trainCount} resolved (not saved)` : 'Recent'}</div>
          {recent.map((r) => (
            <div key={r.t} style={st.recentRow}>
              <span style={st.mono}>{r.isbn}</span>
              <span style={st.recentTitleText}>{r.title || '\u2014'}</span>
              <span style={{ ...st.recentPo, color: poColorFor(r.po) }}>{r.po}</span>
              <span style={st.recentBox}>{r.boxId}</span>
            </div>
          ))}
        </div>
      )}

      {/* Title search modal — live suggestions as you type */}
      {showTitle && (
        <Modal onClose={() => setShowTitle(false)} title="Find by title">
          <input style={st.input} value={titleQuery} autoFocus placeholder={'Start typing the title\u2026'}
            onChange={(e) => setTitleQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && candidates && candidates[0]) pickCandidate(candidates[0]); }} />
          {indexLoading && <p style={st.hint}>{'Loading suggestions\u2026'}</p>}
          {!indexLoading && titleQuery.trim() && candidates && candidates.length === 0 && <p style={st.warn}>{'No matches \u2014 try fewer words.'}</p>}
          {candidates && candidates.map((c, i) => (
            <button key={c.isbn} style={st.candidate} onClick={() => pickCandidate(c)}>
              <span style={st.candIdx}>{i + 1}</span>
              <span style={st.candTitle}>{c.title}</span>
              <span style={st.candMeta}>{`${c.po} \u00b7 ${c.isbn}${c.score != null ? ` \u00b7 ${Math.round(c.score * 100)}%` : ''}`}</span>
            </button>
          ))}
        </Modal>
      )}

      {/* Manual ISBN modal — live suggestions as you type */}
      {showManual && (
        <Modal onClose={() => setShowManual(false)} title="Type ISBN">
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={st.input} value={manualIsbn} autoFocus inputMode="numeric" placeholder={'978\u2026'}
              onChange={(e) => setManualIsbn(e.target.value.replace(/[^0-9Xx-]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter' && manualIsbn.trim()) { setShowManual(false); resolveAndPack(manualIsbn, { source: 'manual' }); } }} />
            <button style={st.primary} disabled={!manualIsbn.trim()} onClick={() => { setShowManual(false); resolveAndPack(manualIsbn, { source: 'manual' }); }}>Pack</button>
          </div>
          {indexLoading && <p style={st.hint}>{'Loading suggestions\u2026'}</p>}
          {isbnSugg.map((c) => (
            <button key={c.isbn} style={st.candidate} onClick={() => { setShowManual(false); resolveAndPack(c.isbn, { source: 'manual' }); }}>
              <span style={st.candTitle}>{c.title}</span>
              <span style={st.candMeta}>{`${c.po} \u00b7 ${c.isbn}`}</span>
            </button>
          ))}
          <p style={st.hint}>A 2.25 x 1.25 ISBN label prints to apply to the book.</p>
        </Modal>
      )}

      {/* Printer settings modal */}
      {showPrinters && (
        <Modal onClose={() => setShowPrinters(false)} title="Label printers">
          <PrinterPicker label="Barcode (book ISBN) labels" printers={printers} value={barcodeAssign}
            onChange={(v) => { setAssignment('pack_barcode', v); setBarcodeAssign(v); }} />
          <PrinterPicker label="Box labels" printers={printers} value={boxAssign}
            onChange={(v) => { setAssignment('pack_box', v); setBoxAssign(v); }} />
          <p style={st.hint}>Labels go to the Print Station agent for the chosen printer (no popup). Pick {'\u201c'}This device{'\u201d'} to use the browser print window. Add printers at /print-station.</p>
        </Modal>
      )}

      {/* AI cover camera modal */}
      {showCamera && (
        <Modal onClose={closeCamera} title="Scan cover (AI)">
          {camCandidates === null ? (
            <BookCamera mode="title" jobId={job.id} podId={station} embedded onResult={onCameraResult} onClose={closeCamera} />
          ) : camCandidates.length > 0 ? (
            <div>
              <p style={st.dim}>{camTitle ? `Read: \u201c${camTitle}\u201d \u2014 pick the match:` : 'Pick the match:'}</p>
              {camCandidates.map((c, i) => (
                <button key={c.isbn} style={st.candidate} onClick={() => pickCamCandidate(c)}>
                  <span style={st.candIdx}>{i + 1}</span>
                  <span style={st.candTitle}>{c.title}</span>
                  <span style={st.candMeta}>{`${c.po} \u00b7 ${c.isbn} \u00b7 ${Math.round((c.score || 0) * 100)}%`}</span>
                </button>
              ))}
              <button style={{ ...st.actionBtn, marginTop: 12 }} onClick={() => setCamCandidates(null)}>
                <Camera size={16} /> Retake
              </button>
            </div>
          ) : (
            <div>
              <p style={st.warn}><AlertTriangle size={16} /> {camTitle ? `No manifest match for \u201c${camTitle}\u201d.` : 'Could not read the cover.'}</p>
              <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button style={st.actionBtn} onClick={() => setCamCandidates(null)}><Camera size={16} /> Retake</button>
                {camTitle && <button style={st.actionBtn} onClick={camTitleFallback}><Search size={16} /> Search by title</button>}
                <button style={st.actionBtn} onClick={() => { closeCamera(); setShowManual(true); setManualIsbn(''); }}><Hash size={16} /> Type ISBN</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </Shell>
  );
}

function PrinterPicker({ label, printers, value, onChange }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={st.label}>{label}</label>
      <select style={st.input} value={value?.printerId || ''} onChange={(e) => {
        const id = e.target.value;
        if (!id) { onChange(null); return; }
        const p = printers.find((x) => x.id === id);
        onChange(p ? { printerId: p.id, printerName: p.name } : null);
      }}>
        <option value="">This device (print popup)</option>
        {printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

function Shell({ children, wide }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0f0f0f)', color: 'var(--text, #f0f0f0)', fontFamily: 'var(--font-sans)', padding: '20px clamp(16px, 2.5vw, 36px) 40px', boxSizing: 'border-box' }}>
      <Link to="/" style={{ color: 'var(--text-tertiary, #888)', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>{'\u2190 Home'}</Link>
      <div style={{ maxWidth: wide ? 1400 : 460, margin: '12px auto' }}>{children}</div>
    </div>
  );
}

function Modal({ children, title, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,10,18,0.78)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 14, padding: 22, width: '100%', maxWidth: 560, boxShadow: 'var(--shadow-elev)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ ...st.h2, margin: 0 }}>{title}</h2>
          <button aria-label="Close" onClick={onClose} style={{ background: 'var(--bg-input,#222)', border: '1px solid var(--border,#444)', borderRadius: 8, color: 'var(--text-secondary,#ccc)', width: 36, height: 36, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={18} /></button>
        </div>
        {children}
      </div>
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
  exportBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text,#fff)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  flash: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10, fontSize: 17, fontWeight: 800, marginBottom: 12 },
  flashOk: { background: 'var(--success-soft)', border: '1px solid var(--success)', color: 'var(--success)' },
  flashWarn: { background: 'var(--warning-soft)', border: '1px solid var(--warning)', color: 'var(--warning)' },
  flashErr: { background: 'var(--error-soft)', border: '1px solid var(--error)', color: 'var(--error)' },
  boxRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 18 },
  boxCard: { background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 12, padding: 18, boxShadow: 'var(--shadow-card)' },
  boxTop: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 },
  dot: { width: 14, height: 14, borderRadius: 4, flexShrink: 0, display: 'inline-block' },
  boxId: { fontFamily: 'monospace', fontSize: 13, color: 'var(--text-secondary,#aaa)', marginTop: 4 },
  boxCount: { fontSize: 32, fontWeight: 800, fontFamily: 'var(--font-display)', margin: '6px 0' },
  closeBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text-secondary,#ccc)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  actions: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, maxWidth: 900, margin: '0 auto 18px' },
  scanFocal: { display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center', background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 14, padding: '18px 22px', margin: '4px auto 18px', maxWidth: 760, boxShadow: 'var(--shadow-card)' },
  scanFocalIcon: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)', flexShrink: 0 },
  scanFocalTitle: { fontSize: 18, fontWeight: 800, fontFamily: 'var(--font-display)' },
  scanFocalSub: { fontSize: 13, color: 'var(--text-secondary,#aaa)', marginTop: 2 },
  noBarcode: { textAlign: 'center', color: 'var(--text-tertiary,#999)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 10px' },
  actionTile: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '26px 16px', borderRadius: 14, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text,#fff)', fontWeight: 800, fontSize: 16, cursor: 'pointer', boxShadow: 'var(--shadow-card)' },
  tileAI: { borderColor: 'rgba(139,92,246,0.55)', background: 'rgba(139,92,246,0.14)', color: '#c4b5fd' },
  tileTitle: { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent)' },
  tileIsbn: { borderColor: 'rgba(56,189,248,0.45)', background: 'rgba(56,189,248,0.12)', color: '#7dd3fc' },
  actionBtn: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderRadius: 10, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#222)', color: 'var(--text,#fff)', fontWeight: 800, fontSize: 15, cursor: 'pointer' },
  hint: { color: 'var(--text-secondary,#888)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 },
  recent: { marginTop: 12, background: 'linear-gradient(180deg, var(--bg-elev,#1b2030), var(--bg-card,#161a24))', border: '1px solid var(--border,#252b3a)', borderRadius: 12, overflow: 'hidden' },
  recentTitle: { padding: '10px 14px', borderBottom: '1px solid var(--border,#252b3a)', color: 'var(--text-tertiary,#999)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 },
  recentRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border,#1e1e1e)' },
  mono: { fontFamily: 'monospace', fontSize: 13, color: 'var(--text,#fff)' },
  recentTitleText: { flex: 1, fontSize: 13, color: 'var(--text-secondary,#bbb)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  recentPo: { fontSize: 12, fontWeight: 800, color: 'var(--accent,#4d7cff)' },
  recentBox: { fontFamily: 'monospace', fontSize: 12, color: 'var(--text-tertiary,#888)' },
  candidate: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border,#444)', background: 'var(--bg-input,#1a1a1a)', color: 'var(--text,#fff)', cursor: 'pointer' },
  candIdx: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 800, flexShrink: 0 },
  candTitle: { flex: 1, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  candMeta: { fontSize: 12, color: 'var(--text-tertiary,#888)' },
};
