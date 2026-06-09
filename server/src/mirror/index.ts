import { getDb } from '../lib/firebase';
import { logger } from '../lib/logger';
import {
  mirrorAggregates,
  mirrorDailySummaries,
  mirrorExceptions,
  mirrorJobs,
  mirrorPresence,
  mirrorScans,
} from './collections';

interface Handle {
  stop: () => Promise<void>;
}

/**
 * Wires every collection mirror and returns a single stop() to detach them
 * all on SIGTERM. Returns null if Firebase isn't configured — callers should
 * treat that as "mirror disabled".
 */
export function startAllMirrors(): Handle | null {
  const db = getDb();
  if (!db) {
    logger.warn('Firestore unavailable; mirror not starting');
    return null;
  }
  logger.info('starting Firestore → Postgres mirror');

  const handles = [
    mirrorJobs(db),
    mirrorScans(db),
    mirrorExceptions(db),
    mirrorAggregates(db),
    mirrorDailySummaries(db),
    mirrorPresence(db),
  ];

  return {
    stop: async () => {
      logger.info('stopping mirror listeners');
      await Promise.all(handles.map((h) => h.stop().catch(() => undefined)));
    },
  };
}
