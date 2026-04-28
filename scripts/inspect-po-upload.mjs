import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, getDoc, doc, query, limit } from 'firebase/firestore';
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

const ID = 'po_1777342174408';

async function main() {
  console.log(`Inspecting po-uploads/${ID}...`);
  const snap = await getDoc(doc(db, 'po-uploads', ID));
  if (!snap.exists()) { console.log('Doc does not exist.'); return; }
  console.log('Doc data keys:', Object.keys(snap.data()));
  console.log('manifestMeta:', JSON.stringify(snap.data().manifestMeta));

  // sample manifest-chunks (limit 5)
  const chunkSnap = await getDocs(query(collection(db, 'po-uploads', ID, 'manifest-chunks'), limit(5)));
  console.log('manifest-chunks sample (limit 5):', chunkSnap.size, 'docs');
  chunkSnap.docs.forEach((d) => console.log('  chunk', d.id, 'isbns count=', Object.keys(d.data().isbns || {}).length));

  // sample manifest (limit 5)
  const manSnap = await getDocs(query(collection(db, 'po-uploads', ID, 'manifest'), limit(5)));
  console.log('manifest sample (limit 5):', manSnap.size, 'docs');
  manSnap.docs.forEach((d) => console.log('  manifest', d.id));

  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
