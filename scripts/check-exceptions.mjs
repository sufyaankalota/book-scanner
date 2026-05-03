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
const all = await getDocs(query(collection(db, 'exceptions'), where('jobId', '==', jobId), limit(5000)));
console.log(`exceptions for ${jobId}: ${all.size}\n`);
const sorted = all.docs.slice().sort((a, b) => (b.data().timestamp?.toMillis?.() || 0) - (a.data().timestamp?.toMillis?.() || 0)).slice(0, 25);
for (const d of sorted) {
  const v = d.data();
  const t = v.timestamp?.toMillis?.() ? new Date(v.timestamp.toMillis()).toISOString().slice(0, 19) : '?';
  console.log(`${t}  reason=${(v.reason || '-').padEnd(18)}  isbn=${(v.isbn || '(none)').padEnd(13)}  hasPhoto=${!!v.photo}  title="${(v.title || '').slice(0, 60)}"`);
}
process.exit(0);
