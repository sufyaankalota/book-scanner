import { describe, it, expect } from 'vitest';

// Test billing calculation logic (extracted from export.js patterns)
// These test the same formulas used in Dashboard.jsx and export.js

describe('Billing Calculations', () => {
  const RATE_REGULAR = 0.40;
  const RATE_EXCEPTION = 0.60;

  function calculateBilling(scans, exceptions) {
    const standardCount = scans.filter((s) => s.type === 'standard' && s.source !== 'manual').length;
    const exceptionCount = scans.filter((s) => s.type === 'exception' || s.source === 'manual').length + exceptions.length;
    const regularAmount = standardCount * RATE_REGULAR;
    const exceptionAmount = exceptionCount * RATE_EXCEPTION;
    return { standardCount, exceptionCount, regularAmount, exceptionAmount, totalAmount: regularAmount + exceptionAmount };
  }

  it('calculates standard scans at $0.40', () => {
    const scans = [
      { type: 'standard', isbn: '111' },
      { type: 'standard', isbn: '222' },
      { type: 'standard', isbn: '333' },
    ];
    const result = calculateBilling(scans, []);
    expect(result.standardCount).toBe(3);
    expect(result.regularAmount).toBeCloseTo(1.20);
  });

  it('calculates exceptions at $0.60', () => {
    const scans = [
      { type: 'exception', isbn: '444' },
    ];
    const exceptions = [
      { reason: 'Damaged' },
    ];
    const result = calculateBilling(scans, exceptions);
    expect(result.exceptionCount).toBe(2);
    expect(result.exceptionAmount).toBeCloseTo(1.20);
  });

  it('bills manual entries as exceptions', () => {
    const scans = [
      { type: 'standard', source: 'manual', isbn: '555' },
      { type: 'standard', isbn: '666' },
    ];
    const result = calculateBilling(scans, []);
    expect(result.standardCount).toBe(1); // Only non-manual
    expect(result.exceptionCount).toBe(1); // Manual billed as exception
    expect(result.regularAmount).toBeCloseTo(0.40);
    expect(result.exceptionAmount).toBeCloseTo(0.60);
    expect(result.totalAmount).toBeCloseTo(1.00);
  });

  it('calculates total for mixed scan types', () => {
    const scans = [
      { type: 'standard', isbn: '111' },
      { type: 'standard', isbn: '222' },
      { type: 'standard', source: 'manual', isbn: '333' },
      { type: 'exception', isbn: '444' },
      { type: 'exception', source: 'manual', isbn: '555' },
    ];
    const exceptions = [
      { reason: 'No ISBN' },
      { reason: 'Damaged' },
    ];
    const result = calculateBilling(scans, exceptions);
    expect(result.standardCount).toBe(2);  // standard, non-manual
    expect(result.exceptionCount).toBe(5); // 1 manual + 2 exception scans + 2 manual exceptions
    expect(result.totalAmount).toBeCloseTo(2 * 0.40 + 5 * 0.60);
  });

  it('handles empty data', () => {
    const result = calculateBilling([], []);
    expect(result.standardCount).toBe(0);
    expect(result.exceptionCount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });
});

describe('Pace Calculation', () => {
  function calculatePace(recentScans, minutesElapsed) {
    if (minutesElapsed <= 0 || recentScans.length === 0) return 0;
    return Math.round((recentScans.length / Math.min(15, minutesElapsed)) * 60);
  }

  it('calculates pace from 15-min window', () => {
    const pace = calculatePace(new Array(30), 15);
    expect(pace).toBe(120); // 30 in 15min = 120/hr
  });

  it('calculates pace from shorter window', () => {
    const pace = calculatePace(new Array(10), 5);
    expect(pace).toBe(120); // 10 in 5min = 120/hr
  });

  it('caps window at 15 minutes', () => {
    const pace = calculatePace(new Array(60), 20);
    expect(pace).toBe(240); // 60 in 15min (capped) = 240/hr
  });

  it('returns 0 for no scans', () => {
    expect(calculatePace([], 15)).toBe(0);
  });

  it('returns 0 for 0 minutes', () => {
    expect(calculatePace(new Array(10), 0)).toBe(0);
  });
});

describe('Remaining & ETA Calculation', () => {
  function calculateRemaining(standardScans, autoExceptions, manualCount, dailyTarget) {
    return Math.max(0, dailyTarget - (standardScans + autoExceptions + manualCount));
  }

  function calculateETA(remaining, totalPace) {
    return totalPace > 0 ? (remaining / totalPace).toFixed(1) : '—';
  }

  it('subtracts all scan types from target', () => {
    expect(calculateRemaining(1000, 50, 30, 2000)).toBe(920);
  });

  it('does not go negative', () => {
    expect(calculateRemaining(2000, 100, 50, 2000)).toBe(0);
  });

  it('calculates hours left', () => {
    expect(calculateETA(500, 250)).toBe('2.0');
  });

  it('returns dash when no pace', () => {
    expect(calculateETA(500, 0)).toBe('—');
  });
});

describe('Exception Reason Classification', () => {
  function classifyException(scan) {
    if (scan.source === 'manual') return 'Manual Entry';
    return 'Not in Manifest';
  }

  it('classifies manual entries', () => {
    expect(classifyException({ source: 'manual', type: 'exception' })).toBe('Manual Entry');
  });

  it('classifies auto-exceptions', () => {
    expect(classifyException({ type: 'exception' })).toBe('Not in Manifest');
  });

  it('classifies manual in-manifest entries', () => {
    expect(classifyException({ source: 'manual', type: 'standard' })).toBe('Manual Entry');
  });
});
