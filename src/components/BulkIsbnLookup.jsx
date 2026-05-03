import React, { useState } from 'react';
import { db } from '../firebase';
import { doc, getDoc, getDocs, collection } from 'firebase/firestore';
import { lookupIsbn } from '../utils/manifestStore';
import { useToast } from './Toast';

/**
 * Bulk ISBN lookup tool. Works for both chunked and legacy manifests.
 * Limits input to 200 ISBNs to keep Firestore reads reasonable.
 */
export default function BulkIsbnLookup({ activeJob }) {
  const { show: toast } = useToast();
  const [input, setInput] = useState('');
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const parseIsbns = (raw) => {
    return [...new Set(
      raw.split(/[\s,;\n\r]+/)
        .map((s) => s.trim().replace(/[^0-9Xx]/g, ''))
        .filter((s) => s.length >= 10 && s.length <= 13)
    )];
  };

  const runLookup = async () => {
    const isbns = parseIsbns(input);
    if (!isbns.length) return;
    if (isbns.length > 200) {
      toast(`Too many ISBNs (${isbns.length}). Maximum is 200 per lookup to control Firestore costs.`, 'error', 4500);
      return;
    }
    setRunning(true);
    setResults(null);
    setProgress(0);

    const out = [];
    if (activeJob.manifestMeta?.chunked) {
      // Chunked: hashed per-chunk lookup with caching
      const manifestPath = activeJob.manifestSource || `jobs/${activeJob.id}`;
      for (let i = 0; i < isbns.length; i++) {
        const isbn = isbns[i];
        try {
          const po = await lookupIsbn(manifestPath, isbn, activeJob.manifestMeta.numChunks);
          out.push({ isbn, po: po || null });
        } catch {
          out.push({ isbn, po: null, error: true });
        }
        setProgress(i + 1);
      }
    } else {
      // Legacy per-doc: do parallel direct doc reads (small N)
      const reads = isbns.map((isbn) => getDoc(doc(db, 'jobs', activeJob.id, 'manifest', isbn)).then((s) => ({ isbn, po: s.exists() ? s.data().poName : null })));
      const settled = await Promise.all(reads);
      out.push(...settled);
      setProgress(isbns.length);
    }

    setResults(out);
    setRunning(false);
  };

  const found = results?.filter((r) => r.po).length || 0;
  const missing = results?.filter((r) => !r.po).length || 0;

  return (
    <div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste ISBNs here (one per line or comma-separated)…"
        rows={6}
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 8,
          border: '1px solid #2a2a2a', backgroundColor: '#0f0f0f', color: '#f0f0f0',
          fontFamily: 'monospace', fontSize: 13, resize: 'vertical', boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button onClick={runLookup} disabled={running || !input.trim()}
          style={{
            padding: '10px 20px', borderRadius: 8, border: '1px solid #3B82F6',
            backgroundColor: running ? '#1e3a8a' : '#3B82F6', color: '#fff',
            fontSize: 14, fontWeight: 700, cursor: running ? 'wait' : 'pointer', opacity: running || !input.trim() ? 0.6 : 1,
          }}>
          {running ? `Looking up… ${progress}/${parseIsbns(input).length}` : '🔍 Look up ISBNs'}
        </button>
        {results && (
          <button onClick={() => { setResults(null); setInput(''); setProgress(0); }}
            style={{
              padding: '10px 16px', borderRadius: 8, border: '1px solid #444',
              backgroundColor: 'transparent', color: 'var(--text-secondary, #aaa)', fontSize: 13, cursor: 'pointer',
            }}>Clear</button>
        )}
        <span style={{ color: 'var(--text-tertiary, #666)', fontSize: 12, marginLeft: 'auto' }}>
          {parseIsbns(input).length} unique ISBN{parseIsbns(input).length === 1 ? '' : 's'} parsed
        </span>
      </div>

      {results && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#22C55E', fontWeight: 700 }}>✓ Found: {found.toLocaleString()}</span>
            <span style={{ color: '#EF4444', fontWeight: 700 }}>✗ Not in manifest: {missing.toLocaleString()}</span>
            <button onClick={() => {
              const csv = ['ISBN,PO,Status', ...results.map((r) => `${r.isbn},${r.po || ''},${r.po ? 'FOUND' : 'NOT_IN_MANIFEST'}`)].join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = `isbn-lookup-${Date.now()}.csv`;
              a.click(); URL.revokeObjectURL(url);
            }} style={{
              marginLeft: 'auto', padding: '4px 12px', borderRadius: 6,
              border: '1px solid #22C55E', backgroundColor: 'transparent', color: '#22C55E',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>📥 Export CSV</button>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid #222', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 13 }}>
              <thead>
                <tr style={{ backgroundColor: '#1a1a1a', position: 'sticky', top: 0 }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary, #aaa)', fontWeight: 600, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}>ISBN</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary, #aaa)', fontWeight: 600, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}>PO</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary, #aaa)', fontWeight: 600, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #1e1e1e' }}>
                    <td style={{ padding: '6px 12px', color: '#fff' }}>{r.isbn}</td>
                    <td style={{ padding: '6px 12px', color: r.po ? '#86efac' : 'var(--text-tertiary, #666)' }}>{r.po || '—'}</td>
                    <td style={{ padding: '6px 12px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                        backgroundColor: r.po ? '#14532d' : '#7c2d12',
                        color: r.po ? '#86efac' : '#fdba74',
                      }}>{r.po ? 'FOUND' : 'NOT IN MANIFEST'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
