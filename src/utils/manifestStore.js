/**
 * Chunked manifest storage for scalability.
 * Instead of 1 Firestore doc per ISBN (fails at millions of ISBNs),
 * stores ISBNs in chunk documents of ~5000 each using hash-based distribution.
 *
 * 8.6M ISBNs → ~1,738 chunk docs → ~35 batch writes (vs 21,700 previously).
 *
 * Chunk value format:
 *   - Legacy:  isbns[isbn] = poName (string)
 *   - Current: isbns[isbn] = { p: poName, t: title } (titles enable AI cover
 *              fuzzy-matching). Both formats are read transparently.
 */
import { db } from '../firebase';
import { collection, doc, getDoc, getDocs, writeBatch, setDoc, query, orderBy, limit, startAfter } from 'firebase/firestore';
import { isbnAlternates } from './isbn';

export const CHUNK_SIZE = 5000;
const WRITE_BATCH = 50; // chunk docs per Firestore batch (conservative for large map docs)
const COPY_PAGE = 50; // chunk docs to read+write at a time during copy (limits memory)
const COPY_WRITE_PAR = 10; // parallel single-doc writes during copy (avoids batch payload limit on chunks with titles)

function hashIsbn(isbn, numChunks) {
  let h = 0;
  for (let i = 0; i < isbn.length; i++) {
    h = (h * 31 + isbn.charCodeAt(i)) | 0;
  }
  return ((h % numChunks) + numChunks) % numChunks;
}

// ── Helpers ──
export function getPoFromEntry(entry) {
  if (entry == null) return null;
  return typeof entry === 'string' ? entry : (entry.p || null);
}
export function getTitleFromEntry(entry) {
  if (entry == null) return null;
  return typeof entry === 'string' ? null : (entry.t || null);
}

/**
 * Write manifest as chunked documents.
 * @param {string} parentPath - e.g. 'po-uploads/po_123' or 'jobs/job_123'
 * @param {Object} manifest - { isbn: poName, ... }  OR  { isbn: { po, title }, ... }
 * @param {Function} onProgress - (chunksWritten, totalChunks) => void
 * @returns {Object} manifestMeta to store on parent document
 */
export async function writeManifestChunks(parentPath, manifest, onProgress) {
  const entries = Object.entries(manifest);
  if (!entries.length) return { chunked: true, totalIsbns: 0, numChunks: 0, poCounts: {}, hasTitles: false };

  const numChunks = Math.ceil(entries.length / CHUNK_SIZE);
  const chunks = {};
  const poCounts = {};
  let hasTitles = false;

  for (const [isbn, raw] of entries) {
    const po = typeof raw === 'string' ? raw : raw?.po;
    const title = typeof raw === 'string' ? null : (raw?.title || null);
    if (!po) continue;
    if (title) hasTitles = true;
    const idx = hashIsbn(isbn, numChunks);
    if (!chunks[idx]) chunks[idx] = {};
    chunks[idx][isbn] = title ? { p: po, t: title } : po;
    poCounts[po] = (poCounts[po] || 0) + 1;
  }

  const chunkArr = Object.entries(chunks);
  let written = 0;
  // Single-doc writes with bounded concurrency: avoids the ~11MB Firestore batch
  // payload limit when chunks contain titles (~500KB each).
  for (let i = 0; i < chunkArr.length; i += COPY_WRITE_PAR) {
    const slice = chunkArr.slice(i, i + COPY_WRITE_PAR);
    await Promise.all(slice.map(([idx, isbns]) =>
      setDoc(doc(db, parentPath, 'manifest-chunks', `c${String(idx).padStart(5, '0')}`), { isbns })
    ));
    written += slice.length;
    if (onProgress) onProgress(written, chunkArr.length);
  }

  return { chunked: true, totalIsbns: entries.length, numChunks, chunkSize: CHUNK_SIZE, poCounts, hasTitles };
}

// ── Chunk cache for per-ISBN lookups during scanning ──
const _cache = new Map();
const CACHE_MAX = 500; // ~2.5M ISBNs cached at 5000/chunk — keeps miss rate low for 1700+ chunk jobs

export function clearChunkCache() { _cache.clear(); }

/**
 * Look up a single ISBN. Fetches only the relevant chunk doc (cached).
 * ~50ms first hit per chunk, instant thereafter.
 * Returns the PO name string (works with both legacy and current chunk formats).
 *
 * On a miss, automatically retries with the ISBN-10/13 alternate form so
 * customers get the right PO regardless of which barcode the manifest
 * happened to list. This is safe: ISBN-10 ↔ ISBN-13 (978-prefix) is a
 * lossless 1:1 mapping for the same physical book.
 */
