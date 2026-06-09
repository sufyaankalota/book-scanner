/**
 * Cloud Function: exportJobReport
 *
 * Returns an XLSX file with scans and/or exceptions for a job. Replaces the
 * customer portal's old client-side XLSX export which is bounded to the
 * last-60-days live subscription. This pulls directly from Firestore so it
 * covers the entire job lifetime with no client RAM constraint.
 *
 * Query params:
 *   jobId    (required)  — job document ID
 *   type     (optional)  — 'scans' | 'exceptions' | 'both' (default 'both')
 *   startDate (optional) — ISO date 'YYYY-MM-DD' (inclusive, UTC midnight)
 *   endDate   (optional) — ISO date 'YYYY-MM-DD' (exclusive, UTC midnight next day)
 *   poName    (optional) — filter scans + exceptions to a single PO (substring match)
 *
 * Hard cap: 250k total rows per report. Beyond that the response asks the
 * caller to narrow the date range. XLSX generation holds all rows in memory
 * so unbounded reports would crash the function instance.
 *
 * No auth: the same Firestore rules allow reads of scans/exceptions/jobs
 * publicly today (see firestore.rules), so this endpoint does not introduce
 * any new data exposure beyond what already exists via the SDK.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const XLSX = require('xlsx');

const MAX_ROWS = 250_000;

function parseDateUtc(s, endOfDay = false) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (endOfDay) d.setUTCDate(d.getUTCDate() + 1); // exclusive upper bound
  return d;
}

function bucketSource(s) {
  if (s.source === 'ai-match') return 'AI Camera ($0.85)';
  if (s.source === 'manual') return 'Manual Entry ($0.85)';
  return 'Regular Scan ($0.50)';
}

function tsIso(ts) {
  const d = ts?.toDate?.();
  if (!d) return '';
  return d.toISOString();
}

function tsHuman(ts) {
  const d = ts?.toDate?.();
  if (!d) return '';
  // Render in US Eastern for customer reports (warehouse local time).
  return d.toLocaleString('en-US', { timeZone: 'America/New_York' });
}

async function fetchAll(query, label) {
  // Stream the cursor in chunks of 1000 to bound memory peaks. Firestore
  // .get() on a huge query loads everything at once; using .orderBy +
  // .startAfter we walk the doc set in pages and concat the results.
  const PAGE = 1000;
  const out = [];
  let cursor = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = query.limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    if (out.length > MAX_ROWS) {
      const err = new Error(`${label} exceeded ${MAX_ROWS} rows — narrow the date range`);
      err.tooLarge = true;
      throw err;
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return out;
}

exports.exportJobReport = onRequest({
  region: 'us-east1',
  cors: true,
  invoker: 'public',
  memory: '1GiB',
  timeoutSeconds: 540,
  // Reports run on customer demand — bump concurrency low so a single big
  // export doesn't crowd out parallel small ones.
  concurrency: 4,
}, async (req, res) => {
  try {
    const db = getFirestore();
    const jobId = String(req.query.jobId || '').trim();
    const type = (String(req.query.type || 'both').toLowerCase());
    const startDate = parseDateUtc(req.query.startDate, false);
    const endDate = parseDateUtc(req.query.endDate, true);
    const poName = String(req.query.poName || '').trim().toLowerCase();

    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    if (!['scans', 'exceptions', 'both'].includes(type)) {
      return res.status(400).json({ error: "type must be 'scans', 'exceptions', or 'both'" });
    }

    // Confirm job exists (and grab name for filename + summary sheet).
    const jobSnap = await db.doc(`jobs/${jobId}`).get();
    if (!jobSnap.exists) return res.status(404).json({ error: 'job not found' });
    const jobName = jobSnap.data()?.meta?.name || jobId;

    // Build per-collection queries with optional date bounds. The collection
    // already has a (jobId, timestamp) composite index so this is efficient.
    function build(coll) {
      let q = db.collection(coll).where('jobId', '==', jobId);
      if (startDate) q = q.where('timestamp', '>=', Timestamp.fromDate(startDate));
      if (endDate) q = q.where('timestamp', '<', Timestamp.fromDate(endDate));
      return q.orderBy('timestamp', 'asc');
    }

    const wantScans = type === 'scans' || type === 'both';
    const wantExceptions = type === 'exceptions' || type === 'both';

    const [scans, exceptions] = await Promise.all([
      wantScans ? fetchAll(build('scans'), 'scans') : Promise.resolve([]),
      wantExceptions ? fetchAll(build('exceptions'), 'exceptions') : Promise.resolve([]),
    ]);

    // PO filter is applied in-memory because Firestore can't combine the
    // (jobId, timestamp range) range query with a poName equality. Cost is
    // the round-trip of the rows we ultimately drop — usually small.
    const poMatch = (val) => !poName || String(val || '').toLowerCase().includes(poName);
    const filteredScans = poName ? scans.filter((s) => poMatch(s.poName)) : scans;
    const filteredExceptions = poName ? exceptions.filter((e) => poMatch(e.poName)) : exceptions;

    const wb = XLSX.utils.book_new();

    if (wantScans) {
      const standard = filteredScans.filter((s) => s.type === 'standard');
      const rows = standard.map((s) => ({
        ISBN: s.isbn || '',
        PO: s.poName || '',
        Category: bucketSource(s),
        'Captured Title': s.capturedTitle || '',
        'Match Score': s.matchScore != null ? Number(s.matchScore).toFixed(2) : '',
        Pod: s.podId || '',
        Operator: s.scannerId || '',
        'Timestamp (ET)': tsHuman(s.timestamp),
        'Timestamp (ISO)': tsIso(s.timestamp),
      }));
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No scans in range' }]),
        'Scans',
      );
    }

    if (wantExceptions) {
      // Auto exceptions live in the scans collection as type=exception (not in
      // manifest). Manual exceptions live in the exceptions collection. Merge.
      const autoExc = filteredScans.filter((s) => s.type === 'exception');
      const rows = [
        ...autoExc.map((s) => ({
          ISBN: s.isbn || '',
          Title: s.capturedTitle || '',
          Reason: 'Not in Manifest',
          PO: s.poName || '',
          Pod: s.podId || '',
          Operator: s.scannerId || '',
          'Timestamp (ET)': tsHuman(s.timestamp),
          'Timestamp (ISO)': tsIso(s.timestamp),
          Source: 'auto',
        })),
        ...filteredExceptions.map((ex) => ({
          ISBN: ex.isbn || '',
          Title: ex.title || '',
          Reason: ex.reason || '',
          PO: ex.poName || '',
          Pod: ex.podId || '',
          Operator: ex.scannerId || '',
          'Timestamp (ET)': tsHuman(ex.timestamp),
          'Timestamp (ISO)': tsIso(ex.timestamp),
          Source: 'manual',
        })),
      ];
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No exceptions in range' }]),
        'Exceptions',
      );
    }

    // Summary sheet — counts + filter metadata so the spreadsheet is
    // self-describing when the customer opens it weeks later.
    const summary = [
      { Metric: 'Job', Value: jobName },
      { Metric: 'Job ID', Value: jobId },
      { Metric: 'Generated', Value: new Date().toISOString() },
      { Metric: 'Date Range Start', Value: startDate ? startDate.toISOString().slice(0, 10) : '(job start)' },
      { Metric: 'Date Range End', Value: endDate
        ? new Date(endDate.getTime() - 1).toISOString().slice(0, 10)
        : '(today)' },
      { Metric: 'PO Filter', Value: poName || '(none)' },
      { Metric: 'Report Type', Value: type },
    ];
    if (wantScans) {
      const standard = filteredScans.filter((s) => s.type === 'standard');
      const reg = standard.filter((s) => !['ai-match', 'manual'].includes(s.source)).length;
      const manual = standard.filter((s) => s.source === 'manual').length;
      const ai = standard.filter((s) => s.source === 'ai-match').length;
      summary.push(
        { Metric: 'Total Standard Scans', Value: standard.length },
        { Metric: '  Regular ($0.50)', Value: reg },
        { Metric: '  Manual ($0.85)', Value: manual },
        { Metric: '  AI Camera ($0.85)', Value: ai },
      );
    }
    if (wantExceptions) {
      const autoExc = filteredScans.filter((s) => s.type === 'exception').length;
      summary.push(
        { Metric: 'Total Exceptions (auto, not in manifest)', Value: autoExc },
        { Metric: 'Total Exceptions (manual)', Value: filteredExceptions.length },
      );
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    const safeJobName = jobName.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
    const dateTag = [
      startDate ? startDate.toISOString().slice(0, 10) : 'start',
      endDate ? new Date(endDate.getTime() - 1).toISOString().slice(0, 10) : 'today',
    ].join('_to_');
    const typeTag = type;
    const fileName = `${safeJobName}_${typeTag}_${dateTag}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buf);
  } catch (err) {
    if (err.tooLarge) {
      return res.status(413).json({ error: err.message, tooLarge: true });
    }
    console.error('exportJobReport failed:', err);
    res.status(500).json({ error: err.message || 'export failed' });
  }
});
