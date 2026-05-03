/**
 * Manifest parsing — CSV and XLSX upload support.
 * CSV files are parsed in chunks for 100MB+ support.
 *
 * Returns { manifest, poNames } where:
 *   - manifest[isbn] = { po, title }  if a Title column exists
 *   - manifest[isbn] = po (string)    for legacy CSVs without titles
 * (writeManifestChunks transparently handles both shapes.)
 *
 * First occurrence of a duplicate ISBN wins.
 *
 * Sibling backfill: many manifests duplicate each book as ISBN-13 (with title)
 * + ISBN-10 (blank title). After parsing we walk every entry once and copy
 * the title across to its alternate-form sibling so the AI fuzzy-match index
 * covers every book regardless of which barcode is on the copy in hand.
 */
import * as XLSX from 'xlsx';
import { isbnAlternates } from './isbn';

/**
 * Walk the parsed manifest and propagate titles + POs across ISBN-10/13
 * siblings. Mutates `manifest` in place. Returns count of entries patched.
 *
 * Rules (first non-null wins, never overwrites existing data):
 *   - If A has a title and its sibling B exists without one → copy title.
 *   - If A exists and its sibling B is missing entirely → synthesize B with
 *     the same PO + title. (Helps when a customer only ships one form.)
 *   - PO mismatch between siblings is left alone (rare; first one wins).
 */
function backfillIsbnSiblings(manifest) {
  let patched = 0;
  // Snapshot keys up front — we mutate during the loop and don't want to
  // re-process newly-added siblings.
  const keys = Object.keys(manifest);
  for (const isbn of keys) {
    const raw = manifest[isbn];
    if (raw == null) continue;
    const po = typeof raw === 'string' ? raw : raw.po;
    const title = typeof raw === 'string' ? '' : (raw.title || '');
    if (!po) continue;
    const { isbn13, isbn10 } = isbnAlternates(isbn);
    const siblingIsbn = isbn === isbn13 ? isbn10 : isbn13;
    if (!siblingIsbn || siblingIsbn === isbn) continue;
    const sib = manifest[siblingIsbn];
    if (sib == null) {
      // Sibling missing — synthesize it with the same PO + title
      manifest[siblingIsbn] = title ? { po, title } : po;
      patched++;
      continue;
    }
    // Sibling exists. Backfill title if we have one and sibling doesn't.
    if (title) {
      const sibTitle = typeof sib === 'string' ? '' : (sib.title || '');
      const sibPo = typeof sib === 'string' ? sib : sib.po;
      if (!sibTitle && sibPo) {
        manifest[siblingIsbn] = { po: sibPo, title };
        patched++;
      }
    }
  }
  return patched;
}

/**
 * Stream-parse a CSV file in chunks to handle 100MB+ files without
 * blowing up browser memory. Uses the File stream() API.
 */
