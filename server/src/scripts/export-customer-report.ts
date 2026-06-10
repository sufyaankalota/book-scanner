/* eslint-disable no-console */
// Customer export — streams scans + exceptions for a job/date range to CSV.
// Uses batched findMany with id-cursor pagination (no offset, scales to
// millions of rows). Output: <outDir>/<jobId>_<start>_<end>_<table>.csv
//
// Usage (PowerShell):
//   $env:DATABASE_URL = "postgresql://..."
//   $env:JOB_ID = "job_1777780134130"
//   $env:START_DATE = "2026-05-01"          # inclusive (UTC 00:00:00)
//   $env:END_DATE   = "2026-06-08"          # inclusive (UTC 23:59:59.999)
//   $env:OUT_DIR    = "C:\Users\sufya\Desktop\customer-export"
//   npx tsx server/src/scripts/export-customer-report.ts

import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../lib/prisma';

const JOB_ID = process.env.JOB_ID ?? 'job_1777780134130';
const START_DATE = process.env.START_DATE ?? '2026-05-01';
const END_DATE = process.env.END_DATE ?? '2026-06-08';
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), 'exports');
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? '10000');

mkdirSync(OUT_DIR, { recursive: true });

const start = new Date(`${START_DATE}T00:00:00.000Z`);
const end = new Date(`${END_DATE}T23:59:59.999Z`);

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  // RFC4180: wrap in quotes if contains comma, quote, CR, or LF; escape quotes.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\n';
}

