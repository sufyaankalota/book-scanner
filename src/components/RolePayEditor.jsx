import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { ROLES, normalizeRoles, rolesTotal } from '../utils/roles';
import { logAudit } from '../utils/audit';
import { useToast } from './Toast';

/**
 * Role-based per-day payroll editor.
 * Stores into `dailyPay/{jobId}_{date}` with shape:
 *   { jobId, date, roles: { openers: {count,hours,rate}, ... }, totalPay, headcount, notes, updatedAt }
 *
 * Backward-compat: legacy docs with `employees[]` and `totalPay` still load
 * (their total is shown as "legacy total" and replaced when the user saves).
 */
export default function RolePayEditor({ jobId, date, currentUser, onSaved, compact = false }) {
  const { show: toast } = useToast();
  const [roles, setRoles] = useState(() => normalizeRoles({}));
  const [notes, setNotes] = useState('');
  const [legacyTotal, setLegacyTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);

  const docId = jobId && date ? `${jobId}_${date}` : null;

  // Load doc when jobId/date changes
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    setLoading(true);
    setDirty(false);
    getDoc(doc(db, 'dailyPay', docId)).then((snap) => {
      if (cancelled) return;
      if (snap.exists()) {
        const data = snap.data();
        setRoles(normalizeRoles(data.roles));
        setNotes(data.notes || '');
        // If only legacy data exists, show it so user knows the baseline
        const legacy = !data.roles && Array.isArray(data.employees)
          ? data.employees.reduce((s, e) => s + (Number(e.hours) || 0) * (Number(e.rate) || 0), 0)
          : 0;
        setLegacyTotal(legacy);
        setSavedAt(data.updatedAt?.toDate?.() || data.createdAt?.toDate?.() || null);
      } else {
        setRoles(normalizeRoles({}));
        setNotes('');
        setLegacyTotal(0);
        setSavedAt(null);
      }
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId]);

  const { total, headcount } = useMemo(() => rolesTotal(roles), [roles]);

  const updateField = useCallback((roleKey, field, value) => {
    setDirty(true);
    setRoles((prev) => ({
      ...prev,
      [roleKey]: { ...prev[roleKey], [field]: value === '' ? 0 : Number(value) || 0 },
    }));
  }, []);

  const save = async () => {
    if (!docId) return;
    setSaving(true);
    try {
      const { total: t, headcount: hc } = rolesTotal(roles);
      await setDoc(doc(db, 'dailyPay', docId), {
        jobId,
        date,
        roles,
        totalPay: t,
        headcount: hc,
        notes,
        updatedAt: serverTimestamp(),
        updatedBy: currentUser?.email || currentUser?.name || 'unknown',
      }, { merge: true });
      logAudit('dailyPay.saveRoles', { jobId, date, headcount: hc, totalPay: t });
      setSavedAt(new Date());
      setDirty(false);
      setLegacyTotal(0);
      toast(`Saved — ${hc} on shift, $${t.toFixed(2)}`, 'success');
      onSaved?.({ totalPay: t, headcount: hc });
    } catch (err) {
      toast('Save failed: ' + (err?.message || 'unknown'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!jobId) {
    return <p style={st.empty}>Pick a job to edit payroll.</p>;
  }
  if (!date) {
    return <p style={st.empty}>Pick a date.</p>;
  }

  return (
    <div>
      <div style={st.header}>
        <div>
          <div style={st.dailyTotalLabel}>Daily Labor Total</div>
          <div style={st.dailyTotal}>${total.toFixed(2)}</div>
          <div style={st.dailySub}>{headcount} on shift{legacyTotal > 0 ? ` · legacy entry: $${legacyTotal.toFixed(2)}` : ''}</div>
        </div>
        <button onClick={save} disabled={saving || !dirty} style={{
          ...st.saveBtn,
          background: saving || !dirty ? '#333' : '#22C55E',
          cursor: saving || !dirty ? 'not-allowed' : 'pointer',
        }}>
          {saving ? 'Saving…' : dirty ? '💾 Save' : '✓ Saved'}
        </button>
      </div>

      {loading ? <p style={st.empty}>Loading…</p> : (
        <table style={st.table}>
          <thead>
            <tr>
              <th style={st.th}>Role</th>
              <th style={{ ...st.th, textAlign: 'right' }}># on shift</th>
              <th style={{ ...st.th, textAlign: 'right' }}>Hours each</th>
              <th style={{ ...st.th, textAlign: 'right' }}>Rate $/hr</th>
              <th style={{ ...st.th, textAlign: 'right' }}>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => {
              const v = roles[r.key];
              const sub = v.count * v.hours * v.rate;
              return (
                <tr key={r.key}>
                  <td style={st.td}><strong>{r.label}</strong></td>
                  <td style={st.tdNum}>
                    <input type="number" min="0" step="1" value={v.count || ''}
                      onChange={(e) => updateField(r.key, 'count', e.target.value)}
                      style={st.input} />
                  </td>
                  <td style={st.tdNum}>
                    <input type="number" min="0" step="0.25" value={v.hours || ''}
                      onChange={(e) => updateField(r.key, 'hours', e.target.value)}
                      style={st.input} />
                  </td>
                  <td style={st.tdNum}>
                    <input type="number" min="0" step="0.25" value={v.rate || ''}
                      onChange={(e) => updateField(r.key, 'rate', e.target.value)}
                      style={st.input} />
                  </td>
                  <td style={{ ...st.tdNum, color: sub > 0 ? '#34D399' : '#666', fontFamily: 'monospace' }}>
                    ${sub.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!compact && (
        <label style={st.notesLabel}>
          <span style={st.notesSpan}>Notes</span>
          <textarea value={notes}
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
            placeholder="Optional — e.g. early dismissal, OT, no-shows…"
            rows={2}
            style={st.notes} />
        </label>
      )}

      {savedAt && (
        <div style={st.savedAt}>Last saved: {savedAt.toLocaleString()}</div>
      )}
    </div>
  );
}

const st = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12, flexWrap: 'wrap' },
  dailyTotalLabel: { color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  dailyTotal: { color: '#34D399', fontSize: 26, fontWeight: 800, fontFamily: 'monospace' },
  dailySub: { color: '#666', fontSize: 11 },
  saveBtn: { padding: '10px 20px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 13, fontWeight: 800 },
  table: { width: '100%', borderCollapse: 'collapse', color: '#ddd', fontSize: 13 },
  th: { padding: '8px 8px', borderBottom: '1px solid #333', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left' },
  td: { padding: '8px 8px', borderBottom: '1px solid #222' },
  tdNum: { padding: '8px 8px', borderBottom: '1px solid #222', textAlign: 'right' },
  input: { width: 90, padding: '6px 8px', borderRadius: 4, border: '1px solid #333', backgroundColor: '#0a0a0a', color: '#fff', fontSize: 13, fontFamily: 'monospace', textAlign: 'right' },
  notesLabel: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 14 },
  notesSpan: { color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  notes: { padding: '8px 10px', borderRadius: 6, border: '1px solid #333', backgroundColor: '#0a0a0a', color: '#fff', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' },
  savedAt: { color: '#666', fontSize: 11, marginTop: 8 },
  empty: { color: '#666', textAlign: 'center', padding: 24, fontSize: 13 },
};
