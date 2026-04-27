/**
 * EOD Export — generates .xlsx files for download.
 */
import * as XLSX from 'xlsx';

function toDateString(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString();
}

export function exportTodayXLSX(scans, exceptions, jobMeta) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayScans = scans.filter((s) => {
    const d = s.timestamp?.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
    return d >= today;
  });
  const todayExceptions = exceptions.filter((ex) => {
    const d = ex.timestamp?.toDate ? ex.timestamp.toDate() : new Date(ex.timestamp);
    return d >= today;
  });

  return buildWorkbook(todayScans, todayExceptions, jobMeta, 'Today');
}

export function exportAllXLSX(scans, exceptions, jobMeta) {
  return buildWorkbook(scans, exceptions, jobMeta, 'All');
}

export function exportPerPO(scans, exceptions, jobMeta) {
  const wb = XLSX.utils.book_new();
  const byPO = {};
  for (const s of scans) {
    const po = s.poName || 'UNASSIGNED';
    if (!byPO[po]) byPO[po] = [];
    byPO[po].push(s);
  }

  // One tab per PO
  for (const [po, poScans] of Object.entries(byPO).sort(([a], [b]) => a.localeCompare(b))) {
    const data = poScans.map((s) => ({
      ISBN: s.isbn,
      Type: s.type === 'exception' ? 'Exception' : 'Standard',
      Pod: s.podId,
      Scanner: s.scannerId,
      Timestamp: toDateString(s.timestamp),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    // Sheet names max 31 chars
    const sheetName = po.length > 31 ? po.slice(0, 31) : po;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  // Exceptions tab — consolidated from all POs
  const exceptionScans = scans.filter((s) => s.type === 'exception');
  const allExcs = [
    ...exceptionScans.map((s) => ({
      ISBN: s.isbn, Title: '', Reason: 'Not in Manifest', PO: s.poName || '',
      Pod: s.podId, Scanner: s.scannerId, 'Has Photo': 'No',
      Timestamp: toDateString(s.timestamp),
    })),
    ...exceptions.map((ex) => ({
      ISBN: ex.isbn || '', Title: ex.title || '', Reason: ex.reason, PO: '',
      Pod: ex.podId, Scanner: ex.scannerId, 'Has Photo': ex.photo ? 'Yes' : 'No',
      Timestamp: toDateString(ex.timestamp),
    })),
  ];
  if (allExcs.length > 0) {
    const wsExc = XLSX.utils.json_to_sheet(allExcs);
    XLSX.utils.book_append_sheet(wb, wsExc, 'Exceptions');
  }

  // Summary tab
  const summaryRows = [
    { Metric: 'Total POs', Value: Object.keys(byPO).length },
    ...Object.entries(byPO).sort(([a], [b]) => a.localeCompare(b)).map(([po, s]) => ({
      Metric: `${po} — Scans`, Value: s.filter((x) => x.type === 'standard').length,
    })),
    { Metric: 'Total Standard Scans', Value: scans.filter((s) => s.type === 'standard').length },
    { Metric: 'Total Exceptions', Value: allExcs.length },
    { Metric: '', Value: '' },
    { Metric: 'DISCLAIMER', Value: 'Book titles in this report may have been extracted from cover images using AI (OCR). Titles should be verified for accuracy.' },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const fileName = `${jobMeta.name || 'export'}_AllPOs_${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(buf, fileName);
}

function buildWorkbook(scans, exceptions, jobMeta, label) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Standard Scans
  const standardScans = scans.filter((s) => s.type === 'standard');
  const scanData = standardScans.map((s) => ({
    ISBN: s.isbn,
    PO: s.poName || '',
    Pod: s.podId,
    Scanner: s.scannerId,
    Timestamp: toDateString(s.timestamp),
  }));
  const ws1 = XLSX.utils.json_to_sheet(scanData);
  XLSX.utils.book_append_sheet(wb, ws1, 'Scans');

  // Sheet 2: Exceptions (both auto and manual)
  const exceptionScans = scans.filter((s) => s.type === 'exception');
  const allExceptions = [
    ...exceptionScans.map((s) => ({
      ISBN: s.isbn,
      Title: '',
      Reason: 'Not in Manifest',
      PO: s.poName || '',
      Pod: s.podId,
      Scanner: s.scannerId,
      'Has Photo': 'No',
      Timestamp: toDateString(s.timestamp),
    })),
    ...exceptions.map((ex) => ({
      ISBN: ex.isbn || '',
      Title: ex.title || '',
      Reason: ex.reason,
      PO: '',
      Pod: ex.podId,
      Scanner: ex.scannerId,
      'Has Photo': ex.photo ? 'Yes' : 'No',
      Timestamp: toDateString(ex.timestamp),
    })),
  ];
  const ws2 = XLSX.utils.json_to_sheet(allExceptions);
  XLSX.utils.book_append_sheet(wb, ws2, 'Exceptions');

  // Sheet 3: Summary
  const podIds = [...new Set(scans.map((s) => s.podId))];
  const summaryData = [
    { Metric: 'Total Standard Scans', Value: standardScans.length },
    { Metric: 'Total Exceptions (auto)', Value: exceptionScans.length },
    { Metric: 'Total Exceptions (manual)', Value: exceptions.length },
    ...podIds.map((pod) => ({
      Metric: `Pod ${pod} Scans`,
      Value: scans.filter((s) => s.podId === pod).length,
    })),
    { Metric: '', Value: '' },
    { Metric: 'DISCLAIMER', Value: 'Book titles in this report may have been extracted from cover images using AI (OCR). Titles should be verified for accuracy.' },
  ];
  const ws3 = XLSX.utils.json_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const fileName = `${jobMeta.name || 'export'}_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(buf, fileName);
}

export function downloadBlob(data, fileName) {
  const blob = new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Manifest reconciliation report: compares scanned ISBNs against manifest.
 */
export function exportReconciliation(scans, manifestData, jobMeta) {
  const wb = XLSX.utils.book_new();
  const scannedIsbns = new Set(scans.filter((s) => s.type === 'standard').map((s) => s.isbn));

  // Missing ISBNs (in manifest but not scanned)
  const missing = [];
  const found = [];
  for (const [isbn, po] of Object.entries(manifestData)) {
    if (scannedIsbns.has(isbn)) {
      found.push({ ISBN: isbn, PO: po, Status: 'Scanned' });
    } else {
      missing.push({ ISBN: isbn, PO: po, Status: 'Missing' });
    }
  }

  // Extra ISBNs (scanned but not in manifest)
  const manifestSet = new Set(Object.keys(manifestData));
  const extra = scans
    .filter((s) => s.type === 'standard' && !manifestSet.has(s.isbn))
    .map((s) => ({ ISBN: s.isbn, PO: s.poName || '', Status: 'Extra (not in manifest)' }));

  const ws1 = XLSX.utils.json_to_sheet(missing);
  XLSX.utils.book_append_sheet(wb, ws1, 'Missing');

  const ws2 = XLSX.utils.json_to_sheet(extra);
  XLSX.utils.book_append_sheet(wb, ws2, 'Extra');

  const ws3 = XLSX.utils.json_to_sheet([
    { Metric: 'Total in Manifest', Value: Object.keys(manifestData).length },
    { Metric: 'Scanned (matched)', Value: found.length },
    { Metric: 'Missing', Value: missing.length },
    { Metric: 'Extra (not in manifest)', Value: extra.length },
    { Metric: 'Completion %', Value: `${Math.round((found.length / Object.keys(manifestData).length) * 100)}%` },
  ]);
  XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(buf, `${jobMeta.name || 'reconciliation'}_reconciliation_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/** Export exceptions only — for sending to customer */
export function exportExceptionsXLSX(scans, exceptions, jobMeta) {
  const wb = XLSX.utils.book_new();
  const exceptionScans = scans.filter((s) => s.type === 'exception');
  const allExceptions = [
    ...exceptionScans.map((s) => ({
      ISBN: s.isbn, Reason: 'Not in Manifest', Pod: s.podId,
      Scanner: s.scannerId, 'Has Photo': 'No', Timestamp: toDateString(s.timestamp),
    })),
    ...exceptions.map((ex) => ({
      ISBN: ex.isbn || '', Title: ex.title || '', Reason: ex.reason,
      Pod: ex.podId, Scanner: ex.scannerId, Resolved: ex.resolved ? 'Yes' : 'No',
      'Has Photo': ex.photo ? 'Yes' : 'No', Timestamp: toDateString(ex.timestamp),
    })),
  ];
  const ws = XLSX.utils.json_to_sheet(allExceptions);
  XLSX.utils.book_append_sheet(wb, ws, 'Exceptions');
  const ws2 = XLSX.utils.json_to_sheet([
    { Metric: 'Job Name', Value: jobMeta.name || '' },
    { Metric: 'Total Exceptions', Value: allExceptions.length },
    { Metric: 'Not in Manifest', Value: exceptionScans.length },
    { Metric: 'Manual Exceptions', Value: exceptions.length },
    { Metric: 'Export Date', Value: new Date().toLocaleString() },
    { Metric: '', Value: '' },
    { Metric: 'DISCLAIMER', Value: 'Book titles in this report may have been extracted from cover images using AI (OCR). Titles should be verified for accuracy.' },
  ]);
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(buf, `${jobMeta.name || 'exceptions'}_exceptions_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/** Export shift summary for email/print */
export function exportShiftSummary(shiftStats) {
  const wb = XLSX.utils.book_new();
  const data = [
    { Field: 'Operator', Value: shiftStats.operator },
    { Field: 'Pod', Value: shiftStats.pod },
    { Field: 'Job', Value: shiftStats.job },
    { Field: 'Total Scans', Value: shiftStats.total },
    { Field: 'Exceptions', Value: shiftStats.exceptions },
    { Field: 'Avg Pace/hr', Value: shiftStats.pace },
    { Field: 'Hours Worked', Value: shiftStats.hours },
    { Field: 'Break Time', Value: shiftStats.breakMinutes ? `${shiftStats.breakMinutes} min` : '0 min' },
    { Field: 'Date', Value: new Date().toLocaleDateString() },
    { Field: 'End Time', Value: new Date().toLocaleTimeString() },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Shift Summary');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(buf, `shift_${shiftStats.operator}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * Weekly Billing Export — produces an invoice-ready XLSX.
 * @param {Array} scans — all scans in the billing period
 * @param {Array} exceptions — manual exceptions in the billing period
 * @param {Object} jobMeta — job metadata
 * @param {Date} weekStart — billing period start
 * @param {Date} weekEnd — billing period end
 */
export function exportBillingXLSX(scans, exceptions, jobMeta, weekStart, weekEnd) {
  const wb = XLSX.utils.book_new();
  const startStr = weekStart.toLocaleDateString();
  const endStr = weekEnd.toLocaleDateString();

  const RATE_REGULAR = 0.40;
  const RATE_EXCEPTION = 0.60;

  const standardScans = scans.filter((s) => s.type === 'standard');
  const exceptionScans = scans.filter((s) => s.type === 'exception');
  const totalExceptions = exceptionScans.length + exceptions.length;
  const regularAmount = standardScans.length * RATE_REGULAR;
  const exceptionAmount = totalExceptions * RATE_EXCEPTION;
  const totalAmount = regularAmount + exceptionAmount;

  // Sheet 1: Billing Summary (the one you'd use for invoicing)
  const summaryRows = [
    { Item: 'Customer / Job', Detail: jobMeta.name || '', Qty: '', Rate: '', Amount: '' },
    { Item: 'Billing Period', Detail: `${startStr} – ${endStr}`, Qty: '', Rate: '', Amount: '' },
    { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
    { Item: 'Regular Scans', Detail: '', Qty: standardScans.length, Rate: `$${RATE_REGULAR.toFixed(2)}`, Amount: `$${regularAmount.toFixed(2)}` },
    { Item: 'Exceptions', Detail: '', Qty: totalExceptions, Rate: `$${RATE_EXCEPTION.toFixed(2)}`, Amount: `$${exceptionAmount.toFixed(2)}` },
    { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
    { Item: 'TOTAL UNITS', Detail: '', Qty: standardScans.length + totalExceptions, Rate: '', Amount: `$${totalAmount.toFixed(2)}` },
    { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
    { Item: 'DISCLAIMER', Detail: 'Book titles in this report may have been extracted from cover images using AI (OCR). Titles should be verified for accuracy.', Qty: '', Rate: '', Amount: '' },
  ];
  const ws1 = XLSX.utils.json_to_sheet(summaryRows);
  // Widen columns
  ws1['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Billing Summary');

  // Sheet 2: Daily breakdown
  const dailyMap = {};
  for (const s of scans) {
    const d = s.timestamp?.toDate ? s.timestamp.toDate() : new Date(s.timestamp);
    const key = d.toLocaleDateString();
    if (!dailyMap[key]) dailyMap[key] = { date: key, standard: 0, exceptions: 0 };
    if (s.type === 'standard') dailyMap[key].standard++;
    else dailyMap[key].exceptions++;
  }
  for (const ex of exceptions) {
    const d = ex.timestamp?.toDate ? ex.timestamp.toDate() : new Date(ex.timestamp);
    const key = d.toLocaleDateString();
    if (!dailyMap[key]) dailyMap[key] = { date: key, standard: 0, exceptions: 0 };
    dailyMap[key].exceptions++;
  }
  const dailyRows = Object.values(dailyMap)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => ({
      Date: d.date,
      'Regular Scans': d.standard,
      Exceptions: d.exceptions,
      'Day Total': d.standard + d.exceptions,
      Amount: `$${(d.standard * RATE_REGULAR + d.exceptions * RATE_EXCEPTION).toFixed(2)}`,
    }));
  // Add totals row
  const totalRegular = dailyRows.reduce((s, r) => s + r['Regular Scans'], 0);
  const totalExc = dailyRows.reduce((s, r) => s + r.Exceptions, 0);
  dailyRows.push({
    Date: 'TOTAL',
    'Regular Scans': totalRegular,
    Exceptions: totalExc,
    'Day Total': totalRegular + totalExc,
    Amount: `$${(totalRegular * RATE_REGULAR + totalExc * RATE_EXCEPTION).toFixed(2)}`,
  });
  const ws2 = XLSX.utils.json_to_sheet(dailyRows);
  ws2['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Daily Breakdown');

  // Sheet 3: By Pod
  const podMap = {};
  for (const s of scans) {
    const pod = s.podId || 'Unknown';
    if (!podMap[pod]) podMap[pod] = { standard: 0, exceptions: 0 };
    if (s.type === 'standard') podMap[pod].standard++;
    else podMap[pod].exceptions++;
  }
  const podRows = Object.entries(podMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pod, d]) => ({ Pod: pod, 'Regular Scans': d.standard, Exceptions: d.exceptions, Total: d.standard + d.exceptions }));
  const ws3 = XLSX.utils.json_to_sheet(podRows);
  XLSX.utils.book_append_sheet(wb, ws3, 'By Pod');

  // Sheet 4: By Operator
  const opMap = {};
  for (const s of scans) {
    const op = s.scannerId || 'Unknown';
    if (!opMap[op]) opMap[op] = { standard: 0, exceptions: 0 };
    if (s.type === 'standard') opMap[op].standard++;
    else opMap[op].exceptions++;
  }
  const opRows = Object.entries(opMap)
    .sort((a, b) => (b[1].standard + b[1].exceptions) - (a[1].standard + a[1].exceptions))
    .map(([op, d]) => ({ Operator: op, 'Regular Scans': d.standard, Exceptions: d.exceptions, Total: d.standard + d.exceptions }));
  const ws4 = XLSX.utils.json_to_sheet(opRows);
  XLSX.utils.book_append_sheet(wb, ws4, 'By Operator');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const tag = weekStart.toISOString().slice(0, 10);
  const fileName = `${jobMeta.name || 'billing'}_billing_${tag}.xlsx`;
  downloadBlob(buf, fileName);
  return { buf, fileName };
}
