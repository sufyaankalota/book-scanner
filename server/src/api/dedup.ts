import type { Request, Response, Router } from 'express';
import { Router as makeRouter } from 'express';
import { z } from 'zod';
import { requireDedupKey } from './middleware/requireDedupKey';
import * as store from '../dedup/store';
import type { HubHandle } from '../dedup/hub';
import { logger } from '../lib/logger';

const claimBody = z.object({
  jobId: z.string().min(1).max(255),
  barcode: z.string().min(1).max(255),
  podId: z.string().min(1).max(128),
  scannerId: z.string().min(1).max(128),
  scanId: z.string().max(255).optional(),
  // Up to 90 days. Long-running jobs (e.g. a 6-week prep batch) need claims
  // that outlive a single workday so a book scanned on day 1 still blocks
  // re-counts on day 30. Server-default 24h applies when omitted.
  ttlSeconds: z.coerce.number().int().positive().max(90 * 24 * 3600).optional(),
});

const releaseBody = z.object({
  jobId: z.string().min(1).max(255),
  barcode: z.string().min(1).max(255),
});

const inspectQuery = z.object({
  jobId: z.string().min(1).max(255),
  barcode: z.string().min(1).max(255),
});

const inspectManyBody = z.object({
  jobId: z.string().min(1).max(255),
  barcodes: z.array(z.string().min(1).max(255)).min(1).max(500),
});

export function dedupRouter(hub: HubHandle | null): Router {
  const r = makeRouter();
  r.use(requireDedupKey);

  r.get('/health', (_req, res) => {
    res.json({ ready: store.dedupReady(), hubAttached: Boolean(hub) });
  });

  r.post('/claim', async (req: Request, res: Response) => {
    const parsed = claimBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    if (!store.dedupReady()) {
      res.status(503).json({ error: 'redis_unavailable' });
      return;
    }
    const { jobId, barcode, podId, scannerId, scanId, ttlSeconds } = parsed.data;
    const claim = { podId, scannerId, scanId, timestamp: new Date().toISOString() };
    try {
      const result = await store.claim(jobId, barcode, claim, ttlSeconds);
      if (result.claimed && hub) hub.broadcastClaimed(jobId, barcode, claim);
      res.json({ jobId, barcode, ...result });
    } catch (err) {
      logger.error({ err, jobId, barcode }, 'dedup claim failed');
      res.status(500).json({ error: 'claim_failed' });
    }
  });

  r.post('/release', async (req: Request, res: Response) => {
    const parsed = releaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    if (!store.dedupReady()) {
      res.status(503).json({ error: 'redis_unavailable' });
      return;
    }
    const { jobId, barcode } = parsed.data;
    try {
      const removed = await store.release(jobId, barcode);
      if (removed && hub) hub.broadcastReleased(jobId, barcode);
      res.json({ jobId, barcode, removed });
    } catch (err) {
      logger.error({ err, jobId, barcode }, 'dedup release failed');
      res.status(500).json({ error: 'release_failed' });
    }
  });

  r.get('/inspect', async (req: Request, res: Response) => {
    const parsed = inspectQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    if (!store.dedupReady()) {
      res.status(503).json({ error: 'redis_unavailable' });
      return;
    }
    const { jobId, barcode } = parsed.data;
    try {
      const claim = await store.inspect(jobId, barcode);
      res.json({ jobId, barcode, claim });
    } catch (err) {
      logger.error({ err, jobId, barcode }, 'dedup inspect failed');
      res.status(500).json({ error: 'inspect_failed' });
    }
  });

  r.post('/inspect-many', async (req: Request, res: Response) => {
    const parsed = inspectManyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    if (!store.dedupReady()) {
      res.status(503).json({ error: 'redis_unavailable' });
      return;
    }
    const { jobId, barcodes } = parsed.data;
    try {
      const claims = await store.inspectMany(jobId, barcodes);
      res.json({ jobId, claims });
    } catch (err) {
      logger.error({ err, jobId }, 'dedup inspectMany failed');
      res.status(500).json({ error: 'inspect_failed' });
    }
  });

  return r;
}
