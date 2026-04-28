/**
 * Chunked manifest storage for scalability.
 * Instead of 1 Firestore doc per ISBN (fails at millions of ISBNs),
 * stores ISBNs in chunk documents of ~5000 each using hash-based distribution.
 *
 * 8.6M ISBNs → ~1,738 chunk docs → ~35 batch writes (vs 21,700 previously).
 */
import { db } from '../firebase';
import { collection, doc, getDoc, getDocs, writeBatch } from 'firebase/firestore';

export const CHUNK_SIZE = 5000;
const WRITE_BATCH = 50; // chunk docs per Firestore batch (conservative for large map docs)

function hashIsbn(isbn, numChunks) {
  let h = 0;
  for (let i = 0; i < isbn.length; i++) {
    h = (h * 31 + isbn.charCodeAt(i)) | 0;
  }
  return ((h % numChunks) + numChunks) % numChunks;
}

/**
 * Write manifest as chunked documents.
 * @param {string} parentPath - e.g. 'po-uploads/po_123' or 'jobs/job_123'
 * @param {Object} manifest - { isbn: poName, ... }
 * @param {Function} onProgress - (chunksWritten, totalChunks) => void
 * @returns {Object} manifestMeta to store on parent document
 */
export async function writeManifestChunks(parentPath, manifest, onProgress) {
  const entries = Object.entries(manifest);
  if (!entries.length) return { chunked: true, totalIsbns: 0, numChunks: 0, poCounts: {} };

  const numChunks = Math.ceil(entries.length / CHUNK_SIZE);
  const chunks = {};
  const poCounts = {};

  for (const [isbn, po] of entries) {
    const idx = hashIsbn(isbn, numChunks);
    if (!chunks[idx]) chunks[idx] = {};
    chunks[idx][isbn] = po;
    poCounts[po] = (poCounts[po] || 0) + 1;
  }

  const chunkArr = Object.entries(chunks);
  let written = 0;
  for (let i = 0; i < chunkArr.length; i += WRITE_BATCH) {
    const batch = writeBatch(db);
    const slice = chunkArr.slice(i, i + WRITE_BATCH);
    for (const [idx, isbns] of slice) {
      batch.set(doc(db, parentPath, 'manifest-chunks', `c${String(idx).padStart(5, '0')}`), { isbns });
    }
    await batch.commit();
    written += slice.length;
    if (onProgress) onProgress(written, chunkArr.length);
  }

  return { chunked: true, totalIsbns: entries.length, numChunks, chunkSize: CHUNK_SIZE, poCounts };
}

// ── Chunk cache for per-ISBN lookups during scanning ──
const _cache = new Map();
const CACHE_MAX = 200;

export function clearChunkCache() { _cache.clear(); }

/**
 * Look up a single ISBN. Fetches only the relevant chunk doc (cached).
 * ~50ms first hit per chunk, instant thereafter.
 */
export async function lookupIsbn(parentPath, isbn, numChunks) {
  const idx = hashIsbn(isbn, numChunks);
  const chunkId = `c${String(idx).padStart(5, '0')}`;
  const key = `${parentPath}/${chunkId}`;

  if (_cache.has(key)) return _cache.get(key)[isbn] || null;

  const snap = await getDoc(doc(db, parentPath, 'manifest-chunks', chunkId));
  if (!snap.exists()) return null;

  const isbns = snap.data().isbns || {};
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, isbns);
  return isbns[isbn] || null;
}

/**
 * Copy all manifest chunks from one parent path to another.
 * Used when adding a PO upload to a job.
 */
export async function copyManifestChunks(sourcePath, destPath, onProgress) {
  const snap = await getDocs(collection(db, sourcePath, 'manifest-chunks'));
  const docs = snap.docs;
  let written = 0;
  for (let i = 0; i < docs.length; i += WRITE_BATCH) {
    const batch = writeBatch(db);
    const slice = docs.slice(i, i + WRITE_BATCH);
    slice.forEach((d) => {
      batch.set(doc(db, destPath, 'manifest-chunks', d.id), d.data());
    });
    await batch.commit();
    written += slice.length;
    if (onProgress) onProgress(written, docs.length);
  }
  return written;
}

/**
 * Delete all manifest chunks under a parent path.
 */
export async function deleteManifestChunks(parentPath) {
  const snap = await getDocs(collection(db, parentPath, 'manifest-chunks'));
  if (snap.empty) return 0;
  let count = 0;
  let batch = writeBatch(db);
  for (const d of snap.docs) {
    batch.delete(d.ref);
    count++;
    if (count % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
  }
  if (count % 400 !== 0) await batch.commit();
  return count;
}

/**
 * Read a preview of the first chunk (for Setup page manifest preview).
 */
export async function readChunkPreview(parentPath, maxEntries = 50) {
  const snap = await getDoc(doc(db, parentPath, 'manifest-chunks', 'c00000'));
  if (!snap.exists()) return [];
  const isbns = snap.data().isbns || {};
  return Object.entries(isbns).slice(0, maxEntries);
}
