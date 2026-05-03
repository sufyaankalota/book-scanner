import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getCountFromServer } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const target = process.argv[2];
if (!target) { console.error('Usage: count-chunks.mjs <parentPath>'); process.exit(1); }
const snap = await getCountFromServer(collection(db, target, 'manifest-chunks'));
console.log(`${target}/manifest-chunks: ${snap.data().count} docs`);
process.exit(0);
