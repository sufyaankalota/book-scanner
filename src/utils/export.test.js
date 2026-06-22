import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { exportAllXLSX, exportPerPO, exportReconciliation } from './export';

describe('export utilities', () => {
  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    globalThis.requestAnimationFrame = (fn) => {
      fn();
      return 1;
    };
    globalThis.URL = {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    };
    globalThis.document = {
      body: {
        appendChild: vi.fn((node) => { node.parentNode = globalThis.document.body; }),
        removeChild: vi.fn((node) => { node.parentNode = null; }),
      },
      createElement: vi.fn(() => ({ click: vi.fn(), style: {}, parentNode: null })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.document = originalDocument;
    globalThis.URL = originalUrl;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it('does not throw when exports encounter invalid timestamps', () => {
    expect(() => exportAllXLSX([
      { type: 'standard', isbn: '9780134685991', poName: 'PO-1', podId: 'A', scannerId: 'Op', timestamp: 'not-a-date' },
    ], [], { name: 'Invalid Date Job' })).not.toThrow();
  });

  it('deduplicates long PO names after Excel sheet-name truncation', () => {
    const sheetNames = [];
    const originalAppendSheet = XLSX.utils.book_append_sheet;
    const appendSpy = vi.spyOn(XLSX.utils, 'book_append_sheet');
    appendSpy.mockImplementation((wb, ws, name) => {
      sheetNames.push(name);
      return originalAppendSheet(wb, ws, name);
    });

    exportPerPO([
      { type: 'standard', isbn: '9780134685991', poName: 'ACME-Corp-East-Coast-Warehouse-A', podId: 'A', scannerId: 'Op', timestamp: Date.now() },
      { type: 'standard', isbn: '9780134685992', poName: 'ACME-Corp-East-Coast-Warehouse-B', podId: 'B', scannerId: 'Op', timestamp: Date.now() },
    ], [], { name: 'Long PO Job' });

    const poSheets = sheetNames.filter((name) => name.startsWith('ACME-Corp-East-Coast'));
    expect(poSheets).toHaveLength(2);
    expect(new Set(poSheets).size).toBe(2);
    expect(poSheets.every((name) => name.length <= 31)).toBe(true);
  });

  it('reports 0% reconciliation completion when the manifest is empty', () => {
    const sheetInputs = [];
    const originalJsonToSheet = XLSX.utils.json_to_sheet;
    vi.spyOn(XLSX.utils, 'json_to_sheet').mockImplementation((rows, ...rest) => {
      sheetInputs.push(rows);
      return originalJsonToSheet(rows, ...rest);
    });

    exportReconciliation([], {}, { name: 'Empty Manifest' });

    const summaryRows = sheetInputs.find((rows) => rows.some?.((row) => row.Metric === 'Completion %'));
    expect(summaryRows).toContainEqual({ Metric: 'Completion %', Value: '0%' });
  });
});