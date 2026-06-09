import { redis } from '../lib/redis';
import { config } from '../config';
import { logger } from '../lib/logger';

// A dedup claim records the *first* scan of a (jobId, barcode) pair. The
// claim is atomic (SET NX EX) so two pods racing the same barcode can never
// both succeed. Expires after DEDUP_TTL_SECONDS so a barcode can be
// re-scanned on a later day without manual cleanup.

export type DedupClaim = {
  podId: string;
  scannerId: string;
  scanId?: string;
  timestamp: string; // ISO
};

export type ClaimResult =
  | { claimed: true; ttlSeconds: number }
  | { claimed: false; existing: DedupClaim };

function key(jobId: string, barcode: string): string {
  return `dedup:${jobId}:${barcode}`;
}

function parse(raw: string | null): DedupClaim | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as DedupClaim;
    if (typeof obj.podId !== 'string' || typeof obj.timestamp !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

export async function claim(
  jobId: string,
  barcode: string,
  claim: DedupClaim,
  ttlSeconds: number = config.DEDUP_TTL_SECONDS,
): Promise<ClaimResult> {
  if (!redis) throw new Error('redis_not_configured');
  const k = key(jobId, barcode);
  const payload = JSON.stringify(claim);
  // NX = only set if absent. The atomic test-and-set is what makes this safe.
  const set = await redis.set(k, payload, 'EX', ttlSeconds, 'NX');
  if (set === 'OK') {
    return { claimed: true, ttlSeconds };
  }
  const existing = parse(await redis.get(k));
  if (!existing) {
    // Race: key disappeared between SET NX and GET. Retry once.
    const retry = await redis.set(k, payload, 'EX', ttlSeconds, 'NX');
    if (retry === 'OK') return { claimed: true, ttlSeconds };
    return {
      claimed: false,
      existing: { podId: 'unknown', scannerId: 'unknown', timestamp: new Date(0).toISOString() },
    };
  }
  return { claimed: false, existing };
}

export async function release(jobId: string, barcode: string): Promise<boolean> {
  if (!redis) throw new Error('redis_not_configured');
  const removed = await redis.del(key(jobId, barcode));
  return removed > 0;
}

export async function inspect(jobId: string, barcode: string): Promise<DedupClaim | null> {
  if (!redis) throw new Error('redis_not_configured');
  return parse(await redis.get(key(jobId, barcode)));
}

export async function inspectMany(
  jobId: string,
  barcodes: string[],
): Promise<Record<string, DedupClaim | null>> {
  if (!redis) throw new Error('redis_not_configured');
  if (barcodes.length === 0) return {};
  const values = await redis.mget(barcodes.map((b) => key(jobId, b)));
  const out: Record<string, DedupClaim | null> = {};
  barcodes.forEach((b, i) => {
    out[b] = parse(values[i] ?? null);
  });
  return out;
}

export function dedupReady(): boolean {
  const ok = Boolean(redis);
  if (!ok) logger.warn('dedup requested but REDIS_URL not configured');
  return ok;
}
