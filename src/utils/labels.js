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

/** EAN-13 barcode (PNG data URL) for a book's ISBN-13. */
export function ean13DataUrl(isbn13) {
  const digits = String(isbn13 || '').replace(/[^0-9]/g, '');
  try {
    // scale 6 → ~680px wide; well above 203 dpi at the 2.05in print width so
    // the printer never has to upscale (the cause of fuzzy, mis-reading bars).
    return renderDataUrl({ bcid: 'ean13', text: digits, scale: 6, height: 18, includetext: true, textxalign: 'center' });
  } catch {
    // A bad check digit must never block printing — fall back to Code-128.
    return renderDataUrl({ bcid: 'code128', text: digits, scale: 5, height: 18, includetext: true, textxalign: 'center' });
  }
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
export function printLabels(pageHtmls, { w, h, copies = 1, title = 'Labels' } = {}) {
  const win = window.open('', '_blank', 'width=520,height=720');
  if (!win) throw new Error('Could not open the print window — allow pop-ups for this site, then retry.');
  const pages = [];
  for (let c = 0; c < copies; c++) pages.push(...pageHtmls);
  const css = `
    @page { size: ${w}in ${h}in; margin: 0; }
    html, body { margin: 0; padding: 0; }
    * { box-sizing: border-box; }
    .label { width: ${w}in; height: ${h}in; padding: 0.08in; page-break-after: always; overflow: hidden;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; font-family: Arial, Helvetica, sans-serif; color: #000; }
    .label:last-child { page-break-after: auto; }
    /* Keep thermal output sharp: print the high-res barcode 1:1 with no
       smoothing so 203-dpi bars/modules stay crisp and scannable. */
    .qr, .ean { image-rendering: -webkit-optimize-contrast; image-rendering: pixelated; }
    .brand { font-weight: 800; font-size: 12pt; letter-spacing: 0.4px; }
    .qr { width: 2.4in; height: 2.4in; }
    .ean { width: 2.05in; }
    .big { font-size: 20pt; font-weight: 800; }
    .mid { font-size: 13pt; font-weight: 700; }
    .small { font-size: 9pt; }
    .row { margin: 2px 0; }
  `;
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head>` +
    `<body>${pages.map((p) => `<div class="label">${p}</div>`).join('')}</body></html>`
  );
  win.document.close();
  win.focus();
  const fire = () => { try { win.print(); } catch { /* user can print manually */ } };
  win.onload = fire;
  setTimeout(fire, 400);
}

/** Print a single book ISBN label (2.25 x 1.25): EAN-13 + short title + PO. */
export function printBookLabel({ isbn13, title, po }) {
  const img = ean13DataUrl(isbn13);
  const html = `
    <img class="ean" src="${img}" alt="" />
    <div class="row small">${esc(truncate(title, 38))}</div>
    <div class="row small">PO: ${esc(po || '')}</div>
  `;
  printLabels([html], { ...LABEL_SIZES.book, title: 'ISBN label' });
}

/** Print a box label (4 x 6): QR(boxId) + branding + PO + item count. */
export function printBoxLabel({ boxId, po, itemCount, jobName }) {
  const img = qrDataUrl(boxId);
  const html = `
    <div class="brand">${esc(CO_BRAND)}</div>
    <div class="row small">${esc(jobName || '')}</div>
    <img class="qr" src="${img}" alt="" />
    <div class="row big">BOX</div>
    <div class="row mid">${esc(boxId)}</div>
    <div class="row mid">PO: ${esc(po || '')}</div>
    <div class="row small">${Number(itemCount || 0)} items</div>
  `;
  printLabels([html], { ...LABEL_SIZES.box, title: 'Box label' });
}

/** Print a pallet label (4 x 6) x4 copies: QR(palletId) + branding + PO + box count. */
export function printPalletLabel({ palletId, po, boxCount, jobName }, copies = 4) {
  const img = qrDataUrl(palletId);
  const html = `
    <div class="brand">${esc(CO_BRAND)}</div>
    <div class="row small">${esc(jobName || '')}</div>
    <img class="qr" src="${img}" alt="" />
    <div class="row big">PALLET</div>
    <div class="row mid">${esc(palletId)}</div>
    <div class="row mid">PO: ${esc(po || '')}</div>
    <div class="row small">${Number(boxCount || 0)} boxes</div>
  `;
  printLabels([html], { ...LABEL_SIZES.pallet, copies, title: 'Pallet label' });
}
