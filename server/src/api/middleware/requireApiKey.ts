import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config';

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.PORTAL_API_KEY) {
    // Unconfigured in dev — let requests through so local smoke tests work.
    if (config.isProd) {
      res.status(503).json({ error: 'portal_api_key_unset' });
      return;
    }
    next();
    return;
  }
  const provided = req.header('x-api-key') ?? '';
  if (provided !== config.PORTAL_API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
