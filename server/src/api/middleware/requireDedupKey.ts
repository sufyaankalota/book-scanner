import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config';

// Same shape as requireApiKey but accepts `DEDUP_API_KEY` (falling back to
// PORTAL_API_KEY in config.dedupApiKey). Kept separate so the two surfaces
// can later be split with distinct secrets without code churn.
export function requireDedupKey(req: Request, res: Response, next: NextFunction): void {
  const required = config.dedupApiKey;
  if (!required) {
    if (config.isProd) {
      res.status(503).json({ error: 'dedup_api_key_unset' });
      return;
    }
    next();
    return;
  }
  const provided = req.header('x-api-key') ?? '';
  if (provided !== required) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
