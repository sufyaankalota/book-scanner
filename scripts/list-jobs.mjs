/**
 * List recent jobs (most recently started/created first) to find a job that
 * was partially activated and may have orphaned manifest-chunks under it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
initializeApp(cfg);
const db = getFirestore();

const snap = await getDocs(collection(db, 'jobs'));
const items = snap.docs.map((d) => {
  const j = d.data();
  const t = j.startedAt?.toMillis?.() || (typeof j.startedAt === 'number' ? j.startedAt : 0)
         || j.createdAt?.toMillis?.() || (typeof j.createdAt === 'number' ? j.createdAt : 0);
  return { id: d.id, t, status: j.status, name: j.meta?.name, mode: j.meta?.mode, numChunks: j.manifestMeta?.numChunks, hasTitles: j.manifestMeta?.hasTitles, sourceUploadId: j.sourceUploadId };
});
items.sort((a, b) => b.t - a.t);
for (const i of items.slice(0, 10)) {
  const date = i.t ? new Date(i.t).toISOString().slice(0, 16) : '?';
  console.log(`jobs/${i.id}  ${date}  status=${i.status}  mode=${i.mode}  name=${i.name || '?'}  chunks=${i.numChunks ?? '-'}  titles=${i.hasTitles ? 'yes' : 'no'}  src=${i.sourceUploadId || '-'}`);
}
process.exit(0);
