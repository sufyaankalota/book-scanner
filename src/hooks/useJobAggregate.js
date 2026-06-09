import { useEffect, useState } from 'react';
import { isScanEngineConfigured, scanEngine } from '../lib/scanEngine';

/**
 * Polls the scan-engine for a job's aggregate totals doc. Returns the same
 * shape the Firestore subscriber used to return (totalScanned, totalExceptions,
 * totalManual, totalAiMatch, byPO, updatedAt, ...) so consumers don't need to
 * branch on data source.
 *
 * Falls back to null (the component can show its "no aggregate yet" state)
 * if the scan-engine isn't configured for this environment. The caller is
 * expected to keep its existing Firestore subscriber as a fallback for now.
 *
 * @param {string|null} jobId
 * @param {number} pollMs — refresh cadence. Default 15s: the aggregate doc
 *   itself only changes when scans land, so faster polling is wasted.
 */
export function useJobAggregate(jobId, pollMs = 15000) {
  const [aggregate, setAggregate] = useState(null);

  useEffect(() => {
    if (!isScanEngineConfigured || !jobId) {
      setAggregate(null);
      return undefined;
    }
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const { aggregate: a } = await scanEngine.getAggregate(jobId);
        if (!cancelled) setAggregate(a);
      } catch (err) {
        // 404 just means the server-side counter hasn't been seeded yet —
        // keep last known value (null) and try again on next interval.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[useJobAggregate] fetch failed', err);
        }
      }
    };

    fetchOnce();
    const interval = setInterval(fetchOnce, pollMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [jobId, pollMs]);

  return aggregate;
}
