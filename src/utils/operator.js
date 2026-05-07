// ─── Operator name normalization ───
// Operators sometimes type their name slightly differently each shift
// ("Maria", "maria", "MARIA ", "Maria ") which would split their volume
// across multiple leaderboard rows. Normalize to a canonical key for
// grouping, and a consistent Title Case form for display.

export function normalizeOperatorKey(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function displayOperatorName(name) {
  const key = normalizeOperatorKey(name);
  if (!key) return '';
  return key
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Group an array of scan/exception records by normalized operator name.
// Returns Array<{ name (display), key, count }>.
export function groupByOperator(records, getName = (r) => r.scannerId) {
  const map = new Map(); // key -> { name, count }
  for (const r of records) {
    const raw = getName(r);
    const key = normalizeOperatorKey(raw);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, { name: displayOperatorName(raw), key, count: 1 });
    }
  }
  return Array.from(map.values());
}
