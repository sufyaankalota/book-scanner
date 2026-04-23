/**
 * ISBN / barcode validation utilities.
 * Accepts all barcode formats commonly found on books:
 *   ISBN-13, ISBN-10, EAN-13, EAN-8, UPC-A, and add-on supplements.
 */

export function isValidISBN(code) {
  const cleaned = code.replace(/[-\s]/g, '');

  // ISBN-13 / EAN-13 (13 digits)
  if (cleaned.length === 13 && /^\d{13}$/.test(cleaned)) return isValidEAN13(cleaned);

  // ISBN-10 (9 digits + check digit which can be X)
  if (cleaned.length === 10 && /^\d{9}[\dXx]$/.test(cleaned)) return isValidISBN10(cleaned);

  // UPC-A (12 digits)
  if (cleaned.length === 12 && /^\d{12}$/.test(cleaned)) return isValidUPCA(cleaned);

  // EAN-8 (8 digits) — less common on books but valid
  if (cleaned.length === 8 && /^\d{8}$/.test(cleaned)) return isValidEAN8(cleaned);

  // Bookland EAN + 5-digit add-on (18 digits) — strip supplement, validate base ISBN-13
  if (cleaned.length === 18 && /^\d{18}$/.test(cleaned)) return isValidEAN13(cleaned.slice(0, 13));

  // UPC-A + 5-digit add-on (17 digits) — strip supplement, validate base UPC-A
  if (cleaned.length === 17 && /^\d{17}$/.test(cleaned)) return isValidUPCA(cleaned.slice(0, 12));

  // UPC-A + 2-digit add-on (14 digits) — strip supplement, validate base UPC-A
  if (cleaned.length === 14 && /^\d{14}$/.test(cleaned)) return isValidUPCA(cleaned.slice(0, 12));

  // EAN-13 + 2-digit add-on (15 digits) — strip supplement, validate base EAN-13
  if (cleaned.length === 15 && /^\d{15}$/.test(cleaned)) return isValidEAN13(cleaned.slice(0, 13));

  // Fallback: accept any numeric string 8-18 digits (warehouse permissive mode)
  if (/^\d{8,18}$/.test(cleaned)) return true;

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

/** Detect barcode type: ISBN-13, ISBN-10, UPC-A, EAN-13, or Unknown */
export function detectBarcodeType(code) {
  const cleaned = code.replace(/[-\s]/g, '').trim();
  if (cleaned.length === 13 && /^\d{13}$/.test(cleaned)) {
    if (cleaned.startsWith('978') || cleaned.startsWith('979')) return 'ISBN-13';
    return 'EAN-13';
  }
  if (cleaned.length === 10 && /^\d{9}[\dXx]$/.test(cleaned)) return 'ISBN-10';
  if (cleaned.length === 12 && /^\d{12}$/.test(cleaned)) return 'UPC-A';
  return 'Unknown';
}
