/**
 * ISBN validation utilities.
 * Validates ISBN-10 and ISBN-13 using check digit verification.
 */

export function isValidISBN(code) {
  const cleaned = code.replace(/[-\s]/g, '');
  if (cleaned.length === 13) return isValidISBN13(cleaned);
  if (cleaned.length === 10) return isValidISBN10(cleaned);
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

function isValidISBN13(isbn) {
  if (!/^\d{13}$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += parseInt(isbn[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

export function cleanISBN(code) {
  return code.replace(/[-\s]/g, '').trim();
}