async function exportScans(): Promise<{ rows: number; path: string }> {
  const filename = `${JOB_ID}_${START_DATE}_to_${END_DATE}_scans.csv`;
  const path = join(OUT_DIR, filename);
  const out = createWriteStream(path, { encoding: 'utf8' });
  const headers = [
    'id',
    'jobId',
    'podId',
    'scannerId',
    'isbn',
    'poName',
    'type',
    'source',
    'capturedTitle',
    'matchScore',
    'duplicateOverride',
    'timestamp',
  ];
  out.write(csvLine(headers));

  let total = 0;
  let cursorId: string | null = null;
  // Stream in id-asc batches. id is the Firestore doc id which is sortable
  // (push-id style), so this is stable and avoids OFFSET.
  while (true) {
    const batch: Array<{
      id: string;
      jobId: string;
      podId: string;
      scannerId: string;
      isbn: string;
      poName: string | null;
      type: string;
      source: string | null;
      capturedTitle: string | null;
      matchScore: number | null;
      duplicateOverride: boolean | null;
      timestamp: Date;
    }> = await prisma.scan.findMany({
      where: {
        jobId: JOB_ID,
        timestamp: { gte: start, lte: end },
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        jobId: true,
        podId: true,
        scannerId: true,
        isbn: true,
        poName: true,
        type: true,
        source: true,
        capturedTitle: true,
        matchScore: true,
        duplicateOverride: true,
        timestamp: true,
      },
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      out.write(
        csvLine([
          row.id,
          row.jobId,
          row.podId,
          row.scannerId,
          row.isbn,
          row.poName,
          row.type,
          row.source,
          row.capturedTitle,
          row.matchScore,
          row.duplicateOverride,
          row.timestamp,
        ]),
      );
    }
    total += batch.length;
    const lastRow = batch[batch.length - 1];
    if (!lastRow) break;
    cursorId = lastRow.id;
    if (total % 50_000 === 0 || batch.length < BATCH_SIZE) {
      console.log(`  scans: ${total.toLocaleString()} rows written`);
    }
    if (batch.length < BATCH_SIZE) break;
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
  return { rows: total, path };
}

async function exportExceptions(): Promise<{ rows: number; path: string }> {
  const filename = `${JOB_ID}_${START_DATE}_to_${END_DATE}_exceptions.csv`;
  const path = join(OUT_DIR, filename);
  const out = createWriteStream(path, { encoding: 'utf8' });
  const headers = ['id', 'jobId', 'podId', 'scannerId', 'isbn', 'title', 'reason', 'hasPhoto', 'timestamp'];
  out.write(csvLine(headers));

  let total = 0;
  let cursorId: string | null = null;
  while (true) {
    const batch: Array<{
      id: string;
      jobId: string;
      podId: string;
      scannerId: string | null;
      isbn: string | null;
      title: string | null;
      reason: string;
      hasPhoto: boolean;
      timestamp: Date;
    }> = await prisma.exception.findMany({
      where: {
        jobId: JOB_ID,
        timestamp: { gte: start, lte: end },
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        jobId: true,
        podId: true,
        scannerId: true,
        isbn: true,
        title: true,
        reason: true,
        hasPhoto: true,
        timestamp: true,
      },
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      out.write(
        csvLine([
          row.id,
          row.jobId,
          row.podId,
          row.scannerId,
          row.isbn,
          row.title,
          row.reason,
          row.hasPhoto,
          row.timestamp,
        ]),
      );
    }
    total += batch.length;
    const lastRow = batch[batch.length - 1];
    if (!lastRow) break;
    cursorId = lastRow.id;
    if (total % 10_000 === 0 || batch.length < BATCH_SIZE) {
      console.log(`  exceptions: ${total.toLocaleString()} rows written`);
    }
    if (batch.length < BATCH_SIZE) break;
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
  return { rows: total, path };
}

async function exportDailySummary(): Promise<{ rows: number; path: string }> {
  const filename = `${JOB_ID}_${START_DATE}_to_${END_DATE}_daily_summary.csv`;
  const path = join(OUT_DIR, filename);
  const out = createWriteStream(path, { encoding: 'utf8' });

  // Server-side per-day aggregation — single round trip.
  const rows = await prisma.$queryRaw<
    Array<{
      day: Date;
      total_scans: bigint;
      standard_scans: bigint;
      exception_scans: bigint;
      manual_scans: bigint;
      ai_match_scans: bigint;
      distinct_pods: bigint;
      distinct_scanners: bigint;
    }>
  >`
    SELECT
      date_trunc('day', "timestamp") AS day,
      COUNT(*)                            AS total_scans,
      COUNT(*) FILTER (WHERE type = 'standard')   AS standard_scans,
      COUNT(*) FILTER (WHERE type = 'exception')  AS exception_scans,
      COUNT(*) FILTER (WHERE source = 'manual')   AS manual_scans,
      COUNT(*) FILTER (WHERE source = 'ai-match') AS ai_match_scans,
      COUNT(DISTINCT "podId")             AS distinct_pods,
      COUNT(DISTINCT "scannerId")         AS distinct_scanners
    FROM "Scan"
    WHERE "jobId" = ${JOB_ID}
      AND "timestamp" >= ${start}
      AND "timestamp" <= ${end}
    GROUP BY 1
    ORDER BY 1
  `;

  // Pull per-day exception counts in parallel.
  const exRows = await prisma.$queryRaw<Array<{ day: Date; manual_exceptions: bigint }>>`
    SELECT date_trunc('day', "timestamp") AS day, COUNT(*) AS manual_exceptions
    FROM "Exception"
    WHERE "jobId" = ${JOB_ID}
      AND "timestamp" >= ${start}
      AND "timestamp" <= ${end}
    GROUP BY 1
    ORDER BY 1
  `;
  const exByDay = new Map<string, bigint>();
  for (const r of exRows) exByDay.set(r.day.toISOString().slice(0, 10), r.manual_exceptions);

  out.write(
    csvLine([
      'date',
      'total_scans',
      'standard_scans',
      'auto_exceptions',
      'manual_exceptions',
      'manual_match_scans',
      'ai_match_scans',
      'distinct_pods',
      'distinct_scanners',
    ]),
  );
  for (const r of rows) {
    const day = r.day.toISOString().slice(0, 10);
    out.write(
      csvLine([
        day,
        Number(r.total_scans),
        Number(r.standard_scans),
        Number(r.exception_scans),
        Number(exByDay.get(day) ?? 0n),
        Number(r.manual_scans),
        Number(r.ai_match_scans),
        Number(r.distinct_pods),
        Number(r.distinct_scanners),
      ]),
    );
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
  return { rows: rows.length, path };
}

async function exportByPo(): Promise<{ rows: number; path: string }> {
  const filename = `${JOB_ID}_${START_DATE}_to_${END_DATE}_by_po.csv`;
  const path = join(OUT_DIR, filename);
  const out = createWriteStream(path, { encoding: 'utf8' });

  const rows = await prisma.$queryRaw<
    Array<{
      po_name: string | null;
      total_scans: bigint;
      standard_scans: bigint;
      exception_scans: bigint;
      manual_scans: bigint;
      ai_match_scans: bigint;
    }>
  >`
    SELECT
      "poName"                                    AS po_name,
      COUNT(*)                                    AS total_scans,
      COUNT(*) FILTER (WHERE type = 'standard')   AS standard_scans,
      COUNT(*) FILTER (WHERE type = 'exception')  AS exception_scans,
      COUNT(*) FILTER (WHERE source = 'manual')   AS manual_scans,
      COUNT(*) FILTER (WHERE source = 'ai-match') AS ai_match_scans
    FROM "Scan"
    WHERE "jobId" = ${JOB_ID}
      AND "timestamp" >= ${start}
      AND "timestamp" <= ${end}
    GROUP BY 1
    ORDER BY total_scans DESC NULLS LAST
  `;
  out.write(
    csvLine(['po_name', 'total_scans', 'standard_scans', 'exception_scans', 'manual_scans', 'ai_match_scans']),
  );
  for (const r of rows) {
    out.write(
      csvLine([
        r.po_name,
        Number(r.total_scans),
        Number(r.standard_scans),
        Number(r.exception_scans),
        Number(r.manual_scans),
        Number(r.ai_match_scans),
      ]),
    );
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
  return { rows: rows.length, path };
}

(async () => {
  console.log('Customer export');
  console.log(`  job:    ${JOB_ID}`);
  console.log(`  start:  ${start.toISOString()}`);
  console.log(`  end:    ${end.toISOString()}`);
  console.log(`  outDir: ${OUT_DIR}`);
  console.log('');

  const t0 = Date.now();
  console.log('1) daily summary');
  const ds = await exportDailySummary();
  console.log(`   wrote ${ds.rows} days -> ${ds.path}`);

  console.log('2) per-PO breakdown');
  const po = await exportByPo();
  console.log(`   wrote ${po.rows} POs -> ${po.path}`);

  console.log('3) all exceptions (manual)');
  const ex = await exportExceptions();
  console.log(`   wrote ${ex.rows.toLocaleString()} rows -> ${ex.path}`);

  console.log('4) all scans (this is the big one)');
  const sc = await exportScans();
  console.log(`   wrote ${sc.rows.toLocaleString()} rows -> ${sc.path}`);

  const seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`\nDone in ${seconds}s. Files in: ${OUT_DIR}`);
  await prisma.$disconnect();
})().catch((err) => {
  console.error('export failed:', err);
  process.exit(1);
});