export async function lookupIsbn(parentPath, isbn, numChunks) {
  const direct = await _lookupIsbnRaw(parentPath, isbn, numChunks);
  if (direct) return direct;
  const { isbn13, isbn10 } = isbnAlternates(isbn);
  const alt = isbn === isbn13 ? isbn10 : isbn13;
  if (!alt || alt === isbn) return null;
  return _lookupIsbnRaw(parentPath, alt, numChunks);
}

async function _lookupIsbnRaw(parentPath, isbn, numChunks) {
  const idx = hashIsbn(isbn, numChunks);
  const chunkId = `c${String(idx).padStart(5, '0')}`;
  const key = `${parentPath}/${chunkId}`;

  if (_cache.has(key)) return getPoFromEntry(_cache.get(key)[isbn]);

  const snap = await getDoc(doc(db, parentPath, 'manifest-chunks', chunkId));
  if (!snap.exists()) return null;

  const isbns = snap.data().isbns || {};
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, isbns);
  return getPoFromEntry(isbns[isbn]);
}

/**
 * Load every chunk under parentPath, returning a flat title-index for
 * AI cover→ISBN fuzzy matching. Caller decides when to invoke (typically
 * when the operator first opens the AI camera flow). Cached per-parentPath.
 *
 * Returns: [{ isbn, po, title }] (entries with a title only — ISBN-only
 * legacy entries are skipped since there's nothing to fuzzy-match against).
 */
const _titleIndexCache = new Map();
export async function loadTitleIndex(parentPath, numChunks, onProgress) {
  if (_titleIndexCache.has(parentPath)) return _titleIndexCache.get(parentPath);
  const out = [];
  const PAR = 8;
  const total = numChunks || 0;
  let done = 0;
  for (let start = 0; start < total; start += PAR) {
    const end = Math.min(start + PAR, total);
    const reads = [];
    for (let i = start; i < end; i++) {
      reads.push(getDoc(doc(db, parentPath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`)));
    }
    const snaps = await Promise.all(reads);
    for (const snap of snaps) {
      if (!snap.exists()) continue;
      const isbns = snap.data().isbns || {};
      // Also warm the per-ISBN cache to avoid double-reads later
      const cacheKey = `${parentPath}/${snap.id}`;
      if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
      _cache.set(cacheKey, isbns);
      for (const [isbn, raw] of Object.entries(isbns)) {
        const po = getPoFromEntry(raw);
        const title = getTitleFromEntry(raw);
        if (po && title) out.push({ isbn, po, title });
      }
    }
    done = end;
    if (onProgress) onProgress(done, total);
  }
  _titleIndexCache.set(parentPath, out);
  return out;
}

export function clearTitleIndexCache(parentPath) {
  if (parentPath) _titleIndexCache.delete(parentPath);
  else _titleIndexCache.clear();
}

/**
 * In-place backfill of ISBN-10/13 siblings across already-stored chunks.
 *
 * Walks every chunk under parentPath, and for each entry with a title (or
 * even an entry with only a PO + missing sibling), writes the alternate
 * ISBN form into the appropriate sibling chunk. Used to retro-apply the
 * sibling-pairing fix to manifests uploaded before that change shipped.
 *
 * Strategy:
 *   1. Read all chunks (parallel pages of 8).
 *   2. Build a flat in-memory map { isbn -> { p, t } } and decide additions.
 *   3. Group additions by destination chunk index (hash on isbn).
 *   4. Write modified chunks back in batches.
 *
 * Safe to run multiple times — existing entries are never overwritten.
 *
 * @returns { read, added, chunksTouched, hadTitlesBefore, hasTitlesAfter }
 */
export async function backfillManifestChunks(parentPath, numChunks, onProgress) {
  if (!numChunks) throw new Error('backfillManifestChunks requires numChunks');
  // Lazy import to avoid pulling isbn helper into hot scan path
  const { isbnAlternates } = await import('./isbn');

  // 1. Read all chunks
  const chunkData = new Map(); // idx -> { id, isbns }
  let hadTitlesBefore = false;
  const PAR = 8;
  for (let start = 0; start < numChunks; start += PAR) {
    const end = Math.min(start + PAR, numChunks);
    const reads = [];
    for (let i = start; i < end; i++) {
      reads.push(getDoc(doc(db, parentPath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`)));
    }
    const snaps = await Promise.all(reads);
    snaps.forEach((snap, k) => {
      const idx = start + k;
      if (snap.exists()) {
        const isbns = snap.data().isbns || {};
        chunkData.set(idx, { id: snap.id, isbns });
        if (!hadTitlesBefore) {
          for (const v of Object.values(isbns)) {
            if (v && typeof v === 'object' && v.t) { hadTitlesBefore = true; break; }
          }
        }
      }
    });
    if (onProgress) onProgress({ phase: 'reading', done: end, total: numChunks });
  }

  // 2. Decide additions. Keyed by destination chunk idx.
  const additions = new Map(); // destIdx -> { siblingIsbn -> { p, t? } }
  let read = 0;
  let added = 0;
  for (const { isbns } of chunkData.values()) {
    for (const [isbn, raw] of Object.entries(isbns)) {
      read++;
      const po = typeof raw === 'string' ? raw : raw?.p;
      const title = typeof raw === 'string' ? null : (raw?.t || null);
      if (!po) continue;
      const { isbn13, isbn10 } = isbnAlternates(isbn);
      const sibling = isbn === isbn13 ? isbn10 : isbn13;
      if (!sibling || sibling === isbn) continue;
      // Where would the sibling live?
      const sibIdx = hashIsbn(sibling, numChunks);
      const sibChunk = chunkData.get(sibIdx);
      const existingInChunk = sibChunk?.isbns?.[sibling];
      const existingInAdditions = additions.get(sibIdx)?.[sibling];
      const existing = existingInAdditions ?? existingInChunk;
      if (existing == null) {
        // Sibling missing entirely — synthesize
        if (!additions.has(sibIdx)) additions.set(sibIdx, {});
        additions.get(sibIdx)[sibling] = title ? { p: po, t: title } : po;
        added++;
      } else if (title) {
        // Sibling exists; backfill title only if it lacks one
        const existingTitle = typeof existing === 'string' ? null : existing.t;
        const existingPo = typeof existing === 'string' ? existing : existing.p;
        if (!existingTitle && existingPo) {
          if (!additions.has(sibIdx)) additions.set(sibIdx, {});
          additions.get(sibIdx)[sibling] = { p: existingPo, t: title };
          added++;
        }
      }
    }
  }

  // 3. Write back. Merge additions into the existing chunk's isbns map.
  const dirtyIdxs = [...additions.keys()];
  let written = 0;
  for (let i = 0; i < dirtyIdxs.length; i += COPY_WRITE_PAR) {
    const slice = dirtyIdxs.slice(i, i + COPY_WRITE_PAR);
    await Promise.all(slice.map((idx) => {
      const existing = chunkData.get(idx)?.isbns || {};
      const merged = { ...existing, ...additions.get(idx) };
      const chunkId = chunkData.get(idx)?.id || `c${String(idx).padStart(5, '0')}`;
      return setDoc(doc(db, parentPath, 'manifest-chunks', chunkId), { isbns: merged });
    }));
    written += slice.length;
    if (onProgress) onProgress({ phase: 'writing', done: written, total: dirtyIdxs.length });
  }

  // Invalidate caches so callers see the new data
  clearChunkCache();
  clearTitleIndexCache(parentPath);

  return {
    read,
    added,
    chunksTouched: dirtyIdxs.length,
    hadTitlesBefore,
    hasTitlesAfter: hadTitlesBefore || added > 0,
  };
}

