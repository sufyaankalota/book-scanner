/**
 * One-off: walk every existing job + po-upload manifest and add ISBN-10/13
 * sibling rows in place. Same logic as the Setup-page button, but runs
 * server-side via the Firebase JS SDK.
 *
 * Usage:
 *   node scripts/backfill-isbn-pairs.mjs                # backfill everything
 *   node scripts/backfill-isbn-pairs.mjs jobs/abc123    # one parent path
 */
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.runtime' });

import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, doc, getDoc, getDocs, writeBatch,
} from 'firebase/firestore';
const cfg = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};
for (const [k, v] of Object.entries(cfg)) {
  if (!v) { console.error(`Missing env: VITE_FIREBASE_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`); process.exit(1); }
}
const app = initializeApp(cfg);
const db = getFirestore(app);

// ── ISBN helpers (mirrors src/utils/isbn.js) ──
function isbn13To10(c) {
  if (!c || c.length !== 13 || !/^\d{13}$/.test(c) || !c.startsWith('978')) return null;
  const core = c.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(core[i], 10) * (10 - i);
  const cd = (11 - (sum % 11)) % 11;
  return core + (cd === 10 ? 'X' : String(cd));
}
function isbn10To13(c) {
  if (!c || c.length !== 10 || !/^\d{9}[\dX]$/.test(c)) return null;
  const core = '978' + c.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(core[i], 10) * (i % 2 === 0 ? 1 : 3);
  const cd = (10 - (sum % 10)) % 10;
  return core + String(cd);
}
function isbnAlternates(isbn) {
  if (!isbn) return { isbn13: null, isbn10: null };
  const c = String(isbn).replace(/[-\s]/g, '').trim().toUpperCase();
  if (c.length === 13) return { isbn13: c, isbn10: isbn13To10(c) };
  if (c.length === 10) return { isbn13: isbn10To13(c), isbn10: c };
  return { isbn13: null, isbn10: null };
}

// ── Hash helper (must match manifestStore.js exactly) ──
function hashIsbn(isbn, numChunks) {
  let h = 0;
  for (let i = 0; i < isbn.length; i++) {
    h = (h * 31 + isbn.charCodeAt(i)) | 0;
  }
  return ((h % numChunks) + numChunks) % numChunks;
}

const READ_PAR = 16;     // parallel reads per page
const WRITE_BATCH = 30;  // chunk docs per write batch (large maps → conservative)

