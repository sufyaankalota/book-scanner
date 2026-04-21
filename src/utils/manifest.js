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
        for (const row of rows) {
          // Find ISBN and PO columns (case-insensitive header match)
          const keys = Object.keys(row);
          const isbnKey = keys.find((k) =>
            /isbn/i.test(k)
          );
          const poKey = keys.find((k) =>
            /po|purchase.?order/i.test(k)
          );

          if (!isbnKey || !poKey) {
            reject(
              new Error(
                'Could not find ISBN and PO columns. Headers found: ' +
                  keys.join(', ')
              )
            );
            return;
          }

          const isbn = String(row[isbnKey]).replace(/[-\s]/g, '').trim();
          const po = String(row[poKey]).trim();

          if (isbn && po && !manifest[isbn]) {
            manifest[isbn] = po;
          }
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
