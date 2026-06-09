import type { DocumentSnapshot, Firestore, QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { snapshotMirror, startMirror } from './base';

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const ts = v as Timestamp;
  return typeof ts.toDate === 'function' ? ts.toDate() : null;
}

// Postgres TEXT and JSONB both reject 0x00 bytes inside string values. Some
// Firestore docs (especially exception payloads) contain stray NULs from
// upstream scanner SDKs. Strip them everywhere we hand strings to Prisma.
function stripNul(v: string): string {
  return v.includes('\u0000') ? v.replace(/\u0000/g, '') : v;
}

function s(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const cleaned = stripNul(v);
  return cleaned.length > 0 ? cleaned : null;
}

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function b(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function sanitizeJson(v: unknown): unknown {
  if (typeof v === 'string') return stripNul(v);
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(sanitizeJson);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[stripNul(k)] = sanitizeJson(val);
    }
    return out;
  }
  return v;
}

// Prisma nullable JSON requires `Prisma.JsonNull` to write SQL NULL; passing
// `null` is a type error. Use this helper for every JSONB column.
function j(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (v === null || v === undefined) return Prisma.JsonNull;
  return sanitizeJson(v) as Prisma.InputJsonValue;
}

/** scans/{scanId} → Postgres Scan row */
export function mirrorScans(db: Firestore) {
  return startMirror(db, {
    collectionPath: 'scans',
    cursorField: 'timestamp',
    upsert: async (doc: QueryDocumentSnapshot) => {
      const d = doc.data();
      const timestamp = toDate(d.timestamp);
      const jobId = s(d.jobId);
      const podId = s(d.podId);
      const scannerId = s(d.scannerId);
      const isbn = s(d.isbn);
      if (!timestamp || !jobId || !podId || !scannerId || !isbn) return; // malformed — skip
      // Type defaults to "standard" when omitted (matches the pod app convention).
      const type = s(d.type) ?? 'standard';
      await prisma.scan.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          jobId,
          podId,
          scannerId,
          isbn,
          poName: s(d.poName),
          type,
          source: s(d.source),
          capturedTitle: s(d.capturedTitle),
          matchScore: n(d.matchScore),
          duplicateOverride: b(d.duplicateOverride),
          timestamp,
        },
        update: {
          jobId,
          podId,
          scannerId,
          isbn,
          poName: s(d.poName),
          type,
          source: s(d.source),
          capturedTitle: s(d.capturedTitle),
          matchScore: n(d.matchScore),
          duplicateOverride: b(d.duplicateOverride),
          timestamp,
          firestoreUpdatedAt: new Date(),
        },
      });
    },
  });
}

/** exceptions/{exId} → Postgres Exception row (photo blob stays in Firestore). */
export function mirrorExceptions(db: Firestore) {
  return startMirror(db, {
    collectionPath: 'exceptions',
    cursorField: 'timestamp',
    upsert: async (doc: QueryDocumentSnapshot) => {
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
          id: doc.id,
          jobId,
          podId,
          scannerId: s(d.scannerId),
          isbn: s(d.isbn),
          title: s(d.title),
          reason,
          hasPhoto,
          timestamp,
        },
        update: {
          jobId,
          podId,
          scannerId: s(d.scannerId),
          isbn: s(d.isbn),
          title: s(d.title),
          reason,
          hasPhoto,
          timestamp,
          firestoreUpdatedAt: new Date(),
        },
      });
    },
  });
}

