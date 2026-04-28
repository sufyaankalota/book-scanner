// Re-assigns poColors on a po-uploads doc using the canonical app palette,
// so dropdowns + swatches stay in sync.
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const PALETTE = [
  '#EF4444', '#3B82F6', '#EAB308', '#22C55E',
  '#F97316', '#A855F7', '#EC4899', '#14B8A6',
  '#92400E', '#CA8A04',
];

const ID = process.argv[2];
if (!ID) { console.error('Usage: node scripts/fix-po-colors.mjs <uploadId>'); process.exit(1); }

const app = initializeApp({
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
});
const db = getFirestore(app);

const ref = doc(db, 'po-uploads', ID);
const snap = await getDoc(ref);
if (!snap.exists()) { console.error('Doc not found'); process.exit(1); }
const data = snap.data();
const poNames = data.poNames || [];
const oldColors = data.poColors || {};
const newColors = {};
poNames.forEach((p, i) => { newColors[p] = PALETTE[i % PALETTE.length]; });

console.log('Old colors:', oldColors);
console.log('New colors:', newColors);
await updateDoc(ref, { poColors: newColors });
console.log('Done.');
process.exit(0);
