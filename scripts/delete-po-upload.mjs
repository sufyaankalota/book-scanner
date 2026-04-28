// One-shot script to delete a specific large PO upload from Firestore.
// Run with: node scripts/delete-po-upload.mjs
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, getDoc, doc, deleteDoc, writeBatch, query, where } from 'firebase/firestore';
import { config } from 'dotenv';
config();

const app = initializeApp({
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
});
const db = getFirestore(app);

async function deleteChunksByCount(parentPath, numChunks) {
  let count = 0;
  for (let start = 0; start < numChunks; start += 400) {
    const batch = writeBatch(db);
    const end = Math.min(start + 400, numChunks);
    for (let i = start; i < end; i++) {
      batch.delete(doc(db, parentPath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`));
    }
    await batch.commit();
    count += end - start;
    process.stdout.write(`\r  chunks deleted: ${count}/${numChunks}`);
  }
  process.stdout.write('\n');
  return count;
}

async function deleteAllSubcollection(parentPath, sub) {
  const snap = await getDocs(collection(db, parentPath, sub));
  if (snap.empty) return 0;
  let count = 0;
  let batch = writeBatch(db);
  for (const d of snap.docs) {
    batch.delete(d.ref);
    count++;
    if (count % 400 === 0) {
      await batch.commit();
      batch = writeBatch(db);
      process.stdout.write(`\r  ${sub} deleted: ${count}`);
    }
  }
  if (count % 400 !== 0) await batch.commit();
  process.stdout.write(`\r  ${sub} deleted: ${count}\n`);
  return count;
}

async function main() {
  console.log('Listing PO uploads sorted by ISBN count...');
  const snap = await getDocs(collection(db, 'po-uploads'));
  const uploads = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  uploads.sort((a, b) => (b.isbnCount || 0) - (a.isbnCount || 0));
  for (const u of uploads.slice(0, 5)) {
    console.log(`  ${u.id}  isbnCount=${u.isbnCount?.toLocaleString()}  status=${u.status}  chunked=${!!u.manifestMeta?.chunked}  numChunks=${u.manifestMeta?.numChunks}  poNames=${(u.poNames || []).join(',').slice(0, 60)}`);
  }

  const target = uploads.find((u) => (u.isbnCount || 0) === 8688082) || uploads[0];
  if (!target) { console.log('No uploads found.'); return; }
  console.log(`\nTarget: ${target.id}  (${target.isbnCount?.toLocaleString()} ISBNs, status=${target.status})`);

  const arg = process.argv[2];
  if (arg !== '--confirm') {
    console.log('\nDry run only. To delete, re-run with: node scripts/delete-po-upload.mjs --confirm');
    return;
  }

  const meta = target.manifestMeta || {};
  if (meta.chunked && meta.numChunks) {
    console.log(`\nDeleting ${meta.numChunks} manifest chunks...`);
    await deleteChunksByCount(`po-uploads/${target.id}`, meta.numChunks);
  } else {
    console.log('\nDeleting manifest-chunks (unknown count, scanning)...');
    await deleteAllSubcollection(`po-uploads/${target.id}`, 'manifest-chunks');
  }

  console.log('Deleting legacy manifest subcollection (if any)...');
  await deleteAllSubcollection(`po-uploads/${target.id}`, 'manifest');

  console.log('Deleting upload doc...');
  await deleteDoc(doc(db, 'po-uploads', target.id));
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => { console.error('ERROR:', err); process.exit(1); });
