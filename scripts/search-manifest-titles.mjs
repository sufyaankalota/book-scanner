/**
 * Search a job's manifest chunks for titles matching given search terms.
 * Usage: node search-manifest-titles.mjs <jobId> "term1" "term2" ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, collection, getDoc, getDocs, query, where, limit } from 'firebase/firestore';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const jobId = process.argv[2];
const terms = process.argv.slice(3).map((t) => t.toLowerCase());
if (!jobId || !terms.length) { console.error('usage: <jobId> term1 term2 …'); process.exit(1); }

const jobSnap = await getDoc(doc(db, 'jobs', jobId));
const job = jobSnap.data();
const numChunks = job?.manifestMeta?.numChunks;
console.log(`Job ${jobId}: chunks=${numChunks}, hasTitles=${job?.manifestMeta?.hasTitles}`);

const matches = Object.fromEntries(terms.map((t) => [t, []]));
let totalIsbns = 0;
let chunksScanned = 0;
const startTs = Date.now();

// Scan manifest-chunks subcollection
const chunksSnap = await getDocs(collection(db, 'jobs', jobId, 'manifest-chunks'));
console.log(`Loaded ${chunksSnap.size} manifest-chunk docs`);

for (const cd of chunksSnap.docs) {
  const data = cd.data();
  const obj = data.isbns || {};
  for (const [isbn, val] of Object.entries(obj)) {
    totalIsbns++;
    const title = (typeof val === 'string') ? val : (val?.t || '');
    if (!title) continue;
    const lower = String(title).toLowerCase();
    for (const t of terms) {
      if (lower.includes(t)) {
        if (matches[t].length < 8) matches[t].push({ isbn, title, po: typeof val === 'object' ? val.p : '?' });
      }
    }
  }
  chunksScanned++;
}
console.log(`Scanned ${chunksScanned} chunks / ${totalIsbns} isbns in ${Math.round((Date.now()-startTs)/1000)}s\n`);

for (const t of terms) {
  console.log(`\n=== "${t}" → ${matches[t].length} matches (showing up to 8) ===`);
  for (const m of matches[t]) {
    console.log(`  ${m.isbn}  [${m.po}]  ${m.title}`);
  }
}
process.exit(0);
