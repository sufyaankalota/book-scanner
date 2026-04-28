/**
 * Chunked manifest storage for scalability.
 * Instead of 1 Firestore doc per ISBN (fails at millions of ISBNs),
 * stores ISBNs in chunk documents of ~5000 each using hash-based distribution.
 *
 * 8.6M ISBNs → ~1,738 chunk docs → ~35 batch writes (vs 21,700 previously).
 */
import { db } from '../firebase';
import { collection, doc, getDoc, getDocs, writeBatch, query, orderBy, limit, startAfter } from 'firebase/firestore';

export const CHUNK_SIZE = 5000;
const WRITE_BATCH = 50; // chunk docs per Firestore batch (conservative for large map docs)
const COPY_PAGE = 50; // chunk docs to read+write at a time during copy (limits memory)

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
const CACHE_MAX = 500; // ~2.5M ISBNs cached at 5000/chunk — keeps miss rate low for 1700+ chunk jobs

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
 * Copy manifest chunks from source to dest in pages (avoids loading all into memory).
 * If numChunks is provided, copies by known IDs (cheapest). Otherwise falls back to paginated query.
 */
export async function copyManifestChunks(sourcePath, destPath, onProgress, numChunks) {
  let written = 0;

  if (numChunks) {
    // Read + write in small batches by known chunk IDs (no collection scan needed)
    for (let start = 0; start < numChunks; start += COPY_PAGE) {
      const end = Math.min(start + COPY_PAGE, numChunks);
      const reads = [];
      for (let i = start; i < end; i++) {
        reads.push(getDoc(doc(db, sourcePath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`)));
      }
      const snaps = await Promise.all(reads);
      const batch = writeBatch(db);
      for (const snap of snaps) {
        if (snap.exists()) batch.set(doc(db, destPath, 'manifest-chunks', snap.id), snap.data());
      }
      await batch.commit();
      written += end - start;
      if (onProgress) onProgress(written, numChunks);
    }
  } else {
    // Fallback: paginated collection query (for legacy or unknown chunk counts)
    let lastDoc = null;
    while (true) {
      let q = lastDoc
        ? query(collection(db, sourcePath, 'manifest-chunks'), orderBy('__name__'), startAfter(lastDoc), limit(COPY_PAGE))
        : query(collection(db, sourcePath, 'manifest-chunks'), orderBy('__name__'), limit(COPY_PAGE));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.set(doc(db, destPath, 'manifest-chunks', d.id), d.data()));
      await batch.commit();
      written += snap.docs.length;
      if (onProgress) onProgress(written, written); // total unknown in fallback
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < COPY_PAGE) break;
    }
  }
  return written;
}

/**
 * Delete all manifest chunks under a parent path.
 * If numChunks is provided, deletes by known IDs (zero reads — cheapest).
 * Otherwise falls back to reading the collection first.
 */
export async function deleteManifestChunks(parentPath, numChunks) {
  if (numChunks) {
    // Delete by known IDs — no reads required
    let count = 0;
    for (let start = 0; start < numChunks; start += 400) {
      const batch = writeBatch(db);
      const end = Math.min(start + 400, numChunks);
      for (let i = start; i < end; i++) {
        batch.delete(doc(db, parentPath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`));
      }
      await batch.commit();
      count += end - start;
    }
    return count;
  }

  // Fallback: read then delete (for unknown chunk count)
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
