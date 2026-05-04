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
  // Manifest may live under jobs/{jobId} OR be referenced via manifestSource
  // (e.g. po-uploads/{uploadId}). Always honor manifestSource if present.
  const manifestBase = job.manifestSource || `jobs/${jobId}`;

  log(`buildIndex(${jobId}): reading ${numChunks} chunks from ${manifestBase}`);
  const t0 = Date.now();

  // Memory-efficient build:
  //  - PO strings interned (only ~tens of distinct values across millions of rows).
  //  - Tokens converted to numeric IDs during the read pass to avoid holding
  //    millions of growing JS arrays in memory simultaneously.
  //  - Two-pass posting build: first count occurrences, then allocate a
  //    Uint32Array per token of the exact size needed and fill via cursors.
  //  - `norms[]` is NOT retained: similarity() re-normalizes both sides.
  const PAR = 32;
  const isbns = [];
  const titles = [];
  const poStrings = []; // interned PO list
  const poIndex = new Map(); // PO string -> integer id
  const poIds = []; // rowIdx -> integer id into poStrings (one byte each via array)

  // Token id assignment + per-row token-id lists (transient; freed after pass 2)
  const tokenIds = new Map(); // token -> integer id
  const tokenCounts = []; // tokenId -> total occurrences
  const rowTokens = []; // rowIdx -> Uint32Array of unique tokenIds for that row

  for (let start = 0; start < numChunks; start += PAR) {
    const end = Math.min(start + PAR, numChunks);
    const reads = [];
    for (let i = start; i < end; i++) {
      const id = `c${String(i).padStart(5, '0')}`;
      reads.push(db.doc(`${manifestBase}/manifest-chunks/${id}`).get());
    }
    const snaps = await Promise.all(reads);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const obj = snap.data().isbns || {};
      for (const isbn in obj) {
        const raw = obj[isbn];
        const poStr = (typeof raw === 'string') ? raw : (raw && raw.p) || '';
        const title = (typeof raw === 'object' && raw && raw.t) ? raw.t : '';
        if (!poStr || !title) continue;
        const norm = normalizeTitle(title);
        if (!norm) continue;

        // Tokenize and assign IDs (deduped per row)
        const parts = norm.split(' ');
        const seen = new Set();
        const ids = [];
        for (let k = 0; k < parts.length; k++) {
          const p = parts[k];
          if (!p || p.length < 2 || STOPWORDS.has(p) || seen.has(p)) continue;
          seen.add(p);
          let id = tokenIds.get(p);
          if (id === undefined) {
            id = tokenCounts.length;
            tokenIds.set(p, id);
            tokenCounts.push(0);
          }
          tokenCounts[id]++;
          ids.push(id);
        }
        if (!ids.length) continue;

        // Intern PO
        let pid = poIndex.get(poStr);
        if (pid === undefined) {
          pid = poStrings.length;
          poIndex.set(poStr, pid);
          poStrings.push(poStr);
        }

        isbns.push(isbn);
        titles.push(title);
        poIds.push(pid);
        rowTokens.push(Uint32Array.from(ids));
      }
    }
    if ((end / PAR) % 8 === 0) {
      log(`  chunks ${end}/${numChunks}  rows=${isbns.length}  tokens=${tokenCounts.length}`);
    }
  }

  log(`  loaded ${isbns.length} titled rows, ${tokenCounts.length} unique tokens, ${poStrings.length} POs in ${Math.round((Date.now() - t0) / 1000)}s — allocating postings…`);

  // Pass 2: allocate per-token Uint32Array of exact size, fill via cursors
  const numTokens = tokenCounts.length;
  const postings = new Array(numTokens);
  for (let i = 0; i < numTokens; i++) postings[i] = new Uint32Array(tokenCounts[i]);
  const cursors = new Uint32Array(numTokens);
  for (let r = 0; r < rowTokens.length; r++) {
    const rt = rowTokens[r];
    for (let k = 0; k < rt.length; k++) {
      const tid = rt[k];
      postings[tid][cursors[tid]++] = r;
    }
  }
  // Drop transient per-row token lists so V8 can GC ~360MB
  rowTokens.length = 0;

  const tokenIdx = new Map();
  for (const [tok, id] of tokenIds) tokenIdx.set(tok, postings[id]);

  log(`  built tokenIdx with ${tokenIdx.size} unique tokens in ${Math.round((Date.now() - t0) / 1000)}s total`);

  evictIfNeeded();
  const ix = {
    isbns,
    titles,
    poStrings,
    poIds,
    tokenIdx,
    loadedAt: Date.now(),
    totalRows: isbns.length,
  };
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
        po: ix.poStrings[ix.poIds[s.r]],
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
