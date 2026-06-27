/**
 * Label generation + printing for the packing workflow.
 *
 *   - Book ISBN labels : 1D EAN-13, 2.25 x 1.25 in
 *   - Box + pallet      : 2D QR, 4 x 6 in, co-branded "ZoomBooks X PrepFort"
 *
 * Barcodes are rendered with bwip-js (browser build) to PNG data URLs, then
 * printed via a print-styled popup window whose @page size matches the
 * thermal label so it feeds a JADENS (or any OS-driver) label printer 1:1.
 *
 * bwip-js is only imported here; this module is only imported by the lazy
 * /pack and /pallet routes, so it never lands in the index chunk.
 */
import bwipjs from 'bwip-js/browser';

export const CO_BRAND = 'ZoomBooks X PrepFort';

export const LABEL_SIZES = {
  book: { w: 2.25, h: 1.25 },
  box: { w: 4, h: 6 },
  pallet: { w: 4, h: 6 },
};

function renderDataUrl(opts) {
  const canvas = document.createElement('canvas');
  bwipjs.toCanvas(canvas, opts);
  return canvas.toDataURL('image/png');
}

/** EAN-13 barcode (PNG data URL) for a book's ISBN-13. Bars only — the human
 *  digits are rendered in HTML so the label layout is fully controlled. */
export function ean13DataUrl(isbn13) {
  const digits = String(isbn13 || '').replace(/[^0-9]/g, '');
  try {
    return renderDataUrl({ bcid: 'ean13', text: digits, scale: 4, height: 12, includetext: false });
  } catch {
    // A bad check digit must never block printing — fall back to Code-128.
    return renderDataUrl({ bcid: 'code128', text: digits, scale: 4, height: 12, includetext: false });
  }
}

/** Format an ISBN-13 as "9 780547 928227" for the human-readable line. */
function groupIsbn13(s) {
  const d = String(s || '').replace(/[^0-9]/g, '');
  return d.length === 13 ? `${d[0]} ${d.slice(1, 7)} ${d.slice(7)}` : d;
}

/** QR code (PNG data URL) for an opaque box/pallet license-plate id. */
export function qrDataUrl(text) {
  return renderDataUrl({ bcid: 'qrcode', text: String(text || ''), scale: 10, eclevel: 'M' });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

/**
 * Print one or more label "pages". Each page is an HTML string sized to one
 * label. `copies` repeats the whole set (pallet labels print x4).
 * Throws if the popup is blocked so the caller can surface a clear message.
 */
const LABEL_CSS = (w, h) => `
    @page { size: ${w}in ${h}in; margin: 0; }
    html, body { margin: 0; padding: 0; }
    * { box-sizing: border-box; }
    .label { width: ${w}in; height: ${h}in; padding: 0.08in; page-break-after: always; overflow: hidden;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .label:last-child { page-break-after: auto; }
    .qr, .ean { image-rendering: -webkit-optimize-contrast; image-rendering: pixelated; }
    .brand { font-weight: 800; font-size: 12pt; letter-spacing: 0.4px; }
    .qr { width: 2.4in; height: 2.4in; }
    .bk { display: grid; grid-auto-rows: min-content; row-gap: 0.03in; width: 100%; height: 100%; align-content: center; justify-items: center; }
    .ean { width: 2.0in; height: 0.5in; object-fit: contain; }
    .bk-title { font-size: 8pt; font-weight: 700; line-height: 1.05; max-width: 2.1in; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bk-digits { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.5px; font-family: 'Courier New', monospace; }
    .bk-po { font-size: 7.5pt; line-height: 1.05; }
    .big { font-size: 20pt; font-weight: 800; }
    .mid { font-size: 13pt; font-weight: 700; }
    .small { font-size: 9pt; }
    .row { margin: 2px 0; }
  `;

/** Build the full printable HTML document for a set of pre-sized label pages.
 *  Returned shape is serialisable, so it can be queued to the print station. */
export function buildLabelDoc(pageHtmls, { w, h, copies = 1, title = 'Labels' } = {}) {
  const pages = [];
  for (let c = 0; c < copies; c++) pages.push(...pageHtmls);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${LABEL_CSS(w, h)}</style></head>`
    + `<body>${pages.map((p) => `<div class="label">${p}</div>`).join('')}</body></html>`;
  return { html, w, h, copies, title };
}

/** Local fallback: open a popup window and print a built doc. */
export function printLabelDoc({ html }) {
  const win = window.open('', '_blank', 'width=520,height=720');
  if (!win) throw new Error('Could not open the print window — allow pop-ups for this site, then retry.');
  win.document.write(html);
  win.document.close();
  win.focus();
  const fire = () => { try { win.print(); } catch { /* user can print manually */ } };
  win.onload = fire;
  setTimeout(fire, 400);
}

/** Back-compat: build + print in one step (used by older callers). */
export function printLabels(pageHtmls, opts = {}) {
  printLabelDoc(buildLabelDoc(pageHtmls, opts));
}

// ─── Per-label page markup (inner content of one .label) ───
function bookPage({ isbn13, title, po }) {
  const img = ean13DataUrl(isbn13);
  return `
    <div class="bk">
      <div class="bk-title">${esc(truncate(title, 30))}</div>
      <img class="ean" src="${img}" alt="" />
      <div class="bk-digits">${esc(groupIsbn13(isbn13))}</div>
      <div class="bk-po">PO: ${esc(po || '')}</div>
    </div>
  `;
}
function boxPage({ boxId, po, itemCount, jobName }) {
  const img = qrDataUrl(boxId);
  return `
    <div class="brand">${esc(CO_BRAND)}</div>
    <div class="row small">${esc(jobName || '')}</div>
    <img class="qr" src="${img}" alt="" />
    <div class="row big">BOX</div>
    <div class="row mid">${esc(boxId)}</div>
    <div class="row mid">PO: ${esc(po || '')}</div>
    <div class="row small">${Number(itemCount || 0)} items</div>
  `;
}
function palletPage({ palletId, number, po, boxCount, jobName, finalizedBy }) {
  const img = qrDataUrl(palletId);
  return `
    <div class="brand">${esc(CO_BRAND)}</div>
    <div class="row small">${esc(jobName || '')}</div>
    <img class="qr" src="${img}" alt="" />
    <div class="row big">PALLET${number != null ? ' ' + esc(number) : ''}</div>
    <div class="row small">${esc(palletId)}</div>
    <div class="row mid">PO: ${esc(po || '')}</div>
    <div class="row small">${Number(boxCount || 0)} boxes</div>
    ${finalizedBy ? `<div class="row mid">Finalized by ${esc(finalizedBy)}</div>` : ''}
  `;
}

// ─── Doc builders (serialisable; for the print queue) ───
export function bookLabelDoc(x) { return { ...buildLabelDoc([bookPage(x)], { ...LABEL_SIZES.book, title: 'ISBN label' }), kind: 'book' }; }
export function boxLabelDoc(x) { return { ...buildLabelDoc([boxPage(x)], { ...LABEL_SIZES.box, title: 'Box label' }), kind: 'box' }; }
export function palletLabelDoc(x, copies = 4) { return { ...buildLabelDoc([palletPage(x)], { ...LABEL_SIZES.pallet, copies, title: 'Pallet label' }), kind: 'pallet' }; }

// ─── Local print helpers (open a popup; used when no station printer is set) ───
export function printBookLabel(x) { printLabelDoc(bookLabelDoc(x)); }
export function printBoxLabel(x) { printLabelDoc(boxLabelDoc(x)); }
export function printPalletLabel(x, copies = 4) { printLabelDoc(palletLabelDoc(x, copies)); }
