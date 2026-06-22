import type { DocumentSnapshot, Firestore, Query, QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

/**
 * Cursor stored per collection in the SyncState table. We persist it as an
 * ISO string (the orderBy field is always a Firestore Timestamp on the
 * mirror'd collections) so the format is debuggable in psql.
 */
export interface MirrorOptions<T> {
  /** Collection or collectionGroup path to watch (e.g. "scans"). */
  collectionPath: string;
  /** Field we orderBy + cursor on. Must be a Timestamp on every doc. */
  cursorField: string;
  /** Convert a Firestore snapshot into a Prisma upsert (no-op if returns null to skip). */
  upsert: (doc: QueryDocumentSnapshot) => Promise<void>;
  /** Resolve the cursor value (an ISO string) for a doc — defaults to reading cursorField. */
  resolveCursor?: (doc: QueryDocumentSnapshot) => string | null;
  /** Use collectionGroup() instead of collection() — needed for nested subcollections. */
  isCollectionGroup?: boolean;
  /** Optional max docs per batch (default 500). */
  batchSize?: number;
}

interface MirrorHandle {
  stop: () => Promise<void>;
}

/**
 * Generic Firestore mirror runner. Each invocation:
 *   1. Reads the cursor from SyncState.
 *   2. Subscribes to docs strictly after the cursor, ordered by cursorField.
 *   3. For each snapshot, runs `upsert(doc)` then bumps SyncState.cursor.
 *
 * onSnapshot replays existing docs once (matching the query) and then streams
 * new ones — so it doubles as backfill for anything missed while the service
 * was down. The Firestore listener itself handles reconnects/backoff.
 */
export function startMirror<T>(db: Firestore, opts: MirrorOptions<T>): MirrorHandle {
  const { collectionPath, cursorField, batchSize = 500 } = opts;
  const log = logger.child({ mirror: collectionPath });
  let detach: (() => void) | null = null;
  let stopped = false;

  async function loadCursor(): Promise<Date | null> {
    const row = await prisma.syncState.findUnique({ where: { collection: collectionPath } });
    if (!row?.cursor) return null;
    const d = new Date(row.cursor);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async function saveCursor(iso: string, rowDelta: number): Promise<void> {
    await prisma.syncState.upsert({
      where: { collection: collectionPath },
      create: { collection: collectionPath, cursor: iso, rowsTotal: BigInt(rowDelta) },
      update: { cursor: iso, rowsTotal: { increment: BigInt(rowDelta) } },
    });
  }

  function defaultResolveCursor(doc: QueryDocumentSnapshot): string | null {
    const v = doc.get(cursorField) as Timestamp | undefined;
    return v?.toDate ? v.toDate().toISOString() : null;
  }

  function buildQuery(after: Date | null): Query {
    const base = opts.isCollectionGroup
      ? db.collectionGroup(collectionPath)
      : db.collection(collectionPath);
    let q = base.orderBy(cursorField, 'asc').limit(batchSize);
    if (after) q = q.startAfter(after);
    return q;
  }

  async function processBatch(query: Query): Promise<{ count: number; lastCursor: string | null }> {
    const snap = await query.get();
    if (snap.empty) return { count: 0, lastCursor: null };
    const resolve = opts.resolveCursor ?? defaultResolveCursor;
    let lastCursor: string | null = null;
    let count = 0;
    for (const doc of snap.docs) {
      try {
        await opts.upsert(doc);
        const c = resolve(doc);
        if (c) lastCursor = c;
        count += 1;
      } catch (err) {
        const c = resolve(doc);
        if (c) lastCursor = c;
        count += 1;
        log.error({ err, docId: doc.id, cursor: c }, 'upsert failed; skipping poison doc so mirror can keep draining');
      }
    }
    return { count, lastCursor };
  }

  async function drainHistorical(): Promise<void> {
    // Catch up in fixed-size batches until we're current, then attach a live listener.
    while (!stopped) {
      const cursor = await loadCursor();
      const { count, lastCursor } = await processBatch(buildQuery(cursor));
      if (count === 0) {
        log.info({ cursor }, 'historical drain complete');
        return;
      }
      if (lastCursor) await saveCursor(lastCursor, count);
      log.debug({ count, lastCursor }, 'batch drained');
      if (count < batchSize) return;
    }
  }

  function attachListener(): void {
    if (stopped) return;
    void loadCursor().then((cursor) => {
      if (stopped) return;
      const live = opts.isCollectionGroup
        ? db.collectionGroup(collectionPath)
        : db.collection(collectionPath);
      let q: Query = live.orderBy(cursorField, 'asc');
      if (cursor) q = q.startAfter(cursor);
      detach = q.onSnapshot(
        async (snap) => {
          const changes = snap.docChanges().filter((c) => c.type === 'added' || c.type === 'modified');
          if (changes.length === 0) return;
          const resolve = opts.resolveCursor ?? defaultResolveCursor;
          let lastCursor: string | null = null;
          let count = 0;
          for (const ch of changes) {
            try {
              await opts.upsert(ch.doc);
              const c = resolve(ch.doc);
              if (c) lastCursor = c;
              count += 1;
            } catch (err) {
              const c = resolve(ch.doc);
              if (c) lastCursor = c;
              count += 1;
              log.error({ err, docId: ch.doc.id, cursor: c }, 'live upsert failed; skipping poison doc');
            }
          }
          if (lastCursor) await saveCursor(lastCursor, count);
          log.debug({ count, lastCursor }, 'live batch applied');
        },
        (err) => {
          log.error({ err }, 'snapshot listener errored; re-attaching in 5s');
          if (detach) detach();
          detach = null;
          setTimeout(() => attachListener(), 5_000).unref();
        },
      );
    });
  }

  void drainHistorical()
    .then(() => attachListener())
    .catch((err) => log.error({ err }, 'mirror startup failed'));

  return {
    stop: async () => {
      stopped = true;
      if (detach) {
        detach();
        detach = null;
      }
    },
  };
}

/** Helper for non-timestamp-ordered mirrors (e.g. jobs, aggregates). */
export function snapshotMirror(
  db: Firestore,
  collectionPath: string,
  upsert: (doc: DocumentSnapshot) => Promise<void>,
  onError?: (err: Error) => void,
): MirrorHandle {
  const log = logger.child({ mirror: collectionPath });
  let detach: (() => void) | null = null;
  let stopped = false;

  function attach(): void {
    if (stopped) return;
    detach = db.collection(collectionPath).onSnapshot(
      async (snap) => {
        const changes = snap.docChanges();
        for (const ch of changes) {
          if (ch.type === 'removed') continue;
          try {
            await upsert(ch.doc);
          } catch (err) {
            log.error({ err, docId: ch.doc.id }, 'snapshot upsert failed');
          }
        }
        if (changes.length > 0) log.debug({ count: changes.length }, 'snapshot batch applied');
      },
      (err) => {
        log.error({ err }, 'snapshot listener errored; re-attaching in 5s');
        if (detach) detach();
        detach = null;
        onError?.(err);
        setTimeout(() => attach(), 5_000).unref();
      },
    );
  }

  attach();

  return {
    stop: async () => {
      stopped = true;
      if (detach) {
        detach();
        detach = null;
      }
    },
  };
}
