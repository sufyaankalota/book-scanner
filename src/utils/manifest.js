/**
 * Manifest parsing — CSV and XLSX upload support.
 * CSV files are parsed in chunks for 100MB+ support.
 * Returns a Map of ISBN -> PO Name (first occurrence wins for duplicate ISBNs).
 */
import * as XLSX from 'xlsx';

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
          poIdx = cols.findIndex((c) => /po|purchase.?order/i.test(c));
          if (isbnIdx === -1 || poIdx === -1) {
            reject(new Error('Could not find ISBN and PO columns. Headers found: ' + cols.join(', ')));
            return false;
          }
          continue;
        }

        const isbn = String(cols[isbnIdx] || '').replace(/[-\s]/g, '').trim();
        const po = String(cols[poIdx] || '').trim();

        if (!isbn || !po) { skipped++; continue; }
        if (!manifest[isbn]) { manifest[isbn] = po; poSet.add(po); }
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
        const poKey = keys.find((k) => /po|purchase.?order/i.test(k));

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

          if (!isbn || !po) {
            skipped++;
            continue;
          }

          if (!manifest[isbn]) {
            manifest[isbn] = po;
          }
        }

        if (skipped > 0) {
          console.warn(`Manifest: skipped ${skipped} rows with missing ISBN or PO`);
        }

        const poNames = [...new Set(Object.values(manifest))];
        resolve({ manifest, poNames });
      } catch (err) {
        reject(new Error('Failed to parse file: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}
