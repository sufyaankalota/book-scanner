import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

// Redis is the source of truth for cluster-wide dedup state. A null instance
// here means the env var wasn't provided yet — server still boots so we can
// ship the bootstrap deploy before wiring Railway's Redis plugin.
export const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    })
  : null;

if (redis) {
  redis.on('error', (err) => logger.error({ err }, 'redis error'));
  redis.on('connect', () => logger.info('redis connected'));
}
