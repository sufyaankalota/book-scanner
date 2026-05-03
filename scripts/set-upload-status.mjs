/**
 * Set status='pending' on a po-uploads doc so the "Use This" button appears
 * in Setup.jsx (it's gated on status === 'pending').
 *
 * Usage: node scripts/set-upload-status.mjs <po-uploads/id> [status]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, updateDoc } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const target = process.argv[2];
const status = process.argv[3] || 'pending';
if (!target) { console.error('Usage: set-upload-status.mjs <po-uploads/id> [status]'); process.exit(1); }
const [coll, id] = target.split('/');
await updateDoc(doc(db, coll, id), { status });
console.log(`Set ${target} status=${status}`);
process.exit(0);
