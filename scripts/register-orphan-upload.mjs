/**
 * Register the orphaned chunks under po-uploads/po_1777769451567_c4w0w2 as a
 * real po-uploads parent doc (the import script wrote chunks but failed at the
 * parent doc due to a missing `status` field in firestore.rules).
 *
 * Then delete the old 8M upload (po_1777402820818).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDoc, getDocs, writeBatch, setDoc, deleteDoc } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
const app = initializeApp(cfg);
const db = getFirestore(app);

const NEW_ID = 'po_1777769451567_c4w0w2';
const OLD_ID = 'po_1777402820818';
const NUM_CHUNKS = 4463;

async function main() {
  // 1. Sanity: count chunks under the new id and rebuild poCounts + totals + hasTitles.
  console.log(`[1/3] Scanning chunks under po-uploads/${NEW_ID}…`);
  const PAR = 16;
  const poCounts = {};
  let totalIsbns = 0;
  let hasTitles = false;
  let chunksFound = 0;
  for (let start = 0; start < NUM_CHUNKS; start += PAR) {
    const end = Math.min(start + PAR, NUM_CHUNKS);
    const reads = [];
    for (let i = start; i < end; i++) {
      reads.push(getDoc(doc(db, `po-uploads/${NEW_ID}/manifest-chunks`, `c${String(i).padStart(5, '0')}`)));
    }
    const snaps = await Promise.all(reads);
    for (const snap of snaps) {
      if (!snap.exists()) continue;
      chunksFound++;
      const isbns = snap.data().isbns || {};
      for (const v of Object.values(isbns)) {
        totalIsbns++;
        const po = typeof v === 'string' ? v : v?.p;
        const title = typeof v === 'string' ? null : v?.t;
        if (po) poCounts[po] = (poCounts[po] || 0) + 1;
        if (title) hasTitles = true;
      }
    }
    process.stdout.write(`\r  read ${end}/${NUM_CHUNKS}  (chunks present: ${chunksFound}, ISBNs: ${totalIsbns.toLocaleString()})`);
  }
  process.stdout.write('\n');
  console.log(`  ISBNs: ${totalIsbns.toLocaleString()}  POs: ${Object.keys(poCounts).length}  hasTitles: ${hasTitles}`);

  // 2. Write parent doc (rules require: poNames, isbnCount, uploadedAt, status).
  console.log(`[2/3] Writing parent doc po-uploads/${NEW_ID}…`);
  await setDoc(doc(db, 'po-uploads', NEW_ID), {
    displayName: 'Confirmed ISBN PO Map (with titles)',
    poNames: Object.keys(poCounts).sort(),
    isbnCount: totalIsbns,
    uploadedAt: Date.now(),
    status: 'ready',
    manifestMeta: {
      chunked: true,
      totalIsbns,
      numChunks: NUM_CHUNKS,
      chunkSize: 2000,
      poCounts,
      hasTitles,
    },
  });
  console.log(`  done`);

  // 3. Delete the old 8M upload (parent + its 1738 chunks).
  console.log(`[3/3] Deleting old po-uploads/${OLD_ID}…`);
  const oldParent = await getDoc(doc(db, 'po-uploads', OLD_ID));
  if (oldParent.exists()) {
    const oldNumChunks = oldParent.data().manifestMeta?.numChunks || 0;
    for (let start = 0; start < oldNumChunks; start += 400) {
      const batch = writeBatch(db);
      const end = Math.min(start + 400, oldNumChunks);
      for (let i = start; i < end; i++) {
        batch.delete(doc(db, `po-uploads/${OLD_ID}/manifest-chunks`, `c${String(i).padStart(5, '0')}`));
      }
      await batch.commit();
      process.stdout.write(`\r  deleted ${end}/${oldNumChunks}`);
    }
    process.stdout.write('\n');
    await deleteDoc(doc(db, 'po-uploads', OLD_ID));
    console.log(`  Deleted parent doc po-uploads/${OLD_ID}`);
  } else {
    console.log(`  Old upload not found — skipping`);
  }

  console.log(`\nAll done.`);
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
