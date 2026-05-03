/**
 * Server-side fuzzy title matcher for AI cover→ISBN flow.
 *
 * For very large manifests (millions of titles) we cannot afford to ship the
 * full title-index to the browser nor to fuzzy-score every entry per query.
 * This module:
 *   1. Lazily loads all manifest-chunks for a job into compact arrays
 *      (parallel reads with backoff, single-flight per jobId).
 *   2. Builds a token inverted index so each query only scores rows that
 *      share at least one non-stopword token with the query.
 *   3. Caches both in module-level memory; minInstances:1 keeps the warm.
 *   4. Returns top-K candidates with scores; client decides confident vs ambiguous.
 *
 * Memory note: for a 9M-row manifest expect ~2.5–3.5 GB heap. Deploy with
 * memory: '4GiB'.
 */
const { getFirestore } = require('firebase-admin/firestore');
const { normalizeTitle, similarity, canonicalIsbn13, STOPWORDS } = require('./fuzzy');

// ─── Module-level cache ───
// indexes: Map<jobId, { isbns: string[], pos: string[], titles: string[],
//                       norms: string[], tokenIdx: Map<string, Uint32Array>,
//                       loadedAt: number, totalRows: number }>
const indexes = new Map();
const inFlight = new Map(); // jobId -> Promise<index>
const MAX_CACHED_JOBS = 2; // keep at most 2 jobs warm to control memory

