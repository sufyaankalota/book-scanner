/**
 * Backfill aggregate counters for an existing job by streaming all scans
 * and exceptions and writing the totals to jobs/{jobId}/aggregates/totals.
 *
 * Usage:
 *   node scripts/backfill-aggregates.mjs <jobId>
 *
 * Auth: uses the firebase-tools access token from the local config.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'book-scanner-277a3';
const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: node scripts/backfill-aggregates.mjs <jobId>');
  process.exit(1);
}

const cfgPath = path.join(homedir(), '.config', 'configstore', 'firebase-tools.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const token = cfg.tokens?.access_token;
if (!token) { console.error('no firebase-tools access_token'); process.exit(1); }

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function runQuery(structuredQuery, pageToken) {
  const url = `${base}:runQuery`;
  const body = { structuredQuery };
  if (pageToken) body.partitionToken = pageToken;
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`runQuery ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function* streamAll(coll, jobId) {
  // runQuery returns all results in one stream — but for very large collections
  // we need to paginate via cursors. Use orderBy __name__ + startAfter.
  let lastName = null;
  const pageSize = 5000;
  while (true) {
    const sq = {
      from: [{ collectionId: coll }],
      where: {
        fieldFilter: { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: jobId } },
      },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize,
    };
    if (lastName) {
      sq.startAt = { values: [{ referenceValue: lastName }], before: false };
    }
    const rows = await runQuery(sq);
    let count = 0;
    for (const row of rows) {
      if (!row.document) continue;
      count++;
      lastName = row.document.name;
      yield row.document.fields || {};
    }
    if (count < pageSize) return;
  }
}

const totals = { totalScanned: 0, totalExceptions: 0, totalManual: 0, totalAiMatch: 0, totalManualExceptions: 0, byPO: {} };

console.log(`backfilling scans for job ${jobId}…`);
let scanCount = 0;
const seenIsbns = new Map(); // isbn → count
for await (const f of streamAll('scans', jobId)) {
  scanCount++;
  const type = f.type?.stringValue || 'standard';
  const source = f.source?.stringValue || null;
  const poName = f.poName?.stringValue || null;
  const isbn = f.isbn?.stringValue || null;
  if (type === 'standard') totals.totalScanned++;
  else if (type === 'exception') totals.totalExceptions++;
  if (source === 'manual') totals.totalManual++;
  if (source === 'ai-match') totals.totalAiMatch++;
  if (type === 'standard' && poName) totals.byPO[poName] = (totals.byPO[poName] || 0) + 1;
  if (isbn) seenIsbns.set(isbn, (seenIsbns.get(isbn) || 0) + 1);
  if (scanCount % 5000 === 0) console.log(`  scanned ${scanCount}`);
}
console.log(`scans done: ${scanCount}`);

console.log(`backfilling exceptions for job ${jobId}…`);
let excCount = 0;
for await (const f of streamAll('exceptions', jobId)) {
  excCount++;
  totals.totalManualExceptions++;
  const isbn = f.isbn?.stringValue || null;
  if (isbn) seenIsbns.set(isbn, (seenIsbns.get(isbn) || 0) + 1);
}
console.log(`exceptions done: ${excCount}`);

// Write aggregate doc
const aggUrl = `${base}/jobs/${jobId}/aggregates/totals`;
const fields = {
  totalScanned: { integerValue: totals.totalScanned },
  totalExceptions: { integerValue: totals.totalExceptions },
  totalManual: { integerValue: totals.totalManual },
  totalAiMatch: { integerValue: totals.totalAiMatch },
  totalManualExceptions: { integerValue: totals.totalManualExceptions },
  byPO: { mapValue: { fields: Object.fromEntries(Object.entries(totals.byPO).map(([k, v]) => [k, { integerValue: v }])) } },
  updatedAt: { timestampValue: new Date().toISOString() },
};
const r = await fetch(aggUrl, { method: 'PATCH', headers, body: JSON.stringify({ fields }) });
if (!r.ok) console.error('write aggregate failed:', await r.text());
else console.log('aggregate written:', JSON.stringify(totals, null, 2));

// Write per-ISBN markers in batches via commit
console.log(`writing ${seenIsbns.size} ISBN markers…`);
const isbns = Array.from(seenIsbns.entries());
const BATCH = 400;
const commitUrl = `${base}:commit`;
for (let i = 0; i < isbns.length; i += BATCH) {
  const slice = isbns.slice(i, i + BATCH);
  const writes = slice.map(([isbn, count]) => ({
    update: {
      name: `projects/${PROJECT}/databases/(default)/documents/jobs/${jobId}/scanned-isbns/${isbn}`,
      fields: {
        count: { integerValue: count },
        firstSeen: { timestampValue: new Date().toISOString() },
      },
    },
  }));
  const cr = await fetch(commitUrl, { method: 'POST', headers, body: JSON.stringify({ writes }) });
  if (!cr.ok) { console.error('commit failed:', await cr.text()); process.exit(1); }
  if ((i + BATCH) % 4000 === 0 || i + BATCH >= isbns.length) console.log(`  markers ${Math.min(i + BATCH, isbns.length)}/${isbns.length}`);
}
console.log('done.');