/**
 * Copy manifest chunks from source to dest in pages (avoids loading all into memory).
 * If numChunks is provided, copies by known IDs (cheapest). Otherwise falls back to paginated query.
 */
export async function copyManifestChunks(sourcePath, destPath, onProgress, numChunks) {
  let written = 0;

  // Helper: write an array of {id, data} entries via parallel single-doc setDoc.
  // Avoids the ~11MB Firestore batch payload limit triggered by chunks containing titles.
  async function writeAllSingle(entries) {
    for (let i = 0; i < entries.length; i += COPY_WRITE_PAR) {
      const slice = entries.slice(i, i + COPY_WRITE_PAR);
      await Promise.all(slice.map(({ id, data }) =>
        setDoc(doc(db, destPath, 'manifest-chunks', id), data)
      ));
    }
  }

  if (numChunks) {
    // Read + write in small pages by known chunk IDs (no collection scan needed).
    // Reads can be batched cheaply; writes are issued one-doc-at-a-time with concurrency
    // because each chunk doc with embedded titles can be ~500KB.
    for (let start = 0; start < numChunks; start += COPY_PAGE) {
      const end = Math.min(start + COPY_PAGE, numChunks);
      const reads = [];
      for (let i = start; i < end; i++) {
        reads.push(getDoc(doc(db, sourcePath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`)));
      }
      const snaps = await Promise.all(reads);
      const entries = [];
      for (const snap of snaps) {
        if (snap.exists()) entries.push({ id: snap.id, data: snap.data() });
      }
      await writeAllSingle(entries);
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
      const entries = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      await writeAllSingle(entries);
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
  return Object.entries(isbns).slice(0, maxEntries).map(([isbn, raw]) => [isbn, getPoFromEntry(raw), getTitleFromEntry(raw)]);
}
