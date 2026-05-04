/**
 * Programmatic exception export with photo URLs.
 *
 * Exception photos are written as inline base64 in Firestore (exceptions/{id}.photo).
 * For customer integrations we don't want to ship megabytes of base64 — instead
 * we lazy-migrate each photo to Cloud Storage at exceptions/{jobId}/{id}.jpg,
 * cache the signed URL on the doc, and return a flat JSON list with photoUrl.
 *
 * Subsequent calls reuse the existing storage object + URL (cached on the doc
 * as photoPath + photoUrl).
 */
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

// 10-year signed URL — exception photos are part of the customer audit trail.
const SIGNED_URL_EXPIRES = '03-01-2036';
const EXCEPTIONS_BUCKET = process.env.EXCEPTIONS_BUCKET || 'book-scanner-277a3-exceptions';

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { contentType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

async function migratePhotoToStorage(exceptionId, jobId, photoDataUrl) {
  const parsed = parseDataUrl(photoDataUrl);
  if (!parsed) return null;
  const ext = (parsed.contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const path = `exceptions/${jobId}/${exceptionId}.${ext}`;
  const bucket = getStorage().bucket(EXCEPTIONS_BUCKET);
  const file = bucket.file(path);
  await file.save(parsed.buffer, {
    contentType: parsed.contentType,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
  const [url] = await file.getSignedUrl({ action: 'read', expires: SIGNED_URL_EXPIRES });
  return { path, url, contentType: parsed.contentType, bytes: parsed.buffer.length };
}

/**
 * @param {string} jobId
 * @param {{since?: number, until?: number, limit?: number}} opts
 * @returns {Promise<{exceptions: Array, jobId: string}>}
 */
async function getExceptionsWithPhotoUrls(jobId, opts = {}) {
  if (!jobId) throw new Error('jobId is required');
  const db = getFirestore();
  let q = db.collection('exceptions').where('jobId', '==', jobId);
  if (opts.since) q = q.where('timestamp', '>=', Timestamp.fromMillis(Number(opts.since)));
  if (opts.until) q = q.where('timestamp', '<=', Timestamp.fromMillis(Number(opts.until)));
  q = q.orderBy('timestamp', 'desc');
  if (opts.limit) q = q.limit(Math.min(Number(opts.limit), 5000));
  const snap = await q.get();

  const out = [];
  for (const docSnap of snap.docs) {
    const ex = docSnap.data();
    let photoUrl = ex.photoUrl || null;
    let photoPath = ex.photoPath || null;
    let migrated = false;
    if (!photoUrl && ex.photo && typeof ex.photo === 'string' && ex.photo.startsWith('data:')) {
      try {
        const m = await migratePhotoToStorage(docSnap.id, jobId, ex.photo);
        if (m) {
          photoUrl = m.url;
          photoPath = m.path;
          migrated = true;
          // Cache on the doc and clear inline base64 to free Firestore space.
          await docSnap.ref.update({ photoUrl, photoPath, photo: null });
        }
      } catch (err) {
        console.warn(`migrate photo failed for ${docSnap.id}: ${err.message}`);
      }
    }
    out.push({
      id: docSnap.id,
      jobId: ex.jobId || null,
      podId: ex.podId || null,
      scannerId: ex.scannerId || null,
      isbn: ex.isbn || null,
      title: ex.title || null,
      reason: ex.reason || null,
      timestamp: ex.timestamp?.toDate?.()?.toISOString() || null,
      timestampMs: ex.timestamp?.toMillis?.() || null,
      photoUrl,
      photoPath,
      photoMigrated: migrated,
    });
  }
  return { jobId, count: out.length, exceptions: out };
}

module.exports = { getExceptionsWithPhotoUrls };
