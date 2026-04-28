/**
 * Performance metric helpers.
 */

/**
 * Calculate scans per hour from recent scan timestamps.
 * @param {Array} scans - Array of items with .time (Date) field
 * @param {number} windowMs - Time window for rate calculation
 * @returns {number} Scans per hour (rounded)
 */
export function calculatePace(scans, windowMs = 5 * 60 * 1000) {
  if (!scans || scans.length === 0) return 0;
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = scans.filter((s) => {
    const t = s.time?.getTime?.() ?? s.time ?? 0;
    return t >= cutoff;
  });
  if (recent.length === 0) return 0;
  const oldestT = Math.min(...recent.map((s) => s.time?.getTime?.() ?? s.time ?? now));
  const elapsedMin = Math.max(1, (now - oldestT) / 60000);
  return Math.round((recent.length / elapsedMin) * 60);
}
