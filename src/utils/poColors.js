// Single source of truth for PO -> color across /pack and /pallet so the
// colors chosen at Setup (job.poColors) drive both stations identically. When
// a PO has no Setup color, a stable fallback palette keeps it consistent
// everywhere (same PO always maps to the same fallback hue).
export const FALLBACK_PO_COLORS = ['#4d7cff', '#f5a524', '#2fbf71', '#a855f7', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

function hashIdx(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % FALLBACK_PO_COLORS.length;
}

/** Build a (poName) -> hex color resolver for a job. Setup colors win. */
export function makePoColorFor(job) {
  const colors = (job && job.poColors) || {};
  return (po) => colors[po] || FALLBACK_PO_COLORS[hashIdx(po)];
}
