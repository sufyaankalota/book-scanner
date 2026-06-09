import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default(''),
  // Firestore mirror — disabled by default so health-only deploys stay cheap.
  MIRROR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Base64-encoded service-account JSON. Decoded at startup.
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  // Shared secret guarding /api/portal/* read endpoints. Required in prod.
  PORTAL_API_KEY: z.string().optional(),
  // Dedup service — shared secret for /api/dedup + /ws/dedup. Falls back to
  // PORTAL_API_KEY when unset so we don't need two keys in single-tenant setups.
  DEDUP_API_KEY: z.string().optional(),
  // Default TTL (seconds) on a dedup claim. After this the barcode can be
  // re-scanned. 24h is the safe default for a daily-job workflow.
  DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  dedupApiKey: parsed.DEDUP_API_KEY ?? parsed.PORTAL_API_KEY,
  isProd: parsed.NODE_ENV === 'production',
} as const;

export type Config = typeof config;
