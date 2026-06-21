import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config';

// Constant-time string compare so an attacker can't byte-by-byte guess the
// key from response latency. Length mismatch short-circuits (length is not
// secret); equal lengths go through timingSafeEqual.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

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
  if (!safeEqual(provided, config.PORTAL_API_KEY)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
