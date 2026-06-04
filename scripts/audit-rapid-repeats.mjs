// One-time inflation audit: rapid same-ISBN repeats by scanner, today + yesterday.
// Writes an .xlsx workbook with Summary, By Scanner, and every inflated event.
// Usage: node scripts/audit-rapid-repeats.mjs [windowSeconds=30]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, orderBy, Timestamp, getDocs } from 'firebase/firestore';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const WINDOW_SEC = Number(process.argv[2]) || 30;
const WINDOW_MS = WINDOW_SEC * 1000;

const now = new Date();
const today = new Date(now); today.setHours(0, 0, 0, 0);
const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

const dayLabel = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cleanIsbn = (s) => String(s || '').replace(/[^0-9X]/gi, '').toUpperCase();

console.log(`Audit window: same scanner + same ISBN within ${WINDOW_SEC}s`);
console.log(`Range: ${yesterday.toISOString()} → ${tomorrow.toISOString()} (yesterday + today)`);

const snap = await getDocs(query(
  collection(db, 'scans'),
  where('timestamp', '>=', Timestamp.fromDate(yesterday)),
  where('timestamp', '<', Timestamp.fromDate(tomorrow)),
  orderBy('timestamp', 'asc'),
));
console.log(`Fetched ${snap.size} scan docs.`);

// Group by scanner|isbn
const groups = new Map();
const totalsByScannerDay = new Map(); // scanner|day -> total scans

for (const d of snap.docs) {
  const v = d.data();
  const ts = v.timestamp?.toDate?.();
  if (!ts) continue;
  const isbn = cleanIsbn(v.isbn);
  if (!isbn) continue;
  const scanner = (v.scannerId || 'unknown').toString().trim() || 'unknown';
  const day = dayLabel(ts);
  const totKey = `${scanner.toLowerCase()}|${day}`;
  totalsByScannerDay.set(totKey, (totalsByScannerDay.get(totKey) || 0) + 1);

  const k = `${scanner.toLowerCase()}|${isbn}|${day}`;
  if (!groups.has(k)) groups.set(k, { scanner, isbn, day, items: [] });
  groups.get(k).items.push({ id: d.id, ts, jobId: v.jobId || '(no-job)', poName: v.poName || '', type: v.type || '', source: v.source || '', duplicateOverride: !!v.duplicateOverride });
}

// Find rapid-repeat events
const events = [];
const perScannerDay = new Map();

for (const g of groups.values()) {
  if (g.items.length < 2) continue;
  g.items.sort((a, b) => a.ts - b.ts);
  let burstStartTs = null;
  let burstIndex = 0;
  for (let i = 1; i < g.items.length; i++) {
    const dt = g.items[i].ts - g.items[i - 1].ts;
    if (dt < WINDOW_MS) {
      if (burstStartTs === null) { burstStartTs = g.items[i - 1].ts; burstIndex = 1; }
      burstIndex += 1;
      events.push({
        scanner: g.scanner,
        day: g.day,
        isbn: g.isbn,
        jobId: g.items[i].jobId,
        poName: g.items[i].poName,
        firstScanAt: g.items[i - 1].ts,
        repeatScanAt: g.items[i].ts,
        gapSeconds: Math.round(dt / 100) / 10,
        burstPosition: burstIndex,
        repeatScanId: g.items[i].id,
        source: g.items[i].source,
        duplicateOverride: g.items[i].duplicateOverride,
      });
      const key = `${g.scanner.toLowerCase()}|${g.day}`;
      if (!perScannerDay.has(key)) perScannerDay.set(key, { scanner: g.scanner, day: g.day, inflated: 0, isbns: new Set(), worstGap: Infinity, longestBurst: 0 });
      const row = perScannerDay.get(key);
      row.inflated += 1;
      row.isbns.add(g.isbn);
      if (dt / 1000 < row.worstGap) row.worstGap = dt / 1000;
      if (burstIndex > row.longestBurst) row.longestBurst = burstIndex;
    } else {
      burstStartTs = null;
      burstIndex = 0;
    }
  }
}

