/**
 * Print PO → ISBN count breakdown for a job, plus the configured color/number.
 * Usage: node scripts/po-color-breakdown.mjs <jobId>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDoc, getDocs } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const jobId = process.argv[2] || 'job_1777780134130';
const jobSnap = await getDoc(doc(db, 'jobs', jobId));
if (!jobSnap.exists()) { console.error(`Job ${jobId} not found`); process.exit(1); }
const job = jobSnap.data();
console.log(`\nJob: ${job.meta?.name || jobId}  (mode=${job.meta?.mode})`);
console.log(`manifestMeta: chunked=${!!job.manifestMeta?.chunked}  chunks=${job.manifestMeta?.numChunks ?? '-'}  totalIsbns=${job.manifestMeta?.totalIsbns ?? '-'}\n`);

const colors = job.poColors || {};
const numbers = job.poNumbers || {};
let poCounts = job.manifestMeta?.poCounts || null;

// Fall back to scanning all chunks if no poCounts pre-computed
if (!poCounts) {
  console.log('No precomputed poCounts — scanning manifest-chunks…');
  poCounts = {};
  const chunks = await getDocs(collection(db, 'jobs', jobId, 'manifest-chunks'));
  let n = 0;
  for (const cd of chunks.docs) {
    const obj = cd.data().isbns || {};
    for (const v of Object.values(obj)) {
      const po = (typeof v === 'string') ? v : (v?.p || '');
      if (!po) continue;
      poCounts[po] = (poCounts[po] || 0) + 1;
    }
    n++;
    if (n % 200 === 0) process.stdout.write(`  ${n}/${chunks.size}\r`);
  }
  console.log(`Scanned ${n} chunks.\n`);
}

const COLOR_NAMES = {
  '#EF4444': 'RED', '#3B82F6': 'BLUE', '#EAB308': 'YELLOW',
  '#22C55E': 'GREEN', '#F97316': 'ORANGE', '#A855F7': 'PURPLE',
  '#EC4899': 'PINK', '#14B8A6': 'TEAL', '#92400E': 'BROWN', '#CA8A04': 'GOLD',
  '#000000': 'BLACK', '#FFFFFF': 'WHITE',
};
const colorName = (hex) => COLOR_NAMES[String(hex || '').toUpperCase()] || hex || '?';

// Group by color
const byColor = {};
for (const po of Object.keys(poCounts)) {
  const hex = colors[po] || '(no-color)';
  if (!byColor[hex]) byColor[hex] = [];
  byColor[hex].push({ po, count: poCounts[po], number: numbers[po] });
}

const total = Object.values(poCounts).reduce((s, n) => s + n, 0);
console.log(`Total POs: ${Object.keys(poCounts).length}  | Total ISBNs: ${total.toLocaleString()}\n`);

console.log('PO breakdown by color:');
console.log('========================================================================');
const sortedColors = Object.entries(byColor).sort((a, b) => {
  const aSum = a[1].reduce((s, x) => s + x.count, 0);
  const bSum = b[1].reduce((s, x) => s + x.count, 0);
  return bSum - aSum;
});
for (const [hex, pos] of sortedColors) {
  const sum = pos.reduce((s, x) => s + x.count, 0);
  console.log(`\n${colorName(hex).padEnd(8)} ${hex.padEnd(10)}  ${pos.length} PO${pos.length !== 1 ? 's' : ''}  ${sum.toLocaleString()} ISBNs  (${(sum * 100 / total).toFixed(1)}%)`);
  pos.sort((a, b) => b.count - a.count);
  for (const p of pos) {
    const numStr = p.number != null ? `#${p.number}` : '';
    console.log(`   ${numStr.padEnd(5)} ${p.po.padEnd(30)} ${p.count.toLocaleString()}`);
  }
}
process.exit(0);
