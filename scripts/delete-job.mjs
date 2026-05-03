/**
 * Delete a job doc and all its manifest-chunks subdocs (paginated, since we
 * don't know how many were partially copied). Used to clean up a job whose
 * activation was aborted mid-copy.
 *
 * Usage: node scripts/delete-job.mjs jobs/<id>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, doc, getDocs, deleteDoc, query, orderBy, limit, startAfter,
} from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const target = process.argv[2];
if (!target) { console.error('Usage: delete-job.mjs jobs/<id>'); process.exit(1); }
const [coll, id] = target.split('/');

console.log(`Scanning chunks under ${target}/manifest-chunks…`);
let lastDoc = null;
let total = 0;
const PAGE = 200;
const PAR = 20;
while (true) {
  const q = lastDoc
    ? query(collection(db, target, 'manifest-chunks'), orderBy('__name__'), startAfter(lastDoc), limit(PAGE))
    : query(collection(db, target, 'manifest-chunks'), orderBy('__name__'), limit(PAGE));
  const snap = await getDocs(q);
  if (snap.empty) break;
  for (let i = 0; i < snap.docs.length; i += PAR) {
    const slice = snap.docs.slice(i, i + PAR);
    await Promise.all(slice.map((d) => deleteDoc(d.ref)));
    total += slice.length;
    process.stdout.write(`\r  deleted ${total}`);
  }
  lastDoc = snap.docs[snap.docs.length - 1];
  if (snap.docs.length < PAGE) break;
}
process.stdout.write('\n');
await deleteDoc(doc(db, coll, id));
console.log(`Deleted parent doc ${target}`);
process.exit(0);
