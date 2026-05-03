/**
 * Title fuzzy matching for AI cover-photo → manifest ISBN lookup.
 *
 * Storage rule: callers must persist the ORIGINAL title exactly as captured
 * (preserving accents, CJK, em-dashes, etc.). The functions here only
 * normalize for *comparison*.
 */

// ─── Normalization ───
// NFKD decomposes accented chars into base + combining marks → strip the marks.
// Result is ASCII-ish, lowercase, punctuation-free. Used only for compare.
export function normalizeTitle(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritic combining marks
    .toLowerCase()
    // Remove apostrophe-like marks WITHOUT inserting a space — so "L'Enfant"
    // collapses to "lenfant" instead of splitting into two tokens. Covers
    // ASCII ', curly ’ ‘, modifier letter apostrophe ʼ, prime ′, backtick `,
    // acute ´, and Hebrew geresh ׳.
    .replace(/['\u2019\u2018\u02BC\u2032`\u00B4\u05F3]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // remaining punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'to', 'for']);

export function tokens(s) {
  return normalizeTitle(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

// ─── Levenshtein (DP, O(n*m)) ───
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ─── Bigram dice coefficient on token sets ───
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function setDice(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// What fraction of the smaller set is contained in the larger?
// Useful for subtitle matches: "Sapiens" inside "Sapiens: A Brief History".
function setContainment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

// ─── Score ───
// 0..1 where 1 is identical. Combines:
//   - normalized 1-Levenshtein over the full normalized strings
//   - token-set dice coefficient (handles word reorder, subtitles, etc.)
//   - bigram dice (resilient to typos / OCR slips)
// Take the MAX, weighted slightly toward token-set when titles are long.
export function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const tokenDice = setDice(ta, tb);
  const tokenContain = setContainment(ta, tb);
  // Heavy penalty if NO tokens overlap at all (avoids false positives between
  // an unrelated short title and a long one that happens to share bigrams).
  const tokenScore = Math.max(tokenDice, tokenContain * 0.85);

  const maxLen = Math.max(na.length, nb.length);
  const levScore = maxLen === 0 ? 0 : 1 - lev(na, nb) / maxLen;

  const bgScore = setDice(bigrams(na), bigrams(nb));

  // If the shorter normalized string is a substring of the longer one, boost.
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  const substrBoost = longer.includes(shorter) ? 0.85 + 0.15 * (shorter.length / longer.length) : 0;

  return Math.max(
    levScore,
    tokenScore,
    bgScore * 0.85,
    substrBoost,
  );
}

// ─── Top-k matching against a title index ───
// index = [{ isbn, po, title, ... }] (extra fields preserved on output)
// Returns up to topK candidates sorted desc by score.
//
// Dedupes by canonical ISBN-13 so an ISBN-10/13 sibling pair (same book,
// same title, two rows in the manifest) doesn't return two near-identical
// candidates. The ISBN-13 form is preferred for downstream display/billing.
import { isbnAlternates } from './isbn';

export function findMatches(query, index, { topK = 3, minScore = 0.5 } = {}) {
  if (!query || !index?.length) return [];
  const out = [];
  for (const row of index) {
    const score = similarity(query, row.title);
    if (score >= minScore) out.push({ ...row, score });
  }
  out.sort((a, b) => b.score - a.score);
  // Dedupe by canonical ISBN-13 (or the raw ISBN if no 13-form), keeping
  // the highest-scoring representative. Prefer ISBN-13 form for output.
  const seen = new Map();
  for (const cand of out) {
    const { isbn13 } = isbnAlternates(cand.isbn);
    const key = isbn13 || cand.isbn;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, isbn13 ? { ...cand, isbn: isbn13 } : cand);
    } else if (cand.score > existing.score) {
      seen.set(key, isbn13 ? { ...cand, isbn: isbn13 } : cand);
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Confidence buckets (tunable) ───
export const MATCH_CONFIDENT = 0.85;   // auto-accept
export const MATCH_AMBIGUOUS = 0.70;   // ask user to pick / confirm
// below 0.70 → no match (treat as exception)

export function classify(score) {
  if (score >= MATCH_CONFIDENT) return 'confident';
  if (score >= MATCH_AMBIGUOUS) return 'ambiguous';
  return 'none';
}
