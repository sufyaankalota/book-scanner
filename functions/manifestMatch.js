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

  // Pass 2: allocate per-token Uint32Array of exact size, fill via cursors.
  // Also build per-row token-count array (for Jaccard prefilter) and norms cache.
  const numTokens = tokenCounts.length;
  const postings = new Array(numTokens);
  for (let i = 0; i < numTokens; i++) postings[i] = new Uint32Array(tokenCounts[i]);
  const cursors = new Uint32Array(numTokens);
  const rowTokenCount = new Uint16Array(rowTokens.length); // for Jaccard
  const norms = new Array(rowTokens.length);
  for (let r = 0; r < rowTokens.length; r++) {
    const rt = rowTokens[r];
    rowTokenCount[r] = rt.length;
    norms[r] = normalizeTitle(titles[r]);
    for (let k = 0; k < rt.length; k++) {
      const tid = rt[k];
      postings[tid][cursors[tid]++] = r;
    }
  }
  // Drop transient per-row token lists so V8 can GC ~360MB
  rowTokens.length = 0;

  const tokenIdx = new Map();
  for (const [tok, id] of tokenIds) tokenIdx.set(tok, postings[id]);

  // Build a 3-char prefix index so partial cover reads (e.g. "gat") can
  // expand into all index tokens that start with that prefix ("gatsby",
  // "gateway"). Memory cost: ~1–2 MB for 100k+ tokens. Skipped for tokens
  // shorter than 3 chars (mostly stopword leftovers).
  const prefixIdx = new Map(); // 3-char prefix -> array of full token strings
  for (const tok of tokenIdx.keys()) {
    if (tok.length < 3) continue;
    const p = tok.slice(0, 3);
    let arr = prefixIdx.get(p);
    if (!arr) { arr = []; prefixIdx.set(p, arr); }
    arr.push(tok);
  }

  log(`  built tokenIdx with ${tokenIdx.size} unique tokens in ${Math.round((Date.now() - t0) / 1000)}s total`);

  evictIfNeeded();
  const ix = {
    isbns,
    titles,
    norms,
    rowTokenCount,
    poStrings,
    poIds,
    tokenIdx,
    prefixIdx,
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
// Two-stage:
//   1. Inverted-index scan tallies query-token hits per row.
//   2. Cheap Jaccard score using cached rowTokenCount picks the top-N candidates.
//   3. Expensive similarity() runs only on those N (default 200).
function searchOne(ix, query, { topK = 5, minScore = 0.5, prefilterN = 200, maxCandidates = 50000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const qTokens = makeTokens(q).filter((t) => t.length >= 2);
  if (!qTokens.length) return [];

  // Expand short tokens (3–5 chars) via the prefix index so partial cover
  // reads ("gat" → "gatsby", "gateway") still land on candidate rows. Cap
  // expansion per token to avoid blowing up the candidate set on common
  // prefixes (e.g. "the" or "pro").
  const PREFIX_EXPAND_MAX = 25;
  const expandedTokens = new Set(qTokens);
  if (ix.prefixIdx) {
    for (const t of qTokens) {
      if (t.length < 3 || t.length > 5) continue;
      const bucket = ix.prefixIdx.get(t.slice(0, 3));
      if (!bucket) continue;
      // Prefer tokens that actually start with the full query token (length≥4)
      // or are exact-prefix matches; cap by alphabetical to keep deterministic.
      const matches = [];
      for (const tok of bucket) {
        if (tok === t || tok.startsWith(t)) matches.push(tok);
        if (matches.length >= PREFIX_EXPAND_MAX) break;
      }
      for (const m of matches) expandedTokens.add(m);
    }
  }
  const qTokenSetSize = qTokens.length; // use original token count for Jaccard denom

  // Stage 1: tally hits per row from postings (over expanded token set)
  const candidateCounts = new Map();
  for (const tok of expandedTokens) {
    const arr = ix.tokenIdx.get(tok);
    if (!arr) continue;
    for (let k = 0; k < arr.length; k++) {
      const r = arr[k];
      candidateCounts.set(r, (candidateCounts.get(r) || 0) + 1);
    }
  }
  if (!candidateCounts.size) return [];

  // Stage 2: Jaccard prefilter. score = hits / (qTokens + rowTokens - hits)
  // Pick top prefilterN candidates by Jaccard before doing expensive sim().
  const rtc = ix.rowTokenCount;
  let bestRows;
  let jaccardByRow = null;
  if (candidateCounts.size <= prefilterN) {
    bestRows = Array.from(candidateCounts.keys());
    jaccardByRow = new Map();
    for (const r of bestRows) {
      const c = candidateCounts.get(r);
      const denom = qTokenSetSize + rtc[r] - c;
      jaccardByRow.set(r, denom > 0 ? c / denom : 0);
    }
  } else {
    // If candidate set is huge, first cap by raw hit count to keep Jaccard pass cheap
    let entries;
    if (candidateCounts.size > maxCandidates) {
      const all = Array.from(candidateCounts.entries());
      all.sort((a, b) => b[1] - a[1]); // sort by hits desc
      entries = all.slice(0, maxCandidates);
    } else {
      entries = Array.from(candidateCounts.entries());
    }
    // Compute Jaccard for each, pick top prefilterN
    const scored = entries.map(([r, c]) => {
      const denom = qTokenSetSize + rtc[r] - c;
      return [r, denom > 0 ? c / denom : 0];
    });
    scored.sort((a, b) => b[1] - a[1]);
    bestRows = scored.slice(0, prefilterN).map((e) => e[0]);
    jaccardByRow = new Map(scored.slice(0, prefilterN));
  }

  // Stage 3: full similarity on the prefiltered set, using cached norms
  const passing = [];
  const all = []; // every prefiltered row with its sim score (for top-up)
  for (const r of bestRows) {
    const sim = similarity(q, ix.norms[r] || ix.titles[r]);
    all.push({ r, score: sim, jaccard: jaccardByRow.get(r) || 0 });
    if (sim >= minScore) passing.push({ r, score: sim });
  }
  passing.sort((a, b) => b.score - a.score);

  // Top-up: if we have fewer than topK strong matches, fill with the highest
  // Jaccard rows from the prefilter (using max(sim, jaccard*0.7) as a soft
  // confidence so the picker can still display them — operator decides).
  let picked = passing;
  if (passing.length < topK) {
    const seenRow = new Set(passing.map((p) => p.r));
    const fillers = all
      .filter((x) => !seenRow.has(x.r))
      .map((x) => ({ r: x.r, score: Math.max(x.score, x.jaccard * 0.7) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK - passing.length);
    picked = passing.concat(fillers);
  }

  // Dedupe by canonical ISBN-13 — keep highest-scoring representative
  const seen = new Map();
  for (const s of picked) {
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
