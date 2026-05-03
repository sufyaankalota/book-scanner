/**
 * Validate recent AI scans — check whether title-via-AI scans are actually
 * being saved with their corresponding ISBN, and whether that ISBN is real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const jobId = process.argv[2] || 'job_1777780134130';
const N = Number(process.argv[3] || 40);

console.log(`\nLooking up last ${N} ai-match scans for job=${jobId}\n`);

const q = query(
  collection(db, 'scans'),
  where('jobId', '==', jobId),
  limit(5000),
);
const all = await getDocs(q);
const sortedDocs = all.docs.slice().sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0));
const aiDocs = sortedDocs.filter((d) => d.data().source === 'ai-match').slice(0, N);
const snap = { docs: aiDocs, size: aiDocs.length, empty: aiDocs.length === 0 };
if (snap.empty) {
  console.log(`No ai-match scans in latest ${all.size} scans for this job.`);
  process.exit(0);
}

let withIsbn = 0, withoutIsbn = 0, validIsbn = 0, invalidIsbn = 0;
const rows = [];
for (const d of snap.docs) {
  const s = d.data();
  const isbn = s.isbn || '';
  const t = s.timestamp?.toMillis?.() || 0;
  const date = t ? new Date(t).toISOString().slice(0, 19) : '?';
  const hasIsbn = !!isbn;
  hasIsbn ? withIsbn++ : withoutIsbn++;
  // basic ISBN-13 sanity: 13 digits starting 978/979
  const isValid = /^(978|979)\d{10}$/.test(isbn);
  if (hasIsbn) (isValid ? validIsbn++ : invalidIsbn++);
  rows.push({ date, isbn: isbn || '(none)', valid: isValid, captured: s.capturedTitle || '', score: s.matchScore, type: s.type, po: s.poName });
}

console.log(`AI scans: ${snap.size} | with ISBN: ${withIsbn} | missing ISBN: ${withoutIsbn} | valid ISBN-13 fmt: ${validIsbn} | invalid fmt: ${invalidIsbn}\n`);
console.log('time                isbn          valid score   po              capturedTitle');
console.log('------------------- ------------- ----- ------- --------------- -----------------------------');
for (const r of rows) {
  console.log(
    r.date.padEnd(19) + ' ' +
    String(r.isbn).padEnd(13) + ' ' +
    String(r.valid).padEnd(5) + ' ' +
    String(r.score ?? '').padEnd(7) + ' ' +
    String(r.po || '').padEnd(15) + ' ' +
    String(r.captured).slice(0, 60),
  );
}
process.exit(0);
