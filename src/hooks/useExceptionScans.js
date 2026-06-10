import { useEffect, useState } from 'react';
import { isScanEngineConfigured, scanEngine } from '../lib/scanEngine';

/**
 * Pages through /api/portal/scans for type=exception rows on a job, bounded
 * to the trailing `days` window. The CustomerPortal "Exceptions" tab needs
 * these alongside the manual Exception docs to render the per-day list.
 *
 * Returns the shape the legacy code expects ({ timestamp: { toDate(): Date } })
 * so the dailyExceptions useMemo doesn't have to branch.
 *
 * Null when scan-engine isn't configured.
 *
 * @param {string|null} jobId
 * @param {number} days
 * @param {number} pollMs
 */
export function useExceptionScans(jobId, days = 14, pollMs = 60000) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!isScanEngineConfigured || !jobId) {
      setRows(null);
      return undefined;
    }
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - days);
        since.setHours(0, 0, 0, 0);
        const sinceIso = since.toISOString();
        const collected = [];
        let cursor;
        // Safety cap: 20 pages × 5000 = 100K rows max (exceptions never get
        // anywhere near this in practice).
        for (let i = 0; i < 20; i += 1) {
          const { scans, nextCursor } = await scanEngine.listScans({
            jobId, since: sinceIso, type: 'exception', limit: 5000, cursor,
          });
          for (const s of scans) {
            collected.push({
              ...s,
              timestamp: { toDate: () => new Date(s.timestamp) },
            });
          }
          if (!nextCursor) break;
          cursor = nextCursor;
        }
        if (!cancelled) setRows(collected);
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[useExceptionScans] fetch failed', err);
        }
      }
    };

    fetchOnce();
    const interval = setInterval(fetchOnce, pollMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [jobId, days, pollMs]);

  return rows;
}
