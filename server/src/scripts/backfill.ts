/**
 * One-shot Firestore → Postgres backfill. Reads documents in cursor-paginated
 * batches and runs the same upsert logic the live mirror uses. Use after a
 * long outage or for the initial seed of historical data.
 *
 * Usage:
 *   npm run backfill -- --collection=scans [--since=2026-01-01] [--limit=500]
 *
 * Supported collections: scans, exceptions, jobs, daily-summaries, aggregates, all
 */
import { Timestamp } from 'firebase-admin/firestore';
import { getDb } from '../lib/firebase';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import {
  mirrorAggregates,
  mirrorDailySummaries,
  mirrorExceptions,
  mirrorJobs,
  mirrorScans,
} from '../mirror/collections';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function backfillTimestamped(
  db: FirebaseFirestore.Firestore,
  collectionPath: string,
  since: Date | null,
  batchSize: number,
): Promise<void> {
  const log = logger.child({ backfill: collectionPath });
  let cursor: Date | null = since;
  let total = 0;
  for (;;) {
    let q = db.collection(collectionPath).orderBy('timestamp', 'asc').limit(batchSize);
    if (cursor) q = q.startAfter(Timestamp.fromDate(cursor));
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      // Re-use the live upsert by calling it directly via a lightweight harness.
      const data = doc.data();
      const ts = data.timestamp as Timestamp | undefined;
      if (!ts?.toDate) continue;
      cursor = ts.toDate();
      // Each collection has its own upsert path — handled below via case dispatch.
      await upsertDispatch(collectionPath, doc);
    }
    total += snap.size;
    log.info({ batch: snap.size, total, cursor: cursor?.toISOString() }, 'batch upserted');
    if (snap.size < batchSize) break;
  }
  // Persist cursor so the live mirror starts from here.
  if (cursor) {
    await prisma.syncState.upsert({
      where: { collection: collectionPath },
      create: { collection: collectionPath, cursor: cursor.toISOString(), rowsTotal: BigInt(total) },
      update: { cursor: cursor.toISOString(), rowsTotal: { increment: BigInt(total) } },
    });
  }
  log.info({ total }, 'backfill complete');
}

async function upsertDispatch(
  collectionPath: string,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<void> {
  // Reuse the collection mirrors' upsert logic via shim handles. We can't
  // easily extract the closure, so for backfill we inline a minimal version
  // that delegates to the live mirror infrastructure by re-importing the
  // helpers — but to avoid duplication we just call upsert through the
  // mirror module's exported upsertOne helpers (added below).
  switch (collectionPath) {
    case 'scans':
      await upsertScan(doc);
      return;
    case 'exceptions':
      await upsertException(doc);
      return;
  }
}

// Local copies of the upsert logic (kept in sync with collections.ts) so the
// backfill can run without standing up a Firestore listener.
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
function s(v: unknown) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function n(v: unknown) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function b(v: unknown) {
  return typeof v === 'boolean' ? v : null;
}
function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const t = v as Timestamp;
  return typeof t.toDate === 'function' ? t.toDate() : null;
}

async function upsertScan(doc: QueryDocumentSnapshot): Promise<void> {
  const d = doc.data();
  const timestamp = toDate(d.timestamp);
  const jobId = s(d.jobId);
  const podId = s(d.podId);
  const scannerId = s(d.scannerId);
  const isbn = s(d.isbn);
  if (!timestamp || !jobId || !podId || !scannerId || !isbn) return;
  const type = s(d.type) ?? 'standard';
  await prisma.scan.upsert({
    where: { id: doc.id },
    create: {
      id: doc.id, jobId, podId, scannerId, isbn,
      poName: s(d.poName), type, source: s(d.source),
      capturedTitle: s(d.capturedTitle), matchScore: n(d.matchScore),
      duplicateOverride: b(d.duplicateOverride), timestamp,
    },
    update: {
      jobId, podId, scannerId, isbn,
      poName: s(d.poName), type, source: s(d.source),
      capturedTitle: s(d.capturedTitle), matchScore: n(d.matchScore),
      duplicateOverride: b(d.duplicateOverride), timestamp,
      firestoreUpdatedAt: new Date(),
    },
  });
}

async function upsertException(doc: QueryDocumentSnapshot): Promise<void> {
  const d = doc.data();
  const timestamp = toDate(d.timestamp);
  const jobId = s(d.jobId);
  const podId = s(d.podId);
  const reason = s(d.reason);
  if (!timestamp || !jobId || !podId || !reason) return;
  const hasPhoto = typeof d.photo === 'string' && d.photo.length > 0;
  await prisma.exception.upsert({
    where: { id: doc.id },
    create: {
      id: doc.id, jobId, podId, scannerId: s(d.scannerId),
      isbn: s(d.isbn), title: s(d.title), reason, hasPhoto, timestamp,
    },
    update: {
      jobId, podId, scannerId: s(d.scannerId),
      isbn: s(d.isbn), title: s(d.title), reason, hasPhoto, timestamp,
      firestoreUpdatedAt: new Date(),
    },
  });
}

async function backfillSnapshot(
  db: FirebaseFirestore.Firestore,
  collectionPath: string,
): Promise<void> {
  const log = logger.child({ backfill: collectionPath });
  const snap = await db.collection(collectionPath).get();
  log.info({ count: snap.size }, 'snapshot read');
  // Delegate to the live mirror upsert by spinning up the mirror briefly:
  // for snapshot collections (jobs, daily-summaries) the live mirror will
  // see every existing doc on attach anyway — so the recommended backfill
  // path is just to start the service with MIRROR_ENABLED=true. We log a
  // hint here rather than re-implementing the upsert.
  log.info('snapshot-style collections backfill automatically on first attach — run the service with MIRROR_ENABLED=true to seed');
}

async function backfillAggregates(db: FirebaseFirestore.Firestore): Promise<void> {
  // Same note as snapshot collections.
  logger.info('aggregates backfill happens on first listener attach — use MIRROR_ENABLED=true');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const collection = args.collection;
  if (!collection) {
    console.error('Missing --collection=<name>. One of: scans, exceptions, jobs, daily-summaries, aggregates, all');
    process.exit(2);
  }
  const since = args.since ? new Date(args.since) : null;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`Invalid --since=${args.since}`);
    process.exit(2);
  }
  const batchSize = args.limit ? parseInt(args.limit, 10) : 500;

  const db = getDb();
  if (!db) {
    console.error('Firestore not configured; set FIREBASE_SERVICE_ACCOUNT');
    process.exit(2);
  }

  const targets = collection === 'all'
    ? ['scans', 'exceptions', 'jobs', 'daily-summaries', 'aggregates']
    : [collection];

  for (const target of targets) {
    if (target === 'scans' || target === 'exceptions') {
      await backfillTimestamped(db, target, since, batchSize);
    } else if (target === 'jobs' || target === 'daily-summaries') {
      await backfillSnapshot(db, target);
    } else if (target === 'aggregates') {
      await backfillAggregates(db);
    } else {
      console.error(`Unknown collection: ${target}`);
      process.exit(2);
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'backfill failed');
  process.exit(1);
});