async function backfill(parentPath, numChunks) {
  console.log(`\n[${parentPath}] starting (numChunks=${numChunks})`);
  if (!numChunks) { console.log(`  [skip] not chunked`); return; }

  // 1. Read all chunks
  const chunkData = new Map(); // idx -> { id, isbns }
  let hadTitlesBefore = false;
  for (let start = 0; start < numChunks; start += READ_PAR) {
    const end = Math.min(start + READ_PAR, numChunks);
    const reads = [];
    for (let i = start; i < end; i++) {
      reads.push(getDoc(doc(db, parentPath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`)));
    }
    const snaps = await Promise.all(reads);
    snaps.forEach((snap, k) => {
      const idx = start + k;
      if (snap.exists()) {
        const isbns = snap.data().isbns || {};
        chunkData.set(idx, { id: snap.id, isbns });
        if (!hadTitlesBefore) {
          for (const v of Object.values(isbns)) {
            if (v && typeof v === 'object' && v.t) { hadTitlesBefore = true; break; }
          }
        }
      }
    });
    process.stdout.write(`\r  read ${end}/${numChunks}`);
  }
  process.stdout.write('\n');

  // 2. Decide additions
  const additions = new Map(); // destIdx -> { siblingIsbn -> entry }
  let read = 0, added = 0;
  for (const { isbns } of chunkData.values()) {
    for (const [isbn, raw] of Object.entries(isbns)) {
      read++;
      const po = typeof raw === 'string' ? raw : raw?.p;
      const title = typeof raw === 'string' ? null : (raw?.t || null);
      if (!po) continue;
      const { isbn13, isbn10 } = isbnAlternates(isbn);
      const sibling = isbn === isbn13 ? isbn10 : isbn13;
      if (!sibling || sibling === isbn) continue;
      const sibIdx = hashIsbn(sibling, numChunks);
      const sibChunk = chunkData.get(sibIdx);
      const existingInChunk = sibChunk?.isbns?.[sibling];
      const existingInAdditions = additions.get(sibIdx)?.[sibling];
      const existing = existingInAdditions ?? existingInChunk;
      if (existing == null) {
        if (!additions.has(sibIdx)) additions.set(sibIdx, {});
        additions.get(sibIdx)[sibling] = title ? { p: po, t: title } : po;
        added++;
      } else if (title) {
        const existingTitle = typeof existing === 'string' ? null : existing.t;
        const existingPo = typeof existing === 'string' ? existing : existing.p;
        if (!existingTitle && existingPo) {
          if (!additions.has(sibIdx)) additions.set(sibIdx, {});
          additions.get(sibIdx)[sibling] = { p: existingPo, t: title };
          added++;
        }
      }
    }
  }
  console.log(`  read ${read.toLocaleString()} entries, +${added.toLocaleString()} sibling additions across ${additions.size} chunks`);
  if (added === 0) { console.log(`  [done] nothing to do (already paired)`); return { read, added, chunksTouched: 0 }; }

  // 3. Write back
  const dirtyIdxs = [...additions.keys()];
  let written = 0;
  for (let i = 0; i < dirtyIdxs.length; i += WRITE_BATCH) {
    const batch = writeBatch(db);
    const slice = dirtyIdxs.slice(i, i + WRITE_BATCH);
    for (const idx of slice) {
      const existing = chunkData.get(idx)?.isbns || {};
      const merged = { ...existing, ...additions.get(idx) };
      const chunkId = chunkData.get(idx)?.id || `c${String(idx).padStart(5, '0')}`;
      batch.set(doc(db, parentPath, 'manifest-chunks', chunkId), { isbns: merged });
    }
    await batch.commit();
    written += slice.length;
    process.stdout.write(`\r  written ${written}/${dirtyIdxs.length}`);
  }
  process.stdout.write('\n');
  console.log(`  [done] paired in place`);
  return { read, added, chunksTouched: dirtyIdxs.length };
}

async function main() {
  const arg = process.argv[2];
  const targets = [];

  if (arg) {
    // Single path mode — fetch parent doc for numChunks
    const [coll, id] = arg.split('/');
    const parent = await getDoc(doc(db, coll, id));
    if (!parent.exists()) { console.error(`Path not found: ${arg}`); process.exit(1); }
    targets.push({ path: arg, numChunks: parent.data().manifestMeta?.numChunks, label: parent.data().meta?.name || parent.data().poNames?.join(',') || id });
  } else {
    // All jobs + uploads
    const jobs = await getDocs(collection(db, 'jobs'));
    for (const j of jobs.docs) {
      const m = j.data().manifestMeta;
      if (m?.chunked && m?.numChunks) {
        targets.push({ path: `jobs/${j.id}`, numChunks: m.numChunks, label: j.data().meta?.name || j.id });
      }
    }
    const uploads = await getDocs(collection(db, 'po-uploads'));
    for (const u of uploads.docs) {
      const m = u.data().manifestMeta;
      if (m?.chunked && m?.numChunks) {
        targets.push({ path: `po-uploads/${u.id}`, numChunks: m.numChunks, label: (u.data().poNames || []).join(',') || u.id });
      }
    }
  }

  console.log(`Targets:`);
  targets.forEach((t) => console.log(`  - ${t.path}  (${t.numChunks} chunks)  ${t.label}`));

  for (const t of targets) {
    try {
      await backfill(t.path, t.numChunks);
    } catch (err) {
      console.error(`[${t.path}] FAILED:`, err?.message || err);
    }
  }
  console.log(`\nAll done.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
