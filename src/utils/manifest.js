/**
 * Manifest parsing — CSV and XLSX upload support.
 * Returns a Map of ISBN -> PO Name (first occurrence wins for duplicate ISBNs).
 */
import * as XLSX from 'xlsx';

export function parseManifestFile(file) {
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
