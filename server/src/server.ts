import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config';
import { healthRouter } from './api/health';
import { portalRouter } from './api/portal';
import { dedupRouter } from './api/dedup';
import { attachDedupHub } from './dedup/hub';
import { redis } from './lib/redis';
import { logger } from './lib/logger';
import { startAllMirrors } from './mirror';

const app = express();

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsOrigins.length === 0) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS rejected: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(healthRouter());
app.use('/api/portal', portalRouter());

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'prepfort-scan-engine listening');
});

const dedupHub = redis ? attachDedupHub(server) : null;
if (!dedupHub) {
  logger.warn('REDIS_URL unset \u2014 dedup HTTP + WS endpoints will return 503');
}
app.use('/api/dedup', dedupRouter(dedupHub));

app.get('/', (_req, res) => {
  res.json({ service: 'prepfort-scan-engine', status: 'ok' });
});

const mirrorHandle = config.MIRROR_ENABLED ? startAllMirrors() : null;
if (config.MIRROR_ENABLED && !mirrorHandle) {
  logger.warn('MIRROR_ENABLED=true but Firestore not configured; mirror is inert');
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  Promise.allSettled([mirrorHandle?.stop(), dedupHub?.stop()])
    .catch((err) => logger.error({ err }, 'subsystem shutdown failed'))
    .finally(() => server.close(() => process.exit(0)));
  // Hard exit after 10s if connections don't drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
