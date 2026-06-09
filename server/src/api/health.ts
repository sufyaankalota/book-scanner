import type { Request, Response, Router } from 'express';
import { Router as makeRouter } from 'express';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { config } from '../config';

export function healthRouter(): Router {
  const r = makeRouter();

  // Liveness — process is up. Returns 200 even with no deps configured so
  // the bootstrap deploy is reachable before Postgres + Redis are wired.
  r.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'prepfort-scan-engine', env: config.NODE_ENV });
  });

  // Readiness — verifies upstream connectivity. Surfaces per-dep status so
  // Railway/operators can see exactly which dependency is degraded.
  r.get('/readyz', async (_req: Request, res: Response) => {
    const out: Record<string, unknown> = { ok: true, deps: {} };
    const deps = out.deps as Record<string, unknown>;

    if (config.DATABASE_URL) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        deps.postgres = 'ok';
      } catch (err) {
        deps.postgres = `error: ${(err as Error).message}`;
        out.ok = false;
      }
    } else {
      deps.postgres = 'not-configured';
    }

    if (redis) {
      try {
        const pong = await redis.ping();
        deps.redis = pong === 'PONG' ? 'ok' : `unexpected: ${pong}`;
      } catch (err) {
        deps.redis = `error: ${(err as Error).message}`;
        out.ok = false;
      }
    } else {
      deps.redis = 'not-configured';
    }

    res.status(out.ok ? 200 : 503).json(out);
  });

  return r;
}
