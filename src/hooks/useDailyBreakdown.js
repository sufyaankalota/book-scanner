import { useEffect, useState } from 'react';
import { isScanEngineConfigured, scanEngine } from '../lib/scanEngine';

/**
 * Polls /api/portal/daily-breakdown for a job's per-day totals split into
 * regular / manual / aiCamera / exceptions buckets. Replaces CustomerPortal's
 * 60-day full-collection Firestore listener that was loading 350K docs and
 * pegging the browser on every new scan write.
 *
 * Returns `null` when scan-engine isn't configured so callers can fall back
 * to the legacy listener; otherwise returns the breakdown array (newest first).
 *
 * @param {string|null} jobId
 * @param {number} days — trailing window. Default 60d (matches old listener).
 * @param {number} pollMs — refresh cadence. Default 30s.
 */
export function useDailyBreakdown(jobId, days = 60, pollMs = 30000) {
  const [breakdown, setBreakdown] = useState(null);

  useEffect(() => {
    if (!isScanEngineConfigured || !jobId) {
      setBreakdown(null);
      return undefined;
    }
    let cancelled = false;
    const fetchOnce = async () => {
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - days);
      start.setHours(0, 0, 0, 0);
      try {
        const { breakdown: rows } = await scanEngine.dailyBreakdown({
          jobId,
          start: start.toISOString(),
          end: end.toISOString(),
        });
        if (!cancelled) setBreakdown(rows || []);
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[useDailyBreakdown] fetch failed', err);
        }
      }
    };
    fetchOnce();
    const interval = setInterval(fetchOnce, pollMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [jobId, days, pollMs]);

  return breakdown;
}
