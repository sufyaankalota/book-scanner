import { describe, it, expect } from 'vitest';
import { isValidISBN, cleanISBN, detectBarcodeType } from './isbn';

describe('isValidISBN', () => {
  // Valid ISBN-13
  it('accepts valid ISBN-13 (978)', () => {
    expect(isValidISBN('9780134685991')).toBe(true);
  });

  it('accepts valid ISBN-13 (979)', () => {
    expect(isValidISBN('9791032305690')).toBe(true);
  });

  it('accepts ISBN-13 with dashes', () => {
    expect(isValidISBN('978-0-13-468599-1')).toBe(true);
  });

  // Valid ISBN-10
  it('accepts valid ISBN-10', () => {
    expect(isValidISBN('0306406152')).toBe(true);
  });

  it('accepts ISBN-10 with X check digit', () => {
    expect(isValidISBN('155404295X')).toBe(true);
  });

  it('accepts ISBN-10 with dashes', () => {
    expect(isValidISBN('0-306-40615-2')).toBe(true);
  });

  // Bookland EAN + 5-digit addon (18 digits)
  it('accepts 18-digit Bookland EAN with addon', () => {
    expect(isValidISBN('978013468599152495')).toBe(true);
  });

  // ISBN-13 + 2-digit addon (15 digits)
  it('accepts 15-digit ISBN-13 with addon', () => {
    expect(isValidISBN('978013468599109')).toBe(true);
  });

  // Invalid codes
  it('rejects random digits', () => {
    expect(isValidISBN('1234567890')).toBe(false);
  });

  it('rejects too short', () => {
    expect(isValidISBN('12345')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidISBN('')).toBe(false);
  });

  it('rejects letters', () => {
    expect(isValidISBN('abcdefghij')).toBe(false);
  });

  it('rejects wrong check digit ISBN-13', () => {
    expect(isValidISBN('9780134685990')).toBe(false);
  });

  it('rejects non-978/979 13-digit', () => {
    expect(isValidISBN('1234567890123')).toBe(false);
  });

  it('rejects UPC-A (12 digits)', () => {
    expect(isValidISBN('012345678905')).toBe(false);
  });
});

describe('cleanISBN', () => {
  it('removes dashes and spaces', () => {
    expect(cleanISBN('978-0-13-468599-1')).toBe('9780134685991');
  });

  it('trims whitespace', () => {
    expect(cleanISBN('  9780134685991  ')).toBe('9780134685991');
  });

  it('handles already clean ISBN', () => {
    expect(cleanISBN('9780134685991')).toBe('9780134685991');
  });
});

describe('detectBarcodeType', () => {
  it('detects ISBN-13', () => {
    expect(detectBarcodeType('9780134685991')).toBe('ISBN-13');
  });

  it('detects ISBN-10', () => {
    expect(detectBarcodeType('0306406152')).toBe('ISBN-10');
  });

  it('detects non-ISBN EAN-13', () => {
    expect(detectBarcodeType('1234567890123')).toBe('Not ISBN (EAN-13)');
  });

  it('detects UPC', () => {
    expect(detectBarcodeType('012345678905')).toBe('Not ISBN (UPC)');
  });

  it('detects unknown', () => {
    expect(detectBarcodeType('12345')).toBe('Not ISBN');
  });
});