function makeTokens(s) {
  return normalizeTitle(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

function evictIfNeeded() {
  if (indexes.size < MAX_CACHED_JOBS) return;
  // Evict least-recently-loaded
  let oldestId = null, oldestAt = Infinity;
  for (const [id, ix] of indexes) if (ix.loadedAt < oldestAt) { oldestAt = ix.loadedAt; oldestId = id; }
  if (oldestId) indexes.delete(oldestId);
}

async function buildIndex(jobId, opts = {}) {
  const log = opts.log || (() => {});
  const db = getFirestore();
  const jobSnap = await db.doc(`jobs/${jobId}`).get();
  const job = jobSnap.exists ? jobSnap.data() : null;
  if (!job) throw new Error(`job ${jobId} not found`);
  const numChunks = job?.manifestMeta?.numChunks || 0;
  if (!numChunks) throw new Error(`job ${jobId} has no chunked manifest`);

  log(`buildIndex(${jobId}): reading ${numChunks} chunks`);
  const t0 = Date.now();

  // Read chunks in parallel batches
  const PAR = 32;
  const isbns = [];
  const pos = [];
  const titles = [];
  const norms = [];
  for (let start = 0; start < numChunks; start += PAR) {
    const end = Math.min(start + PAR, numChunks);
    const reads = [];
    for (let i = start; i < end; i++) {
      const id = `c${String(i).padStart(5, '0')}`;
      reads.push(db.doc(`jobs/${jobId}/manifest-chunks/${id}`).get());
    }
    const snaps = await Promise.all(reads);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const obj = snap.data().isbns || {};
      for (const isbn in obj) {
        const raw = obj[isbn];
        const po = (typeof raw === 'string') ? raw : (raw && raw.p) || '';
        const title = (typeof raw === 'object' && raw && raw.t) ? raw.t : '';
        if (!po || !title) continue;
        const norm = normalizeTitle(title);
        if (!norm) continue;
        isbns.push(isbn);
        pos.push(po);
        titles.push(title);
        norms.push(norm);
      }
    }
    if ((end / PAR) % 8 === 0) log(`  chunks ${end}/${numChunks}  rows=${isbns.length}`);
  }

  log(`  loaded ${isbns.length} titled rows in ${Math.round((Date.now() - t0) / 1000)}s — building token index…`);

  // Build inverted token index. Use plain arrays then convert to Uint32Array
  // at the end to halve memory.
  const tmp = new Map(); // token → number[]
  for (let i = 0; i < norms.length; i++) {
    const seen = new Set();
    const parts = norms[i].split(' ');
    for (const p of parts) {
      if (!p || STOPWORDS.has(p) || p.length < 2) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      let arr = tmp.get(p);
      if (!arr) { arr = []; tmp.set(p, arr); }
      arr.push(i);
    }
  }
  const tokenIdx = new Map();
  for (const [tok, arr] of tmp) tokenIdx.set(tok, Uint32Array.from(arr));

  log(`  built tokenIdx with ${tokenIdx.size} unique tokens in ${Math.round((Date.now() - t0) / 1000)}s total`);

  evictIfNeeded();
  const ix = { isbns, pos, titles, norms, tokenIdx, loadedAt: Date.now(), totalRows: isbns.length };
  indexes.set(jobId, ix);
  return ix;
}

async function getIndex(jobId, opts) {
  const cached = indexes.get(jobId);
  if (cached) return cached;
  if (inFlight.has(jobId)) return inFlight.get(jobId);
  const p = buildIndex(jobId, opts).finally(() => inFlight.delete(jobId));
  inFlight.set(jobId, p);
  return p;
}

// ─── Search ───
function searchOne(ix, query, { topK = 5, minScore = 0.5, maxCandidates = 20000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const qTokens = makeTokens(q).filter((t) => t.length >= 2);
  if (!qTokens.length) return [];

  // Collect candidate row indexes from inverted index (any-token match)
  const candidateCounts = new Map(); // rowIdx → number of query-token hits
  for (const tok of qTokens) {
    const arr = ix.tokenIdx.get(tok);
    if (!arr) continue;
    for (let k = 0; k < arr.length; k++) {
      const r = arr[k];
      candidateCounts.set(r, (candidateCounts.get(r) || 0) + 1);
    }
  }
  if (!candidateCounts.size) return [];

  // If too many candidates, keep only those that match ≥2 query tokens
  // (or fall back to highest-token-overlap subset).
  let candidates;
  if (candidateCounts.size > maxCandidates && qTokens.length >= 2) {
    candidates = [];
    for (const [r, c] of candidateCounts) if (c >= 2) candidates.push(r);
    if (candidates.length > maxCandidates) {
      // Sort by overlap desc and slice
      candidates.sort((a, b) => candidateCounts.get(b) - candidateCounts.get(a));
      candidates = candidates.slice(0, maxCandidates);
    }
  } else {
    candidates = Array.from(candidateCounts.keys());
  }

  // Score with full similarity()
  const scored = [];
  for (const r of candidates) {
    const score = similarity(q, ix.titles[r]);
    if (score >= minScore) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Dedupe by canonical ISBN-13 — keep highest-scoring representative
  const seen = new Map();
  for (const s of scored) {
    const isbn = ix.isbns[s.r];
    const key = canonicalIsbn13(isbn) || isbn;
    const prev = seen.get(key);
    if (!prev || s.score > prev.score) {
      seen.set(key, {
        isbn: canonicalIsbn13(isbn) || isbn,
        po: ix.pos[s.r],
        title: ix.titles[s.r],
        score: s.score,
      });
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Public entry. Tries multiple search variants and returns best top-K across all.
 * @param {string} jobId
 * @param {{title?: string, author?: string, coverText?: string}} q
 * @param {{topK?: number, minScore?: number}} opts
 */
async function findCandidates(jobId, q, opts = {}) {
  const ix = await getIndex(jobId, opts);
  const variants = Array.from(new Set([
    q.title && q.author ? `${q.title} ${q.author}` : '',
    q.coverText || '',
    q.title || '',
    q.author || '',
  ].filter(Boolean)));
  const all = [];
  for (const v of variants) {
    const matches = searchOne(ix, v, opts);
    for (const m of matches) all.push({ ...m, variant: v });
  }
  // Best-per-isbn across variants
  const seen = new Map();
  for (const m of all) {
    const prev = seen.get(m.isbn);
    if (!prev || m.score > prev.score) seen.set(m.isbn, m);
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, opts.topK || 5);
}

function invalidate(jobId) {
  if (jobId) indexes.delete(jobId);
  else indexes.clear();
}

function getStats() {
  const stats = {};
  for (const [id, ix] of indexes) {
    stats[id] = { rows: ix.totalRows, tokens: ix.tokenIdx.size, loadedAt: ix.loadedAt };
  }
  return stats;
}

module.exports = { findCandidates, getIndex, invalidate, getStats };
