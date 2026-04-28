// Stream-ingest a large ISBN/PO CSV into Firestore as chunked manifest docs.
//
// Mirrors src/utils/manifestStore.js (CHUNK_SIZE=5000, hashIsbn(djb31)) so the
// resulting upload is fully compatible with the in-app scanner.
//
// Usage:
//   node --max-old-space-size=8192 scripts/ingest-po-csv.mjs "C:\path\to\file.csv"
//
// Optional flags:
//   --id=<uploadId>      Override doc id (default: po_<timestamp>)
//   --dry-run            Parse only, don't write to Firestore
//   --parallel=<n>       Concurrent chunk batches (default 6)

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, updateDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error('Usage: node --max-old-space-size=8192 scripts/ingest-po-csv.mjs <csvPath> [--id=<uploadId>] [--dry-run] [--parallel=6]');
  process.exit(1);
}

const idArg = args.find((a) => a.startsWith('--id='))?.slice(5);
const DRY_RUN = args.includes('--dry-run');
const PARALLEL = parseInt(args.find((a) => a.startsWith('--parallel='))?.slice(11) || '3', 10);
const BATCH_OVERRIDE = parseInt(args.find((a) => a.startsWith('--batch='))?.slice(8) || '0', 10);

const CHUNK_SIZE = 5000;
const WRITE_BATCH = BATCH_OVERRIDE || 10;

const DEFAULT_COLORS = [
  '#3B82F6', '#22C55E', '#EAB308', '#A855F7',
  '#F97316', '#EF4444', '#14B8A6', '#F59E0B',
  '#8B5CF6', '#EC4899', '#10B981', '#06B6D4',
];

function hashIsbn(isbn, numChunks) {
  let h = 0;
  for (let i = 0; i < isbn.length; i++) h = (h * 31 + isbn.charCodeAt(i)) | 0;
  return ((h % numChunks) + numChunks) % numChunks;
}

