// Delete any presence/{id} doc whose ID is not all-uppercase (orphans from
// case-mismatched URL entries like /pod?id=c).
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, deleteDoc } from 'firebase/firestore';
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

const snap = await getDocs(collection(db, 'presence'));
console.log(`Found ${snap.size} presence docs`);
let deleted = 0;
for (const d of snap.docs) {
  if (d.id !== d.id.toUpperCase()) {
    console.log(`  Deleting lowercase presence doc: "${d.id}"`);
    await deleteDoc(doc(db, 'presence', d.id));
    deleted++;
  }
}
console.log(`Done. Deleted ${deleted} lowercase presence doc(s).`);
process.exit(0);
