/**
 * ISBN validation utilities.
 * Only accepts ISBN-10 and ISBN-13 formats.
 * Employees must find the copyright page and type the ISBN.
 */

export function isValidISBN(code) {
  const cleaned = code.replace(/[-\s]/g, '');

  // ISBN-13 (13 digits, starts with 978 or 979)
  if (cleaned.length === 13 && /^\d{13}$/.test(cleaned) && (cleaned.startsWith('978') || cleaned.startsWith('979'))) return isValidEAN13(cleaned);

  // ISBN-10 (9 digits + check digit which can be X)
  if (cleaned.length === 10 && /^\d{9}[\dXx]$/.test(cleaned)) return isValidISBN10(cleaned);

  // Bookland EAN + 5-digit add-on (18 digits) — strip supplement, validate base ISBN-13
  if (cleaned.length === 18 && /^\d{18}$/.test(cleaned) && (cleaned.startsWith('978') || cleaned.startsWith('979'))) return isValidEAN13(cleaned.slice(0, 13));

  // ISBN-13 + 2-digit add-on (15 digits) — strip supplement, validate base ISBN-13
  if (cleaned.length === 15 && /^\d{15}$/.test(cleaned) && (cleaned.startsWith('978') || cleaned.startsWith('979'))) return isValidEAN13(cleaned.slice(0, 13));

  return false;
}

function isValidISBN10(isbn) {
  if (!/^\d{9}[\dXx]$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(isbn[i], 10) * (10 - i);
  }
  const last = isbn[9].toUpperCase();
  sum += last === 'X' ? 10 : parseInt(last, 10);
  return sum % 11 === 0;
}

/** EAN-13 / ISBN-13 check digit: weights alternate 1, 3, 1, 3... */
function isValidEAN13(isbn) {
  if (!/^\d{13}$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += parseInt(isbn[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** UPC-A check digit: weights alternate 3, 1, 3, 1... (opposite of EAN-13) */
function isValidUPCA(upc) {
  if (!/^\d{12}$/.test(upc)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(upc[i], 10) * (i % 2 === 0 ? 3 : 1);
  }
  return sum % 10 === 0;
}

/** EAN-8 check digit: weights alternate 3, 1, 3, 1... (same as UPC-A) */
function isValidEAN8(ean) {
  if (!/^\d{8}$/.test(ean)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += parseInt(ean[i], 10) * (i % 2 === 0 ? 3 : 1);
  }
  return sum % 10 === 0;
}

export function cleanISBN(code) {
  return code.replace(/[-\s]/g, '').trim();
}

/** Detect barcode type: ISBN-13, ISBN-10, or Not ISBN */
export function detectBarcodeType(code) {
  const cleaned = code.replace(/[-\s]/g, '').trim();
  if (cleaned.length === 13 && /^\d{13}$/.test(cleaned)) {
    if (cleaned.startsWith('978') || cleaned.startsWith('979')) return 'ISBN-13';
    return 'Not ISBN (EAN-13)';
  }
  if (cleaned.length === 10 && /^\d{9}[\dXx]$/.test(cleaned)) return 'ISBN-10';
  if (cleaned.length === 12 && /^\d{12}$/.test(cleaned)) return 'Not ISBN (UPC)';
  return 'Not ISBN';
}
