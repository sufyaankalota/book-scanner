/**
 * Stream-import a `ISBN,PO,Title` CSV into a fresh `po-uploads/<id>` doc with
 * chunked manifest storage, ISBN-10/13 sibling pairing, and title backfill
 * across paired siblings (so AI photo lookup works for either ISBN form).
 *
 * Usage:
 *   node scripts/import-po-csv.mjs <csvPath> [--name "Display Name"] [--replace <po-uploads/id>]
 *   node scripts/import-po-csv.mjs --list
 *   node scripts/import-po-csv.mjs --delete <po-uploads/id>
 *
 * Reads Firebase config from scripts/.firebase-config.json (extracted from the
 * deployed bundle — these values are public-by-design and ship in the client).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, doc, getDoc, getDocs, writeBatch, setDoc, deleteDoc,
} from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.firebase-config.json'), 'utf8'));
const app = initializeApp(cfg);
const db = getFirestore(app);

// ── ISBN helpers (mirror src/utils/isbn.js) ──
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
function normalizeIsbn(raw) {
  if (!raw) return null;
  return String(raw).replace(/[-\s]/g, '').trim().toUpperCase();
}
function isbnAlternates(isbn) {
  const c = normalizeIsbn(isbn);
  if (!c) return { isbn13: null, isbn10: null };
  if (c.length === 13) return { isbn13: c, isbn10: isbn13To10(c) };
  if (c.length === 10) return { isbn13: isbn10To13(c), isbn10: c };
  return { isbn13: null, isbn10: null };
}

// ── Chunk hash (must match src/utils/manifestStore.js) ──
const CHUNK_SIZE = 2000;
const WRITE_BATCH = 10;
function hashIsbn(isbn, numChunks) {
  let h = 0;
  for (let i = 0; i < isbn.length; i++) h = (h * 31 + isbn.charCodeAt(i)) | 0;
  return ((h % numChunks) + numChunks) % numChunks;
}

// ── CSV line parser (handles quoted fields with commas) ──
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ── Main pipeline ──
async function streamCsv(csvPath) {
  console.log(`[1/4] Streaming ${csvPath}…`);
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // entries: { isbn: {p, t} }  — flat, kept in memory (~1-2GB for 8.9M)
  const entries = new Map();
  let header = null;
  let n = 0;
  let kept = 0;

  for await (const rawLine of rl) {
    if (!rawLine) continue;
    if (!header) {
      header = parseCsvLine(rawLine).map((h) => h.trim().toLowerCase());
      const need = ['isbn', 'po'];
      for (const k of need) if (!header.includes(k)) { console.error(`CSV missing column: ${k}`); process.exit(1); }
      continue;
    }
    n++;
    if (n % 500000 === 0) process.stdout.write(`\r  ${n.toLocaleString()} rows scanned (${kept.toLocaleString()} kept)`);
    const cols = parseCsvLine(rawLine);
    const obj = {};
    header.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    const isbn = normalizeIsbn(obj.isbn);
    const po = obj.po;
    const title = obj.title || null;
    if (!isbn || !po) continue;
    if (isbn.length !== 10 && isbn.length !== 13) continue;
    const existing = entries.get(isbn);
    if (existing) {
      // Prefer richer title; keep first PO seen (CSV duplicates shouldn't conflict)
      if (title && !existing.t) existing.t = title;
    } else {
      entries.set(isbn, title ? { p: po, t: title } : { p: po });
      kept++;
    }
  }
  process.stdout.write(`\r  ${n.toLocaleString()} rows scanned (${kept.toLocaleString()} kept)\n`);
  return entries;
}

function backfillSiblings(entries) {
  console.log(`[2/4] Pairing ISBN-10/13 siblings + propagating titles…`);
  let added = 0;
  let titlesPropagated = 0;
  // Snapshot keys first since we mutate the map while iterating
  const initialKeys = [...entries.keys()];
  for (const isbn of initialKeys) {
    const cur = entries.get(isbn);
    if (!cur) continue;
    const { isbn13, isbn10 } = isbnAlternates(isbn);
    const sib = isbn === isbn13 ? isbn10 : isbn13;
    if (!sib || sib === isbn) continue;
    const sibCur = entries.get(sib);
    if (!sibCur) {
      entries.set(sib, cur.t ? { p: cur.p, t: cur.t } : { p: cur.p });
      added++;
    } else if (cur.t && !sibCur.t) {
      sibCur.t = cur.t;
      titlesPropagated++;
    }
  }
  console.log(`  +${added.toLocaleString()} sibling rows added, ${titlesPropagated.toLocaleString()} titles propagated`);
  return { added, titlesPropagated };
}

async function writeChunked(parentPath, entries) {
  console.log(`[3/4] Writing ${entries.size.toLocaleString()} entries to ${parentPath}…`);
  const numChunks = Math.ceil(entries.size / CHUNK_SIZE);
  const chunks = new Map(); // idx -> { isbn: entry }
  const poCounts = {};
  let hasTitles = false;

  for (const [isbn, raw] of entries) {
    const idx = hashIsbn(isbn, numChunks);
    if (!chunks.has(idx)) chunks.set(idx, {});
    chunks.get(idx)[isbn] = raw.t ? { p: raw.p, t: raw.t } : raw.p;
    poCounts[raw.p] = (poCounts[raw.p] || 0) + 1;
    if (raw.t) hasTitles = true;
  }

  const chunkArr = [...chunks.entries()];
  // Firestore caps transactions at ~10MB. With titles, ~5000 entries × ~100B per chunk ≈ 500KB,
  // which exceeds batch limits when grouped. Write each chunk as its own setDoc, with bounded
  // concurrency for throughput.
  const PAR = 10;
  let written = 0;
  for (let i = 0; i < chunkArr.length; i += PAR) {
    const slice = chunkArr.slice(i, i + PAR);
    await Promise.all(slice.map(([idx, isbns]) =>
      setDoc(doc(db, parentPath, 'manifest-chunks', `c${String(idx).padStart(5, '0')}`), { isbns })
    ));
    written += slice.length;
    process.stdout.write(`\r  chunks: ${written.toLocaleString()}/${chunkArr.length.toLocaleString()}`);
  }
  process.stdout.write('\n');
  return { numChunks, totalIsbns: entries.size, poCounts, hasTitles };
}

async function listUploads() {
  const snap = await getDocs(collection(db, 'po-uploads'));
  console.log(`Found ${snap.size} po-uploads:`);
  snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => (Number(b.data.uploadedAt) || 0) - (Number(a.data.uploadedAt) || 0))
    .forEach(({ id, data }) => {
      const m = data.manifestMeta || {};
      let date = '?';
      try {
        const t = data.uploadedAt;
        if (t) {
          const ms = typeof t === 'number' ? t : (t.toMillis ? t.toMillis() : Number(t) || 0);
          if (ms > 0) date = new Date(ms).toISOString().slice(0, 16);
        }
      } catch {}
      console.log(`  - po-uploads/${id}`);
      console.log(`      name:    ${data.displayName || (data.poNames || []).join(',') || '(none)'}`);
      console.log(`      uploaded: ${date}`);
      console.log(`      ISBNs:    ${(m.totalIsbns || 0).toLocaleString()}  chunks:${m.numChunks || 0}  titles:${m.hasTitles ? 'yes' : 'NO'}`);
    });
}

async function deletePath(parentPath) {
  const [coll, id] = parentPath.split('/');
  const parent = await getDoc(doc(db, coll, id));
  if (!parent.exists()) { console.error(`Not found: ${parentPath}`); return; }
  const numChunks = parent.data().manifestMeta?.numChunks || 0;
  console.log(`Deleting ${numChunks.toLocaleString()} chunks under ${parentPath}…`);
  for (let start = 0; start < numChunks; start += 400) {
    const batch = writeBatch(db);
    const end = Math.min(start + 400, numChunks);
    for (let i = start; i < end; i++) {
      batch.delete(doc(db, parentPath, 'manifest-chunks', `c${String(i).padStart(5, '0')}`));
    }
    await batch.commit();
    process.stdout.write(`\r  ${end.toLocaleString()}/${numChunks.toLocaleString()}`);
  }
  process.stdout.write('\n');
  await deleteDoc(doc(db, coll, id));
  console.log(`  Deleted parent doc ${parentPath}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--list') { await listUploads(); process.exit(0); }
  if (argv[0] === '--delete') {
    if (!argv[1]) { console.error('Usage: --delete <po-uploads/id>'); process.exit(1); }
    await deletePath(argv[1]); process.exit(0);
  }

  const nameIdx = argv.indexOf('--name');
  const replaceIdx = argv.indexOf('--replace');
  const flagValueIdxs = new Set();
  if (nameIdx >= 0) flagValueIdxs.add(nameIdx + 1);
  if (replaceIdx >= 0) flagValueIdxs.add(replaceIdx + 1);
  const csvPath = argv.find((a, i) => !a.startsWith('--') && !flagValueIdxs.has(i));
  if (!csvPath) { console.error('Usage: import-po-csv.mjs <csvPath> [--name "..."] [--replace <po-uploads/id>]'); process.exit(1); }
  const displayName = nameIdx >= 0 ? argv[nameIdx + 1] : path.basename(csvPath, path.extname(csvPath));
  const replaceTarget = replaceIdx >= 0 ? argv[replaceIdx + 1] : null;

  const entries = await streamCsv(csvPath);
  backfillSiblings(entries);

  // Generate doc id
  const newId = `po_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const parentPath = `po-uploads/${newId}`;
  const meta = await writeChunked(parentPath, entries);

  console.log(`[4/4] Writing parent doc ${parentPath}…`);
  await setDoc(doc(db, 'po-uploads', newId), {
    displayName,
    poNames: Object.keys(meta.poCounts).sort(),
    isbnCount: meta.totalIsbns,
    uploadedAt: Date.now(),
    status: 'pending',
    manifestMeta: {
      chunked: true,
      totalIsbns: meta.totalIsbns,
      numChunks: meta.numChunks,
      chunkSize: CHUNK_SIZE,
      poCounts: meta.poCounts,
      hasTitles: meta.hasTitles,
    },
  });
  console.log(`  Wrote po-uploads/${newId}`);
  console.log(`\nSummary:`);
  console.log(`  ISBNs (incl siblings): ${meta.totalIsbns.toLocaleString()}`);
  console.log(`  POs:                   ${Object.keys(meta.poCounts).length.toLocaleString()}`);
  console.log(`  Chunks written:        ${meta.numChunks.toLocaleString()}`);
  console.log(`  Has titles:            ${meta.hasTitles ? 'yes' : 'NO'}`);

  if (replaceTarget) {
    console.log(`\nDeleting old upload ${replaceTarget}…`);
    await deletePath(replaceTarget);
  }

  console.log(`\nDone. Open Setup → it will appear under "Customer-supplied POs" as "${displayName}".`);
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
