import { describe, it, expect } from 'vitest';
import { parseManifestFile } from './manifest';

function csvFile(text, name = 'manifest.csv') {
  return new File([text], name, { type: 'text/csv' });
}

describe('parseManifestFile — dual ISBN (PO, Title, ISBN-10, ISBN-13)', () => {
  it('maps BOTH ISBN forms to the same {po, title}', async () => {
    const csv = [
      'PO,Title,ISBN-10,ISBN-13',
      'PO-OLD,The Great Gatsby,0743273567,9780743273565',
    ].join('\n');
    const { manifest, poNames } = await parseManifestFile(csvFile(csv));
    expect(manifest['0743273567']).toEqual({ po: 'PO-OLD', title: 'The Great Gatsby' });
    expect(manifest['9780743273565']).toEqual({ po: 'PO-OLD', title: 'The Great Gatsby' });
    expect(poNames).toContain('PO-OLD');
  });

  it('supports two POs in one file (header without dashes)', async () => {
    const csv = [
      'PO,Title,ISBN10,ISBN13',
      'OLD,Book A,0306406152,9780306406157',
      'NEW,Book B,0131103628,9780131103627',
    ].join('\n');
    const { manifest, poNames } = await parseManifestFile(csvFile(csv));
    expect(manifest['9780306406157'].po).toBe('OLD');
    expect(manifest['0306406152'].po).toBe('OLD');
    expect(manifest['9780131103627'].po).toBe('NEW');
    expect(manifest['0131103628'].po).toBe('NEW');
    expect(new Set(poNames)).toEqual(new Set(['OLD', 'NEW']));
  });

  it('skips rows missing both ISBNs; backfills the sibling for a 978 ISBN-13', async () => {
    const csv = [
      'PO,Title,ISBN-10,ISBN-13',
      'OLD,No ISBNs,,',
      'OLD,Has 13 only,,9780306406157',
    ].join('\n');
    const { manifest } = await parseManifestFile(csvFile(csv));
    expect(manifest['9780306406157']).toEqual({ po: 'OLD', title: 'Has 13 only' });
    // A 978-prefix ISBN-13 has an ISBN-10 form, which is auto-backfilled so the
    // book is findable by either barcode even though the CSV listed only one.
    expect(manifest['0306406152']).toEqual({ po: 'OLD', title: 'Has 13 only' });
    // The empty-ISBN row is dropped; only the one real book (both forms) remains.
    expect(Object.keys(manifest)).toHaveLength(2);
  });

  it('still parses a legacy single-ISBN CSV unchanged', async () => {
    const csv = ['ISBN,PO,Title', '9780306406157,OLD,Book A'].join('\n');
    const { manifest } = await parseManifestFile(csvFile(csv));
    expect(manifest['9780306406157']).toEqual({ po: 'OLD', title: 'Book A' });
  });
});