// Per-scanner-day rollup with totals + pct
const byScanner = Array.from(perScannerDay.values()).map((r) => {
  const total = totalsByScannerDay.get(`${r.scanner.toLowerCase()}|${r.day}`) || 0;
  return {
    Scanner: r.scanner,
    Day: r.day,
    'Total Scans': total,
    'Inflated Scans': r.inflated,
    'Distinct ISBNs Abused': r.isbns.size,
    '% Inflated': total ? Math.round((r.inflated / total) * 1000) / 10 : 0,
    'Worst Gap (s)': r.worstGap === Infinity ? '' : r.worstGap,
    'Longest Burst': r.longestBurst,
  };
}).sort((a, b) => b['Inflated Scans'] - a['Inflated Scans']);

// Per-scanner totals (both days combined)
const combined = new Map();
for (const r of byScanner) {
  const k = r.Scanner.toLowerCase();
  if (!combined.has(k)) combined.set(k, { Scanner: r.Scanner, 'Total Scans': 0, 'Inflated Scans': 0, 'Distinct ISBNs Abused': 0, 'Longest Burst': 0 });
  const c = combined.get(k);
  c['Total Scans'] += r['Total Scans'];
  c['Inflated Scans'] += r['Inflated Scans'];
  c['Distinct ISBNs Abused'] += r['Distinct ISBNs Abused'];
  if (r['Longest Burst'] > c['Longest Burst']) c['Longest Burst'] = r['Longest Burst'];
}
const combinedRows = Array.from(combined.values()).map((c) => ({
  ...c,
  '% Inflated': c['Total Scans'] ? Math.round((c['Inflated Scans'] / c['Total Scans']) * 1000) / 10 : 0,
})).sort((a, b) => b['Inflated Scans'] - a['Inflated Scans']);

const eventRows = events.map((e) => ({
  Scanner: e.scanner,
  Day: e.day,
  ISBN: e.isbn,
  Job: e.jobId,
  PO: e.poName,
  'First Scan': e.firstScanAt.toLocaleString(),
  'Inflated Repeat': e.repeatScanAt.toLocaleString(),
  'Gap (s)': e.gapSeconds,
  'Position In Burst': e.burstPosition,
  Source: e.source,
  'Mgr Override': e.duplicateOverride ? 'YES' : '',
  'Scan Doc ID': e.repeatScanId,
})).sort((a, b) => a.Scanner.localeCompare(b.Scanner) || a.Day.localeCompare(b.Day) || a['Inflated Repeat'].localeCompare(b['Inflated Repeat']));

const summary = [
  ['Inflation Audit — Rapid Same-ISBN Repeats'],
  [`Generated: ${now.toLocaleString()}`],
  [`Window: same scanner + same ISBN within ${WINDOW_SEC} seconds`],
  [`Days: ${dayLabel(yesterday)} (yesterday) and ${dayLabel(today)} (today)`],
  [],
  [`Total scans audited: ${snap.size}`],
  [`Total inflated repeats: ${events.length}`],
  [`Scanners affected: ${combined.size}`],
  [],
  ['How to read "Inflated Scans":'],
  ['  Every 2nd/3rd/etc. scan of the SAME ISBN by the SAME scanner within the window.'],
  ['  The original (first) scan in each burst is NOT counted — only the repeats.'],
  ['  Subtract "Inflated Scans" from that scanner\'s leaderboard / pay total.'],
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(combinedRows), 'By Scanner (Both Days)');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byScanner), 'By Scanner Per Day');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventRows), 'Every Inflated Event');

const outFile = path.join(process.cwd(), `inflation-audit_${dayLabel(yesterday)}_to_${dayLabel(today)}.xlsx`);
XLSX.writeFile(wb, outFile);
console.log(`\n✅ Wrote ${outFile}`);
console.log(`   ${eventRows.length} inflated events across ${combined.size} scanners.`);
if (combinedRows.length) {
  console.log('\nTop offenders:');
  for (const r of combinedRows.slice(0, 10)) {
    console.log(`   ${r.Scanner.padEnd(28)} ${String(r['Inflated Scans']).padStart(5)} inflated / ${String(r['Total Scans']).padStart(6)} total  (${r['% Inflated']}%)`);
  }
}
process.exit(0);
