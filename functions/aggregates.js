/**
 * Firestore trigger to maintain a small aggregate counter doc per job.
 *
 * Rationale: long-running jobs accumulate millions of `scans` docs.
 * Subscribing every dashboard / pod browser to the full collection would
 * eventually OOM the client and burn quota. Instead we maintain a single
 * `jobs/{jobId}/aggregates/totals` doc and have UIs subscribe to that.
 *
 * Schema:
 *   {
 *     totalScanned: number,        // type=standard
 *     totalExceptions: number,     // type=exception (auto, in-manifest miss)
 *     totalManual: number,         // source=manual
 *     totalAiMatch: number,        // source=ai-match
 *     byPO: { [poName]: number },  // standard scans per PO
 *     updatedAt: Timestamp,
 *   }
 *
 * Per-ISBN dedup is handled separately by `jobs/{jobId}/scanned-isbns/{isbn}`
 * counter shards: we only need to know whether an ISBN has been scanned
 * before, not the exact count, so a single doc-per-isbn is sufficient.
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');

function classify(data) {
  if (!data) return null;
  const type = data.type || 'standard';
  const source = data.source || null;
  return { type, source, isbn: data.isbn || null, jobId: data.jobId || null, poName: data.poName || null };
}

exports.onScanWrite = onDocumentWritten({
  document: 'scans/{scanId}',
  region: 'us-east1',
  // Critical path — keep it lean. Same instance handles many writes.
  memory: '256MiB',
  timeoutSeconds: 60,
  maxInstances: 20,
  concurrency: 80,
  retry: false,
}, async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  const delta = after && !before ? +1 : (!after && before ? -1 : 0);
  if (!delta) return; // updates don't move counters

  const cur = classify(after) || classify(before);
  if (!cur?.jobId) return;
  const db = getFirestore();
  const aggRef = db.doc(`jobs/${cur.jobId}/aggregates/totals`);
  const update = { updatedAt: FieldValue.serverTimestamp() };
  if (cur.type === 'standard') update.totalScanned = FieldValue.increment(delta);
  else if (cur.type === 'exception') update.totalExceptions = FieldValue.increment(delta);
  if (cur.source === 'manual') update.totalManual = FieldValue.increment(delta);
  if (cur.source === 'ai-match') update.totalAiMatch = FieldValue.increment(delta);
  if (cur.type === 'standard' && cur.poName) {
    update[`byPO.${cur.poName}`] = FieldValue.increment(delta);
  }
  await aggRef.set(update, { merge: true });

  // Per-ISBN dedup marker (only on creation; deletion would race with other
  // dup scans of the same ISBN, so we leave the marker even if undone — a
  // false-positive overscan warning is recoverable, a missed one isn't).
  if (delta > 0 && cur.isbn && cur.type === 'standard') {
    try {
      await db.doc(`jobs/${cur.jobId}/scanned-isbns/${cur.isbn}`).set({
        firstSeen: FieldValue.serverTimestamp(),
        count: FieldValue.increment(1),
      }, { merge: true });
    } catch (err) {
      console.warn('isbn marker failed:', err.message);
    }
  } else if (delta > 0 && cur.isbn) {
    // exceptions still get a marker so re-scans warn
    try {
      await db.doc(`jobs/${cur.jobId}/scanned-isbns/${cur.isbn}`).set({
        firstSeen: FieldValue.serverTimestamp(),
        count: FieldValue.increment(1),
      }, { merge: true });
    } catch (err) { /* noop */ }
  }
});

exports.onExceptionWrite = onDocumentWritten({
  document: 'exceptions/{excId}',
  region: 'us-east1',
  memory: '256MiB',
  timeoutSeconds: 30,
  maxInstances: 10,
  concurrency: 80,
  retry: false,
}, async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  const delta = after && !before ? +1 : (!after && before ? -1 : 0);
  if (!delta) return;
  const jobId = (after || before)?.jobId;
  if (!jobId) return;
  const db = getFirestore();
  await db.doc(`jobs/${jobId}/aggregates/totals`).set({
    totalManualExceptions: FieldValue.increment(delta),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
});
