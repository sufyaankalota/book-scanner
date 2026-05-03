/**
 * Delete a po-uploads/<id> doc and all its manifest-chunks subdocs.
 * Uses individual deleteDoc calls with bounded concurrency to avoid the
 * "Transaction too big" Firestore limit that batches hit on chunks > ~500KB.
 *
 * Usage: node scripts/delete-old-upload.mjs <po-uploads/id>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, deleteDoc } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
const app = initializeApp(cfg);
const db = getFirestore(app);

async function main() {
  const target = process.argv[2];
  if (!target) { console.error('Usage: delete-old-upload.mjs <po-uploads/id>'); process.exit(1); }
  const [coll, id] = target.split('/');
  const parent = await getDoc(doc(db, coll, id));
  if (!parent.exists()) { console.error(`Not found: ${target}`); process.exit(1); }
  const numChunks = parent.data().manifestMeta?.numChunks || 0;
  console.log(`Deleting ${numChunks.toLocaleString()} chunks under ${target}…`);
  const PAR = 20;
  let done = 0;
  for (let i = 0; i < numChunks; i += PAR) {
    const slice = [];
    for (let j = i; j < Math.min(i + PAR, numChunks); j++) {
      slice.push(deleteDoc(doc(db, target, 'manifest-chunks', `c${String(j).padStart(5, '0')}`)));
    }
    await Promise.all(slice);
    done += slice.length;
    process.stdout.write(`\r  ${done.toLocaleString()}/${numChunks.toLocaleString()}`);
  }
  process.stdout.write('\n');
  await deleteDoc(doc(db, coll, id));
  console.log(`Deleted parent doc ${target}`);
  process.exit(0);
}
main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
