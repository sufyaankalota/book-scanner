// Paginated bulk delete of legacy manifest subcollection.
// Repeatedly queries small pages and batch-deletes until empty.
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, deleteDoc, writeBatch, query, limit } from 'firebase/firestore';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const app = initializeApp({
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
});
const db = getFirestore(app);

const ID = process.argv[2];
if (!ID) { console.error('Usage: node scripts/delete-po-paginated.mjs <uploadId>'); process.exit(1); }

const PAGE = 500;
const PARALLEL = 6; // concurrent batches
const COLL_PATH = `po-uploads/${ID}/manifest`;

async function deletePage() {
  const snap = await getDocs(query(collection(db, 'po-uploads', ID, 'manifest'), limit(PAGE)));
  if (snap.empty) return 0;
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

async function main() {
  console.log(`Paginated delete of ${COLL_PATH} (parallel=${PARALLEL})`);
  let total = 0;
  const start = Date.now();
  let lastReport = start;
  while (true) {
    const results = await Promise.all(Array.from({ length: PARALLEL }, () => deletePage()));
    const sum = results.reduce((a, b) => a + b, 0);
    if (sum === 0) break;
    total += sum;
    if (Date.now() - lastReport > 2000) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = Math.round(total / elapsed);
      const eta = rate > 0 ? Math.round((8688082 - total) / rate / 60) : '?';
      process.stdout.write(`\r  deleted ${total.toLocaleString()}  (${rate.toLocaleString()}/sec, ETA ${eta} min)        `);
      lastReport = Date.now();
    }
    // If we got less than full pages, near-end
    if (results.some((r) => r < PAGE)) {
      // do final cleanup pass
      while (true) {
        const n = await deletePage();
        if (n === 0) break;
        total += n;
      }
      break;
    }
  }
  process.stdout.write('\n');

  // Also attempt manifest-chunks (in case there are any)
  let chunkTotal = 0;
  while (true) {
    const snap = await getDocs(query(collection(db, 'po-uploads', ID, 'manifest-chunks'), limit(PAGE)));
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    chunkTotal += snap.size;
    if (snap.size < PAGE) break;
  }
  if (chunkTotal) console.log(`Deleted ${chunkTotal} manifest-chunks docs`);

  console.log('Deleting upload doc...');
  await deleteDoc(doc(db, 'po-uploads', ID));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done. Deleted ${total.toLocaleString()} manifest docs in ${elapsed}s.`);
  process.exit(0);
}
main().catch((err) => { console.error('ERROR:', err); process.exit(1); });