function parseCsvLine(line) {
  // Handles unquoted + simple quoted fields. Sufficient for ISBN,PO.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

async function streamParse(path) {
  const fileSize = statSync(path).size;
  const stream = createReadStream(path, { encoding: 'utf8' });
  let bytesRead = 0;
  stream.on('data', (chunk) => { bytesRead += Buffer.byteLength(chunk, 'utf8'); });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const manifest = new Map();
  const poSet = new Set();
  let header = null;
  let isbnIdx = -1;
  let poIdx = -1;
  let processed = 0;
  let skipped = 0;
  let dupes = 0;
  const t0 = Date.now();
  let lastLog = t0;

  for await (const raw of rl) {
    const line = raw.replace(/\uFEFF/g, '');
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) {
      header = cols;
      isbnIdx = cols.findIndex((c) => /isbn/i.test(c));
      poIdx = cols.findIndex((c) => /po|purchase.?order/i.test(c));
      if (isbnIdx === -1 || poIdx === -1) {
        throw new Error('Could not find ISBN and PO columns. Headers: ' + cols.join(', '));
      }
      console.log(`Header: ISBN col=${isbnIdx}, PO col=${poIdx}`);
      continue;
    }
    const isbn = String(cols[isbnIdx] || '').replace(/[-\s]/g, '').trim();
    const po = String(cols[poIdx] || '').trim();
    if (!isbn || !po) { skipped++; continue; }
    if (manifest.has(isbn)) { dupes++; continue; }
    manifest.set(isbn, po);
    poSet.add(po);
    processed++;
    const now = Date.now();
    if (now - lastLog > 2000) {
      const pct = ((bytesRead / fileSize) * 100).toFixed(1);
      const rate = Math.round(processed / ((now - t0) / 1000));
      console.log(`  parsed ${processed.toLocaleString()} (${pct}%, ${rate.toLocaleString()}/sec)`);
      lastLog = now;
    }
  }
  console.log(`Parse done: ${processed.toLocaleString()} unique ISBNs, ${poSet.size} POs, ${dupes.toLocaleString()} dupes, ${skipped.toLocaleString()} skipped (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return { manifest, poNames: [...poSet] };
}

function bucketize(manifest, numChunks) {
  const chunks = new Array(numChunks);
  const poCounts = {};
  for (const [isbn, po] of manifest) {
    const idx = hashIsbn(isbn, numChunks);
    if (!chunks[idx]) chunks[idx] = {};
    chunks[idx][isbn] = po;
    poCounts[po] = (poCounts[po] || 0) + 1;
  }
  return { chunks, poCounts };
}

async function writeChunkBatch(db, parentPath, slice) {
  const maxAttempts = 6;
  let attempt = 0;
  while (true) {
    try {
      const batch = writeBatch(db);
      for (const { idx, isbns } of slice) {
        batch.set(doc(db, parentPath, 'manifest-chunks', `c${String(idx).padStart(5, '0')}`), { isbns });
      }
      await batch.commit();
      return;
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts) throw err;
      const wait = Math.min(30000, 500 * 2 ** attempt);
      console.warn(`  batch retry ${attempt}/${maxAttempts} in ${wait}ms — ${err.code || err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function writeAllChunks(db, parentPath, chunks) {
  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]) items.push({ idx: i, isbns: chunks[i] });
  }
  // Slice into batches of WRITE_BATCH chunk-docs each.
  const batches = [];
  for (let i = 0; i < items.length; i += WRITE_BATCH) {
    batches.push(items.slice(i, i + WRITE_BATCH));
  }
  let written = 0;
  const t0 = Date.now();
  let lastLog = t0;

  // Concurrency-limited runner.
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const myIdx = cursor++;
      if (myIdx >= batches.length) return;
      const slice = batches[myIdx];
      await writeChunkBatch(db, parentPath, slice);
      written += slice.length;
      const now = Date.now();
      if (now - lastLog > 2000) {
        const elapsed = (now - t0) / 1000;
        const rate = written / elapsed;
        const eta = ((items.length - written) / Math.max(rate, 1)).toFixed(0);
        console.log(`  wrote ${written.toLocaleString()} / ${items.length.toLocaleString()} chunks (${rate.toFixed(1)}/sec, ETA ${eta}s)`);
        lastLog = now;
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  console.log(`Write done: ${items.length.toLocaleString()} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return items.length;
}

async function main() {
  console.log(`File: ${filePath}`);
  const sizeMB = (statSync(filePath).size / 1024 / 1024).toFixed(2);
  console.log(`Size: ${sizeMB} MB`);
  if (DRY_RUN) console.log('** DRY RUN — no Firestore writes **');

  const { manifest, poNames } = await streamParse(filePath);
  const numChunks = Math.ceil(manifest.size / CHUNK_SIZE);
  console.log(`numChunks=${numChunks}, chunkSize=${CHUNK_SIZE}`);

  console.log('Bucketing into chunks…');
  const tBucket = Date.now();
  const { chunks, poCounts } = bucketize(manifest, numChunks);
  console.log(`Bucketing done in ${((Date.now() - tBucket) / 1000).toFixed(1)}s`);

  // Auto-assign colors.
  const poColors = {};
  poNames.forEach((p, i) => { poColors[p] = DEFAULT_COLORS[i % DEFAULT_COLORS.length]; });

  if (DRY_RUN) {
    console.log('PO counts:', poCounts);
    console.log('First 3 chunk IDs:', chunks.slice(0, 3).map((c, i) => c ? `c${String(i).padStart(5, '0')} (${Object.keys(c).length} ISBNs)` : null));
    return;
  }

  // Init Firestore.
  const app = initializeApp({
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID,
  });
  const db = getFirestore(app);

  const uploadId = idArg || `po_${Date.now()}`;
  const parentPath = `po-uploads/${uploadId}`;
  console.log(`Writing parent doc: ${parentPath}`);

  await setDoc(doc(db, 'po-uploads', uploadId), {
    poNames,
    isbnCount: manifest.size,
    poColors,
    uploadedAt: serverTimestamp(),
    status: 'pending',
    jobId: null,
  });

  console.log(`Writing ${numChunks} manifest chunks (parallel=${PARALLEL})…`);
  const writtenChunks = await writeAllChunks(db, parentPath, chunks);

  console.log('Updating parent with manifestMeta…');
  await updateDoc(doc(db, 'po-uploads', uploadId), {
    manifestMeta: {
      chunked: true,
      totalIsbns: manifest.size,
      numChunks,
      chunkSize: CHUNK_SIZE,
      poCounts,
    },
  });

  console.log(`\n✅ DONE`);
  console.log(`  uploadId    : ${uploadId}`);
  console.log(`  isbnCount   : ${manifest.size.toLocaleString()}`);
  console.log(`  POs         : ${poNames.length}`);
  console.log(`  numChunks   : ${numChunks}`);
  console.log(`  chunks set  : ${writtenChunks}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
