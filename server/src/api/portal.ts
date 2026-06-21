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
  // jobId is optional so the Reports page can query across all jobs.
  jobId: z.string().min(1).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
  type: z.enum(['standard', 'exception']).optional(),
  source: z.enum(['manual', 'ai-match']).optional(),
  poName: z.string().optional(),
  scannerId: z.string().optional(),
  podId: z.string().optional(),
  isbn: z.string().min(1).max(20).optional(),
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
  // jobId is optional so the Reports page can query across all jobs.
  jobId: z.string().min(1).optional(),
  start: isoDate,
  end: isoDate,
});

const dailySummariesQuery = z.object({
  jobId: z.string().min(1),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const dailyBreakdownQuery = z.object({
  jobId: z.string().min(1),
  start: isoDate,
  end: isoDate,
});

const operatorsQuery = z.object({
  // jobId optional so Reports can query across all jobs.
  jobId: z.string().min(1).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
});

const exportScansQuery = z.object({
  jobId: z.string().min(1),
  since: isoDate.optional(),
  until: isoDate.optional(),
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

// RFC4180 CSV cell — quote when the value contains a comma, quote or newline.
function csvCell(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    if (q.isbn) where.isbn = q.isbn;
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

  // GET /api/portal/scans/export?jobId=&since=ISO&until=ISO
  // Streams every scan in the range as CSV straight from Postgres using keyset
  // pagination — bounded memory, NO row cap, finishes in seconds even for a
  // full multi-month job. This is the "give me all ISBNs from X to Y" report.
  r.get('/scans/export', async (req: Request, res: Response) => {
    const parsed = exportScansQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const { jobId, since, until } = parsed.data;
    const gte = since ? new Date(since) : undefined;
    const lte = until ? new Date(until) : undefined;
    const rangeFilter =
      gte || lte ? { timestamp: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {};

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scans_${jobId}_${stamp}.csv"`);
    res.write('isbn,po,type,source,pod,operator,title,timestamp\n');

    const BATCH = 10000;
    let cursor: { ts: Date; id: string } | null = null;
    for (;;) {
      const where: Prisma.ScanWhereInput = {
        jobId,
        ...rangeFilter,
        ...(cursor
          ? { OR: [{ timestamp: { gt: cursor.ts } }, { timestamp: cursor.ts, id: { gt: cursor.id } }] }
          : {}),
      };
      // eslint-disable-next-line no-await-in-loop
      const batch = await prisma.scan.findMany({
        where,
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        take: BATCH,
        select: {
          id: true, isbn: true, poName: true, type: true, source: true,
          podId: true, scannerId: true, capturedTitle: true, timestamp: true,
        },
      });
      if (batch.length === 0) break;
      let chunk = '';
      for (const row of batch) {
        chunk += [
          csvCell(row.isbn),
          csvCell(row.poName),
          csvCell(row.type),
          csvCell(row.source),
          csvCell(row.podId),
          csvCell(row.scannerId),
          csvCell(row.capturedTitle),
          csvCell(row.timestamp.toISOString()),
        ].join(',') + '\n';
      }
      res.write(chunk);
      if (batch.length < BATCH) break;
      const lastRow = batch[batch.length - 1];
      if (!lastRow) break;
      cursor = { ts: lastRow.timestamp, id: lastRow.id };
    }
    res.end();
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

    const baseWhere = {
      ...(jobId ? { jobId } : {}),
      timestamp: { gte: startDate, lte: endDate },
    } as const;

    // Two queries: per-day buckets, and aggregate splits by type/source.
    const [perDay, byType, bySource, exceptionsCount] = await Promise.all([
      prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT date_trunc('day', "timestamp") AS day, COUNT(*) AS count
        FROM "Scan"
        WHERE "timestamp" >= ${startDate}
          AND "timestamp" <= ${endDate}
          AND (${jobId ?? null}::text IS NULL OR "jobId" = ${jobId ?? null})
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.scan.groupBy({
        by: ['type'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.scan.groupBy({
        by: ['source'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.exception.count({
        where: {
          ...(jobId ? { jobId } : {}),
          timestamp: { gte: startDate, lte: endDate },
        },
      }),
    ]);

    res.json({
      jobId: jobId ?? null,
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

  // GET /api/portal/presence
  // Returns all pod heartbeat rows. Replaces the portal's 10s-poll Firestore
  // listener on the entire `presence` collection. Adds a computed `isOnline`
  // flag (true when lastSeen is within the staleness window).
  r.get('/presence', async (_req: Request, res: Response) => {
    const rows = await prisma.presence.findMany({ orderBy: { podId: 'asc' } });
    const cutoff = Date.now() - 30_000; // 30s grace — heartbeat is every 10s
    const pods = rows.map((p) => ({
      ...p,
      isOnline: p.online && p.lastSeen ? p.lastSeen.getTime() >= cutoff : false,
    }));
    res.json({ pods });
  });

  // GET /api/portal/daily-breakdown?jobId=&start=ISO&end=ISO
  // Pre-bucketed exactly the way CustomerPortal renders it: per-day totals
  // split into regular / manual / aiCamera / exceptions (where exceptions =
  // both type='exception' scans and manual-exception docs from the Exception
  // table). One SQL query per source, server-side aggregation. Replaces the
  // 60-day full-collection Firestore listener that was pegging the browser.
  r.get('/daily-breakdown', async (req: Request, res: Response) => {
    const parsed = dailyBreakdownQuery.safeParse(req.query);
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
    const [scanRows, excRows] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          day: Date;
          regular: bigint;
          manual: bigint;
          ai_camera: bigint;
          type_exception: bigint;
        }>
      >`
        SELECT
          date_trunc('day', "timestamp") AS day,
          COUNT(*) FILTER (
            WHERE type = 'standard' AND ("source" IS NULL OR "source" NOT IN ('manual','ai-match'))
          ) AS regular,
          COUNT(*) FILTER (WHERE "source" = 'manual')   AS manual,
          COUNT(*) FILTER (WHERE "source" = 'ai-match') AS ai_camera,
          COUNT(*) FILTER (WHERE type = 'exception')    AS type_exception
        FROM "Scan"
        WHERE "jobId" = ${jobId}
          AND "timestamp" >= ${startDate}
          AND "timestamp" <= ${endDate}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.$queryRaw<Array<{ day: Date; manual_exceptions: bigint }>>`
        SELECT date_trunc('day', "timestamp") AS day, COUNT(*) AS manual_exceptions
        FROM "Exception"
        WHERE "jobId" = ${jobId}
          AND "timestamp" >= ${startDate}
          AND "timestamp" <= ${endDate}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    const byDay = new Map<
      string,
      {
        date: string;
        regular: number;
        manual: number;
        aiCamera: number;
        exceptions: number;
        total: number;
      }
    >();
    const ensure = (day: string) => {
      let row = byDay.get(day);
      if (!row) {
        row = { date: day, regular: 0, manual: 0, aiCamera: 0, exceptions: 0, total: 0 };
        byDay.set(day, row);
      }
      return row;
    };
    for (const row of scanRows) {
      const day = row.day.toISOString().slice(0, 10);
      const dst = ensure(day);
      dst.regular += Number(row.regular);
      dst.manual += Number(row.manual);
      dst.aiCamera += Number(row.ai_camera);
      dst.exceptions += Number(row.type_exception);
    }
    for (const row of excRows) {
      const day = row.day.toISOString().slice(0, 10);
      ensure(day).exceptions += Number(row.manual_exceptions);
    }
    for (const row of byDay.values()) {
      row.total = row.regular + row.manual + row.aiCamera + row.exceptions;
    }
    const breakdown = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
    res.json({ jobId, range: { start, end }, breakdown });
  });

  // GET /api/portal/operators?jobId=&since=&until=
  // Per-operator totals (scans + exceptions). jobId optional (cross-job
  // rollup). since/until optional for range-bounded queries. Replaces
  // JobHistory's habit of pulling every scan doc just to GROUP BY scannerId
  // in-browser, and powers the Reports per-operator breakdown.
  r.get('/operators', async (req: Request, res: Response) => {
    const parsed = operatorsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const { jobId, since, until } = parsed.data;
    const sinceDate = since ? new Date(since) : null;
    const untilDate = until ? new Date(until) : null;
    const rows = await prisma.$queryRaw<
      Array<{ scanner_id: string; scans: bigint; exceptions: bigint }>
    >`
      SELECT
        "scannerId" AS scanner_id,
        COUNT(*) AS scans,
        COUNT(*) FILTER (WHERE type = 'exception') AS exceptions
      FROM "Scan"
      WHERE "scannerId" IS NOT NULL AND "scannerId" <> ''
        AND (${jobId ?? null}::text IS NULL OR "jobId" = ${jobId ?? null})
        AND (${sinceDate}::timestamptz IS NULL OR "timestamp" >= ${sinceDate})
        AND (${untilDate}::timestamptz IS NULL OR "timestamp" <= ${untilDate})
      GROUP BY "scannerId"
      ORDER BY 2 DESC
    `;
    const operators = rows.map((row) => ({
      scannerId: row.scanner_id,
      scans: Number(row.scans),
      exceptions: Number(row.exceptions),
    }));
    res.json({ jobId: jobId ?? null, operators });
  });

  // GET /api/portal/operators/trends?jobId=&since=&until=
  // Per-operator PER-DAY buckets so the dashboard can render trend lines,
  // attendance (distinct active days), accuracy (exception rate) and the
  // manual/AI mix over time. Server-side aggregation — safe for big ranges.
  r.get('/operators/trends', async (req: Request, res: Response) => {
    const parsed = operatorsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const { jobId, since, until } = parsed.data;
    const sinceDate = since ? new Date(since) : null;
    const untilDate = until ? new Date(until) : null;
    const rows = await prisma.$queryRaw<
      Array<{ scanner_id: string; day: Date; scans: bigint; exceptions: bigint; manual: bigint; ai_camera: bigint }>
    >`
      SELECT
        "scannerId" AS scanner_id,
        date_trunc('day', "timestamp") AS day,
        COUNT(*) AS scans,
        COUNT(*) FILTER (WHERE type = 'exception') AS exceptions,
        COUNT(*) FILTER (WHERE "source" = 'manual') AS manual,
        COUNT(*) FILTER (WHERE "source" = 'ai-match') AS ai_camera
      FROM "Scan"
      WHERE "scannerId" IS NOT NULL AND "scannerId" <> ''
        AND (${jobId ?? null}::text IS NULL OR "jobId" = ${jobId ?? null})
        AND (${sinceDate}::timestamptz IS NULL OR "timestamp" >= ${sinceDate})
        AND (${untilDate}::timestamptz IS NULL OR "timestamp" <= ${untilDate})
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    const byOp = new Map<
      string,
      {
        scannerId: string;
        scans: number;
        exceptions: number;
        manual: number;
        aiCamera: number;
        daysActive: number;
        days: Array<{ date: string; scans: number; exceptions: number }>;
      }
    >();
    for (const row of rows) {
      const id = row.scanner_id;
      let op = byOp.get(id);
      if (!op) {
        op = { scannerId: id, scans: 0, exceptions: 0, manual: 0, aiCamera: 0, daysActive: 0, days: [] };
        byOp.set(id, op);
      }
      const scans = Number(row.scans);
      const exceptions = Number(row.exceptions);
      op.scans += scans;
      op.exceptions += exceptions;
      op.manual += Number(row.manual);
      op.aiCamera += Number(row.ai_camera);
      op.daysActive += 1;
      op.days.push({ date: row.day.toISOString().slice(0, 10), scans, exceptions });
    }
    const operators = Array.from(byOp.values())
      .map((op) => ({
        ...op,
        avgPerDay: op.daysActive ? Math.round(op.scans / op.daysActive) : 0,
        exceptionRate: op.scans ? op.exceptions / op.scans : 0,
      }))
      .sort((a, b) => b.scans - a.scans);
    res.json({ jobId: jobId ?? null, range: { since: since ?? null, until: until ?? null }, operators });
  });

  return r;
}
