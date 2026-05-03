import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, limit, getDocs } from 'firebase/firestore';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const jobId = process.argv[2] || 'job_1777780134130';
const all = await getDocs(query(collection(db, 'scans'), where('jobId', '==', jobId), limit(10000)));
const counts = {}; const sourceTitle = {};
for (const d of all.docs) {
  const v = d.data();
  const s = v.source || '(none)';
  counts[s] = (counts[s] || 0) + 1;
  if (v.capturedTitle) sourceTitle[s] = (sourceTitle[s] || 0) + 1;
}
console.log(`total scans for ${jobId}: ${all.size}`);
console.log('by source:', counts);
console.log('with capturedTitle:', sourceTitle);

// Sample 20 latest with capturedTitle
const withTitle = all.docs
  .filter((d) => d.data().capturedTitle)
  .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0))
  .slice(0, 20);
console.log(`\nlatest ${withTitle.length} scans WITH capturedTitle:`);
for (const d of withTitle) {
  const v = d.data();
  const t = v.timestamp?.toMillis?.() ? new Date(v.timestamp.toMillis()).toISOString().slice(0, 19) : '?';
  console.log(`${t}  source=${(v.source || '-').padEnd(10)}  type=${(v.type || '-').padEnd(10)}  isbn=${(v.isbn || '(none)').padEnd(13)}  po=${(v.poName || '-').padEnd(15)}  score=${v.matchScore ?? '-'}  title="${(v.capturedTitle || '').slice(0, 50)}"`);
}

// Also sample all exception scans
const excs = all.docs.filter((d) => d.data().type === 'exception')
  .sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0))
  .slice(0, 20);
console.log(`\nlatest ${excs.length} exception scans (any source):`);
for (const d of excs) {
  const v = d.data();
  const t = v.timestamp?.toMillis?.() ? new Date(v.timestamp.toMillis()).toISOString().slice(0, 19) : '?';
  console.log(`${t}  source=${(v.source || '-').padEnd(10)}  isbn=${(v.isbn || '(none)').padEnd(13)}  po=${(v.poName || '-').padEnd(15)}  title="${(v.capturedTitle || '').slice(0, 50)}"`);
}
process.exit(0);
