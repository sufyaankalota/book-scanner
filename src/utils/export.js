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
      Type: s.source === 'manual' ? 'Manual Entry' : s.type === 'exception' ? 'Exception' : 'Standard',
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
      ISBN: s.isbn, Title: '', Reason: s.source === 'manual' ? 'Manual Entry' : 'Not in Manifest', PO: s.poName || '',
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
      Reason: s.source === 'manual' ? 'Manual Entry' : 'Not in Manifest',
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
      ISBN: s.isbn, Reason: s.source === 'manual' ? 'Manual Entry' : 'Not in Manifest', Pod: s.podId,
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

  // Categorize scans 4 ways for breakdown visibility, but billing is still
  // 2-tier: regular @ $0.40 vs everything-else @ $0.60.
  // - Regular: type=standard AND no source (plain barcode scan)
  // - Manual: source='manual' (operator typed the ISBN)
  // - AI Camera: source='ai-match' (cover photo → AI extracted ISBN)
  // - Exception: type='exception' OR doc in `exceptions` collection
  const isManual = (s) => s.source === 'manual';
  const isAi = (s) => s.source === 'ai-match';
  const isException = (s) => s.type === 'exception';
  const standardScans = scans.filter((s) => s.type === 'standard' && !isManual(s) && !isAi(s));
  const manualScans = scans.filter(isManual);
  const aiScans = scans.filter(isAi);
  const exceptionScansFromCollection = exceptions.length;
  const exceptionScansInline = scans.filter(isException).length;
  const totalExceptionBucket = manualScans.length + aiScans.length + exceptionScansInline + exceptionScansFromCollection;
  const regularAmount = standardScans.length * RATE_REGULAR;
  const exceptionAmount = totalExceptionBucket * RATE_EXCEPTION;
  const totalAmount = regularAmount + exceptionAmount;

  // Sheet 1: Billing Summary (the one you'd use for invoicing)
  const summaryRows = [
    { Item: 'Customer / Job', Detail: jobMeta.name || '', Qty: '', Rate: '', Amount: '' },
    { Item: 'Billing Period', Detail: `${startStr} – ${endStr}`, Qty: '', Rate: '', Amount: '' },
    { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
    { Item: 'Regular Scans', Detail: 'Plain barcode scan', Qty: standardScans.length, Rate: `$${RATE_REGULAR.toFixed(2)}`, Amount: `$${regularAmount.toFixed(2)}` },
    { Item: 'Exceptions Total', Detail: 'Manual + AI Camera + Exceptions', Qty: totalExceptionBucket, Rate: `$${RATE_EXCEPTION.toFixed(2)}`, Amount: `$${exceptionAmount.toFixed(2)}` },
    { Item: '   • Manual entries', Detail: 'Operator typed ISBN', Qty: manualScans.length, Rate: '', Amount: '' },
    { Item: '   • AI Camera entries', Detail: 'AI extracted ISBN from cover photo', Qty: aiScans.length, Rate: '', Amount: '' },
    { Item: '   • Logged exceptions', Detail: 'Damaged / no-barcode', Qty: exceptionScansInline + exceptionScansFromCollection, Rate: '', Amount: '' },
    { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
    { Item: 'TOTAL UNITS', Detail: '', Qty: standardScans.length + totalExceptionBucket, Rate: '', Amount: `$${totalAmount.toFixed(2)}` },
    { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
    { Item: 'DISCLAIMER', Detail: 'Book titles in this report may have been extracted from cover images using AI (OCR). Titles should be verified for accuracy.', Qty: '', Rate: '', Amount: '' },
  ];
  const ws1 = XLSX.utils.json_to_sheet(summaryRows);
  // Widen columns
  ws1['!cols'] = [{ wch: 22 }, { wch: 36 }, { wch: 12 }, { wch: 10 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Billing Summary');

  // Sheet 2: Daily breakdown — split by category
  const dailyMap = {};
  const bumpDay = (d, key) => {
    const date = d?.toDate ? d.toDate() : new Date(d);
    const k = date.toLocaleDateString();
    if (!dailyMap[k]) dailyMap[k] = { date: k, standard: 0, manual: 0, ai: 0, exception: 0 };
    dailyMap[k][key]++;
  };
  for (const s of scans) {
    if (isException(s)) bumpDay(s.timestamp, 'exception');
    else if (isManual(s)) bumpDay(s.timestamp, 'manual');
    else if (isAi(s)) bumpDay(s.timestamp, 'ai');
    else bumpDay(s.timestamp, 'standard');
  }
  for (const ex of exceptions) bumpDay(ex.timestamp, 'exception');

  const dailyRows = Object.values(dailyMap)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((d) => {
      const excBucket = d.manual + d.ai + d.exception;
      return {
        Date: d.date,
        'Regular Scans': d.standard,
        'Manual': d.manual,
        'AI Camera': d.ai,
        'Exceptions': d.exception,
        'Day Total': d.standard + excBucket,
        Amount: `$${(d.standard * RATE_REGULAR + excBucket * RATE_EXCEPTION).toFixed(2)}`,
      };
    });
  // Add totals row
  const tStandard = dailyRows.reduce((s, r) => s + r['Regular Scans'], 0);
  const tManual = dailyRows.reduce((s, r) => s + r['Manual'], 0);
  const tAi = dailyRows.reduce((s, r) => s + r['AI Camera'], 0);
  const tExc = dailyRows.reduce((s, r) => s + r['Exceptions'], 0);
  const tBucket = tManual + tAi + tExc;
  dailyRows.push({
    Date: 'TOTAL',
    'Regular Scans': tStandard,
    'Manual': tManual,
    'AI Camera': tAi,
    'Exceptions': tExc,
    'Day Total': tStandard + tBucket,
    Amount: `$${(tStandard * RATE_REGULAR + tBucket * RATE_EXCEPTION).toFixed(2)}`,
  });
  const ws2 = XLSX.utils.json_to_sheet(dailyRows);
  ws2['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Daily Breakdown');

  // Sheet 3: By Pod
  const podMap = {};
  for (const s of scans) {
    const pod = s.podId || 'Unknown';
    if (!podMap[pod]) podMap[pod] = { standard: 0, exceptions: 0 };
    if (s.type === 'standard' && s.source !== 'manual') podMap[pod].standard++;
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
    if (s.type === 'standard' && s.source !== 'manual') opMap[op].standard++;
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
  return {
    buf,
    fileName,
    breakdown: {
      standardCount: standardScans.length,
      manualCount: manualScans.length,
      aiMatchCount: aiScans.length,
      loggedExceptionCount: exceptionScansInline + exceptionScansFromCollection,
      exceptionBucketCount: totalExceptionBucket,
      totalAmount,
    },
  };
}
