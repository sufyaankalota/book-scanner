// Update a single PO color on a job (and its source po-upload, if present).
// Usage: node scripts/set-po-color.mjs <jobId> <poName> <hex>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, updateDoc } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));

const [, , jobId, poName, hex] = process.argv;
if (!jobId || !poName || !hex) {
  console.error('Usage: node scripts/set-po-color.mjs <jobId> <poName> <hex>');
  process.exit(1);
}

initializeApp(cfg);
const db = getFirestore();

const jobRef = doc(db, 'jobs', jobId);
const jobSnap = await getDoc(jobRef);
if (!jobSnap.exists()) { console.error('Job not found'); process.exit(1); }
const job = jobSnap.data();

const oldJobColor = job.poColors?.[poName];
const nextJobColors = { ...(job.poColors || {}), [poName]: hex };
console.log(`job ${jobId}: ${poName} ${oldJobColor || '(none)'} -> ${hex}`);
await updateDoc(jobRef, { poColors: nextJobColors });

const uploadId = job.sourceUploadId;
if (uploadId) {
  const upRef = doc(db, 'po-uploads', uploadId);
  const upSnap = await getDoc(upRef);
  if (upSnap.exists()) {
    const up = upSnap.data();
    const oldUpColor = up.poColors?.[poName];
    const nextUpColors = { ...(up.poColors || {}), [poName]: hex };
    console.log(`po-uploads/${uploadId}: ${poName} ${oldUpColor || '(none)'} -> ${hex}`);
    await updateDoc(upRef, { poColors: nextUpColors });
  }
}

console.log('Done.');
process.exit(0);