function parseCSVStream(file, onProgress) {
  return new Promise((resolve, reject) => {
    const manifest = {};
    const poSet = new Set();
    let header = null;
    let isbnIdx = -1;
    let poIdx = -1;
    let titleIdx = -1;
    let skipped = 0;
    let processed = 0;
    let leftover = '';

    const decoder = new TextDecoder('utf-8');
    const stream = file.stream();
    const reader = stream.getReader();

    function processLines(text, isFinal) {
      const lines = text.split(/\r?\n/);
      // Keep last partial line unless this is the final chunk
      if (!isFinal) {
        leftover = lines.pop();
      }

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse CSV row (handles quoted fields)
        const cols = trimmed.match(/("(?:[^"]|"")*"|[^,]*)/g)?.map((c) =>
          c.replace(/^"|"$/g, '').replace(/""/g, '"').trim()
        ) || [];

        if (!header) {
          header = cols;
          isbnIdx = cols.findIndex((c) => /isbn/i.test(c));
          poIdx = cols.findIndex((c) => /^(po|po.?name|purchase.?order)/i.test(c));
          titleIdx = cols.findIndex((c) => /title|book.?name/i.test(c));
          if (isbnIdx === -1 || poIdx === -1) {
            reject(new Error('Could not find ISBN and PO columns. Headers found: ' + cols.join(', ')));
            return false;
          }
          continue;
        }

        const isbn = String(cols[isbnIdx] || '').replace(/[-\s]/g, '').trim();
        const po = String(cols[poIdx] || '').trim();
        const title = titleIdx >= 0 ? String(cols[titleIdx] || '').trim() : '';

        if (!isbn || !po) { skipped++; continue; }
        if (!manifest[isbn]) {
          manifest[isbn] = title ? { po, title } : po;
          poSet.add(po);
        }
        processed++;
      }
      return true;
    }

    let bytesRead = 0;
    const totalSize = file.size;

    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          // Process any leftover text
          if (leftover) processLines(leftover, true);
          if (!header) { reject(new Error('File is empty or has no data rows')); return; }
          if (skipped > 0) console.warn(`Manifest: skipped ${skipped} rows with missing ISBN or PO`);
          // Backfill ISBN-10 ↔ ISBN-13 siblings so every book is searchable by title
          const patched = backfillIsbnSiblings(manifest);
          if (patched > 0) console.info(`Manifest: backfilled ${patched.toLocaleString()} ISBN-10/13 sibling entries`);
          resolve({ manifest, poNames: [...poSet] });
          return;
        }

        bytesRead += value.byteLength;
        const text = leftover + decoder.decode(value, { stream: true });
        leftover = '';
        const ok = processLines(text, false);
        if (ok === false) return; // error already rejected

        if (onProgress) onProgress(Math.min(99, Math.round((bytesRead / totalSize) * 100)));
        pump();
      }).catch(reject);
    }

    pump();
  });
}

export function parseManifestFile(file, onProgress) {
  const isCSV = /\.csv$/i.test(file.name);

  // For CSV files, use streaming parser (handles 100MB+ efficiently)
  if (isCSV) {
    return parseCSVStream(file, onProgress);
  }

  // For XLSX/XLS files, use xlsx library (reads full file into memory)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        const manifest = {};
        if (rows.length === 0) {
          reject(new Error('File is empty or has no data rows'));
          return;
        }

        // Find column headers from first row
        const keys = Object.keys(rows[0]);
        const isbnKey = keys.find((k) => /isbn/i.test(k));
        const poKey = keys.find((k) => /^(po|po.?name|purchase.?order)/i.test(k));
        const titleKey = keys.find((k) => /title|book.?name/i.test(k));

        if (!isbnKey || !poKey) {
          reject(
            new Error(
              'Could not find ISBN and PO columns. Headers found: ' +
                keys.join(', ')
            )
          );
          return;
        }

        let skipped = 0;
        for (const row of rows) {
          const isbn = String(row[isbnKey] || '').replace(/[-\s]/g, '').trim();
          const po = String(row[poKey] || '').trim();
          const title = titleKey ? String(row[titleKey] || '').trim() : '';

          if (!isbn || !po) {
            skipped++;
            continue;
          }

          if (!manifest[isbn]) {
            manifest[isbn] = title ? { po, title } : po;
          }
        }

        if (skipped > 0) {
          console.warn(`Manifest: skipped ${skipped} rows with missing ISBN or PO`);
        }

        // Backfill ISBN-10 ↔ ISBN-13 siblings (titles + missing rows)
        const patched = backfillIsbnSiblings(manifest);
        if (patched > 0) console.info(`Manifest: backfilled ${patched.toLocaleString()} ISBN-10/13 sibling entries`);

        const poNames = [...new Set(Object.values(manifest).map((v) => typeof v === 'string' ? v : v.po))];
        resolve({ manifest, poNames });
      } catch (err) {
        reject(new Error('Failed to parse file: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}
