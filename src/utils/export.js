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

export function exportPerPO(scans, jobMeta) {
  const byPO = {};
  for (const s of scans) {
    const po = s.poName || 'UNASSIGNED';
    if (!byPO[po]) byPO[po] = [];
    byPO[po].push(s);
  }

  const files = [];
  for (const [po, poScans] of Object.entries(byPO)) {
    const wb = XLSX.utils.book_new();
    const data = poScans.map((s) => ({
      ISBN: s.isbn,
      Pod: s.podId,
      Scanner: s.scannerId,
      Timestamp: toDateString(s.timestamp),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Scans');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    files.push({
      name: `${jobMeta.name}_${po}.xlsx`,
      data: buf,
    });
  }
  return files;
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
      Timestamp: toDateString(s.timestamp),
    })),
    ...exceptions.map((ex) => ({
      ISBN: ex.isbn || '',
      Title: ex.title || '',
      Reason: ex.reason,
      PO: '',
      Pod: ex.podId,
      Scanner: ex.scannerId,
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