/** jobs/{jobId} → Postgres Job row. Not timestamp-ordered; use snapshot mirror. */
export function mirrorJobs(db: Firestore) {
  return snapshotMirror(db, 'jobs', async (doc: DocumentSnapshot) => {
    const d = doc.data();
    if (!d) return;
    const meta = (d.meta ?? {}) as Record<string, unknown>;
    const manifestMeta = (d.manifestMeta ?? {}) as Record<string, unknown>;
    const data = {
      name: s(meta.name),
      mode: s(meta.mode),
      active: typeof meta.active === 'boolean' ? meta.active : false,
      queued: typeof meta.queued === 'boolean' ? meta.queued : false,
      location: s(meta.location),
      dailyTarget: n(meta.dailyTarget),
      workingHours: n(meta.workingHours),
      pods: Array.isArray(meta.pods) ? (meta.pods as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      floaters: n(meta.floaters),
      runners: n(meta.runners),
      supervisors: n(meta.supervisors),
      poColors: j(d.poColors),
      poNumbers: j(d.poNumbers),
      exceptionColor: s(d.exceptionColor),
      exceptionNumber: n(d.exceptionNumber),
      manifestChunked: typeof manifestMeta.chunked === 'boolean' ? manifestMeta.chunked : false,
      manifestNumChunks: n(manifestMeta.numChunks),
      manifestHasTitles: b(manifestMeta.hasTitles),
      sourceUploadId: s(d.sourceUploadId),
      createdAt: toDate(meta.createdAt),
      activatedAt: toDate(meta.activatedAt),
      closedAt: toDate(meta.closedAt),
      firestoreUpdatedAt: new Date(),
    };
    await prisma.job.upsert({
      where: { id: doc.id },
      create: { id: doc.id, ...data },
      update: data,
    });
  });
}

/**
 * jobs/{jobId}/aggregates/totals → JobAggregate row. Uses collectionGroup so
 * a single listener catches all jobs. The doc path tells us the jobId.
 */
export function mirrorAggregates(db: Firestore) {
  let detach: (() => void) | null = null;
  let stopped = false;

  function attach(): void {
    if (stopped) return;
    detach = db.collectionGroup('aggregates').onSnapshot(
      async (snap) => {
        for (const ch of snap.docChanges()) {
          if (ch.type === 'removed') continue;
          const doc = ch.doc;
          // Path is jobs/{jobId}/aggregates/totals — only mirror the "totals" doc.
          if (doc.id !== 'totals') continue;
          const segs = doc.ref.path.split('/');
          const jobIdx = segs.indexOf('jobs');
          const jobId = jobIdx >= 0 ? segs[jobIdx + 1] : null;
          if (!jobId) continue;
          const d = doc.data();
          // Ensure parent Job exists (creates a shell row if jobs mirror hasn't seen it yet).
          await prisma.job.upsert({
            where: { id: jobId },
            create: { id: jobId, pods: [] },
            update: {},
          });
          const data = {
            totalScanned: n(d.totalScanned) ?? 0,
            totalExceptions: n(d.totalExceptions) ?? 0,
            totalManual: n(d.totalManual) ?? 0,
            totalAiMatch: n(d.totalAiMatch) ?? 0,
            totalManualExceptions: n(d.totalManualExceptions) ?? 0,
            byPO: j(d.byPO),
            updatedAt: toDate(d.updatedAt),
            recomputedAt: toDate(d.recomputedAt),
            firestoreUpdatedAt: new Date(),
          };
          await prisma.jobAggregate.upsert({
            where: { jobId },
            create: { jobId, ...data },
            update: data,
          });
        }
      },
      (err) => {
        if (detach) detach();
        detach = null;
        if (!stopped) setTimeout(() => attach(), 5_000).unref();
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

/** daily-summaries/{summaryId} → DailySummary row. */
export function mirrorDailySummaries(db: Firestore) {
  return snapshotMirror(db, 'daily-summaries', async (doc: DocumentSnapshot) => {
    const d = doc.data();
    if (!d) return;
    const jobId = s(d.jobId);
    const date = s(d.date);
    if (!jobId || !date) return;
    // Ensure parent Job row exists.
    await prisma.job.upsert({
      where: { id: jobId },
      create: { id: jobId, pods: [] },
      update: {},
    });
    const data = {
      jobId,
      date,
      totalScans: n(d.totalScans) ?? 0,
      totalExceptions: n(d.totalExceptions) ?? 0,
      totalManual: n(d.totalManual) ?? 0,
      totalAiMatch: n(d.totalAiMatch) ?? 0,
      byPO: j(d.byPO),
      firestoreUpdatedAt: new Date(),
    };
    // Use the compound unique key — Firestore sometimes has multiple docs
    // for the same (jobId, date) pair under different IDs (legacy data),
    // and the @@unique constraint would reject an insert under a new id.
    await prisma.dailySummary.upsert({
      where: { jobId_date: { jobId, date } },
      create: { id: doc.id, ...data },
      update: data,
    });
  });
}

/** presence/{podId} → Presence row. One doc per pod, overwritten every ~10s. */
export function mirrorPresence(db: Firestore) {
  return snapshotMirror(db, 'presence', async (doc: DocumentSnapshot) => {
    const d = doc.data();
    if (!d) return;
    const data = {
      podId: doc.id,
      scanners: Array.isArray(d.scanners) ? d.scanners.map((x) => String(x)) : [],
      operator: s(d.operator),
      status: s(d.status),
      online: b(d.online) ?? false,
      onBreak: b(d.onBreak) ?? false,
      breakSecondsRemaining: n(d.breakSecondsRemaining),
      lastSeen: toDate(d.lastSeen),
      message: s(d.message),
      notes: s(d.notes),
      firestoreUpdatedAt: new Date(),
    };
    await prisma.presence.upsert({
      where: { podId: doc.id },
      create: data,
      update: data,
    });
  });
}
