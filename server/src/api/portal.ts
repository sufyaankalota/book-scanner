import type { Request, Response, Router } from 'express';
import { Router as makeRouter } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireApiKey } from './middleware/requireApiKey';

// All response fields are JSON-serializable plain objects. BigInt fields
// (SyncState.rowsTotal) are not exposed by any portal endpoint, so we never
// need a BigInt serializer here.

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const limitSchema = z.coerce.number().int().min(1).max(5000).default(500);
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid ISO date' });

const listScansQuery = z.object({
  jobId: z.string().min(1),
  since: isoDate.optional(),
  until: isoDate.optional(),
  type: z.enum(['standard', 'exception']).optional(),
  source: z.enum(['manual', 'ai-match']).optional(),
  poName: z.string().optional(),
  scannerId: z.string().optional(),
  podId: z.string().optional(),
  limit: limitSchema,
  // Keyset cursor: <ISO timestamp>|<id> from the previous page's last row.
  cursor: z.string().optional(),
});

const listExceptionsQuery = z.object({
  jobId: z.string().min(1),
  since: isoDate.optional(),
  until: isoDate.optional(),
  limit: limitSchema,
  cursor: z.string().optional(),
});

const summaryQuery = z.object({
  jobId: z.string().min(1),
  start: isoDate,
  end: isoDate,
});

const dailySummariesQuery = z.object({
  jobId: z.string().min(1),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ---------------------------------------------------------------------------
// Cursor helpers (keyset pagination on (timestamp DESC, id DESC))
// ---------------------------------------------------------------------------

function encodeCursor(row: { timestamp: Date; id: string }): string {
  return `${row.timestamp.toISOString()}|${row.id}`;
}

function decodeCursor(raw: string): { ts: Date; id: string } | null {
  const idx = raw.indexOf('|');
  if (idx < 0) return null;
  const ts = new Date(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (Number.isNaN(ts.getTime()) || !id) return null;
  return { ts, id };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function portalRouter(): Router {
  const r = makeRouter();
  r.use(requireApiKey);

  // GET /api/portal/jobs?active=true
  r.get('/jobs', async (req: Request, res: Response) => {
    const active = req.query.active === 'true' ? true : undefined;
    const jobs = await prisma.job.findMany({
      where: active === undefined ? undefined : { active },
      orderBy: [{ active: 'desc' }, { activatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ jobs });
  });

  // GET /api/portal/jobs/:jobId
  r.get('/jobs/:jobId', async (req: Request, res: Response) => {
    const job = await prisma.job.findUnique({ where: { id: req.params.jobId } });
    if (!job) {
      res.status(404).json({ error: 'job_not_found' });
      return;
    }
    res.json({ job });
  });

  // GET /api/portal/jobs/:jobId/aggregate
  r.get('/jobs/:jobId/aggregate', async (req: Request, res: Response) => {
    const agg = await prisma.jobAggregate.findUnique({ where: { jobId: req.params.jobId } });
    if (!agg) {
      res.status(404).json({ error: 'aggregate_not_found' });
      return;
    }
    res.json({ aggregate: agg });
  });

  // GET /api/portal/scans?jobId=…&since=…&type=…&source=…&poName=…&limit=&cursor=
  r.get('/scans', async (req: Request, res: Response) => {
    const parsed = listScansQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    const where: Prisma.ScanWhereInput = { jobId: q.jobId };
    if (q.type) where.type = q.type;
    if (q.source) where.source = q.source;
    if (q.poName) where.poName = q.poName;
    if (q.scannerId) where.scannerId = q.scannerId;
    if (q.podId) where.podId = q.podId;
    if (q.since || q.until) {
      where.timestamp = {
        ...(q.since ? { gte: new Date(q.since) } : {}),
        ...(q.until ? { lte: new Date(q.until) } : {}),
      };
    }
    // Keyset pagination — strictly newer-than-cursor on (timestamp, id).
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c) {
        res.status(400).json({ error: 'invalid_cursor' });
        return;
      }
      where.OR = [
        { timestamp: { lt: c.ts } },
        { timestamp: c.ts, id: { lt: c.id } },
      ];
    }
    const rows = await prisma.scan.findMany({
      where,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    res.json({
      scans: page,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    });
  });

  // GET /api/portal/scans/summary?jobId=&start=&end=
  // Returns the breakdown the Reports page used to compute by issuing ~5
  // separate getCountFromServer calls plus per-day fetches. One query, server-side.
  r.get('/scans/summary', async (req: Request, res: Response) => {
    const parsed = summaryQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const { jobId, start, end } = parsed.data;
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (endDate < startDate) {
      res.status(400).json({ error: 'end_before_start' });
      return;
    }

    // Two queries: per-day buckets, and aggregate splits by type/source.
    const [perDay, byType, bySource, exceptionsCount] = await Promise.all([
      prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT date_trunc('day', "timestamp") AS day, COUNT(*) AS count
        FROM "Scan"
        WHERE "jobId" = ${jobId}
          AND "timestamp" >= ${startDate}
          AND "timestamp" <= ${endDate}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.scan.groupBy({
        by: ['type'],
        where: { jobId, timestamp: { gte: startDate, lte: endDate } },
        _count: { _all: true },
      }),
      prisma.scan.groupBy({
        by: ['source'],
        where: { jobId, timestamp: { gte: startDate, lte: endDate } },
        _count: { _all: true },
      }),
      prisma.exception.count({
        where: { jobId, timestamp: { gte: startDate, lte: endDate } },
      }),
    ]);

    res.json({
      jobId,
      range: { start, end },
      perDay: perDay.map((p) => ({ day: p.day.toISOString().slice(0, 10), count: Number(p.count) })),
      byType: Object.fromEntries(byType.map((r) => [r.type, r._count._all])),
      bySource: Object.fromEntries(
        bySource.map((r) => [r.source ?? 'standard', r._count._all]),
      ),
      exceptionsCount,
    });
  });

  // GET /api/portal/exceptions?jobId=&since=&limit=&cursor=
  r.get('/exceptions', async (req: Request, res: Response) => {
    const parsed = listExceptionsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    const where: Prisma.ExceptionWhereInput = { jobId: q.jobId };
    if (q.since || q.until) {
      where.timestamp = {
        ...(q.since ? { gte: new Date(q.since) } : {}),
        ...(q.until ? { lte: new Date(q.until) } : {}),
      };
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c) {
        res.status(400).json({ error: 'invalid_cursor' });
        return;
      }
      where.OR = [
        { timestamp: { lt: c.ts } },
        { timestamp: c.ts, id: { lt: c.id } },
      ];
    }
    const rows = await prisma.exception.findMany({
      where,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    res.json({
      exceptions: page,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    });
  });

  // GET /api/portal/daily-summaries?jobId=&start=YYYY-MM-DD&end=YYYY-MM-DD
  r.get('/daily-summaries', async (req: Request, res: Response) => {
    const parsed = dailySummariesQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const { jobId, start, end } = parsed.data;
    const where: Prisma.DailySummaryWhereInput = { jobId };
    if (start || end) {
      where.date = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {}),
      };
    }
    const summaries = await prisma.dailySummary.findMany({
      where,
      orderBy: { date: 'desc' },
    });
    res.json({ summaries });
  });

  return r;
}
