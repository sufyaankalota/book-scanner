/**
 * Server-side title fuzzy matching for AI cover→ISBN lookup.
 * CommonJS port of src/utils/fuzzy.js + src/utils/isbn.js for Cloud Functions.
 *
 * Designed to handle very large manifests (≥9M titles) by maintaining a token
 * inverted index in-memory and only scoring titles that share at least one
 * non-stopword token with the query.
 */

// ─── Normalization ───
function normalizeTitle(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019\u2018\u02BC\u2032`\u00B4\u05F3]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'to', 'for']);

function tokens(s) {
  return normalizeTitle(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

// ─── Levenshtein ───
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

function setContainment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const tokenDice = setDice(ta, tb);
  const tokenContain = setContainment(ta, tb);
  const tokenScore = Math.max(tokenDice, tokenContain * 0.85);

  const maxLen = Math.max(na.length, nb.length);
  const levScore = maxLen === 0 ? 0 : 1 - lev(na, nb) / maxLen;

  const bgScore = setDice(bigrams(na), bigrams(nb));

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  const substrBoost = longer.includes(shorter) ? 0.85 + 0.15 * (shorter.length / longer.length) : 0;

  return Math.max(levScore, tokenScore, bgScore * 0.85, substrBoost);
}

// ─── ISBN validation (subset for ISBN-10 → 13 conversion) ───
function isbn10To13(isbn10) {
  if (!isbn10 || isbn10.length !== 10) return null;
  const core = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}
function canonicalIsbn13(isbn) {
  if (!isbn) return isbn;
  const c = String(isbn).replace(/[-\s]/g, '');
  if (c.length === 10) return isbn10To13(c) || c;
  return c;
}

module.exports = {
  normalizeTitle, tokens, similarity, canonicalIsbn13,
  STOPWORDS,
};
