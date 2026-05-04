// Set/get the customer-facing API key for /exportExceptionsHttp.
// Usage:
//   node scripts/set-export-api-key.mjs            # show current
//   node scripts/set-export-api-key.mjs rotate     # generate a new random key
//   node scripts/set-export-api-key.mjs <my-key>   # set a specific key
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const ref = doc(db, 'config', 'api');
const arg = process.argv[2];

if (!arg) {
  const snap = await getDoc(ref);
  console.log(snap.exists() ? snap.data() : '(no config/api doc)');
  process.exit(0);
}

const key = arg === 'rotate' ? crypto.randomBytes(24).toString('base64url') : arg;
await setDoc(ref, { exceptionExportKey: key, updatedAt: Date.now() }, { merge: true });
console.log('Set exceptionExportKey =', key);
console.log('Endpoint: https://us-east1-book-scanner-277a3.cloudfunctions.net/exportExceptionsHttp?jobId=<jobId>&key=' + key);
process.exit(0);
