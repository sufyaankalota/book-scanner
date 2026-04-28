import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import { collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { hashPassword } from '../utils/crypto';
import { useAuth } from '../contexts/AuthContext';
import { logAudit } from '../utils/audit';
import { useToast } from '../components/Toast';

const ROLES = [
  { value: 'admin', label: 'Admin', desc: 'Full access — setup, dashboard, users, all settings' },
  { value: 'manager', label: 'Manager', desc: 'Dashboard, exports, job management' },
  { value: 'operator', label: 'Operator', desc: 'Pod and kiosk access only' },
];

export default function Users() {
  const { currentUser } = useAuth();
  const { show: toast } = useToast();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('operator');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editRole, setEditRole] = useState('');
  const [resetPw, setResetPw] = useState('');

  const loadUsers = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'users'));
      setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')));
    } catch { setUsers([]); }
    setLoading(false);
  };

  useEffect(() => { loadUsers(); }, []);

  const handleAdd = async () => {
    if (!newName.trim() || !newEmail.trim() || !newPassword.trim()) return;
    if (newPassword.length < 4) return setError('Password must be at least 4 characters');
    // Check duplicate email
    if (users.some((u) => u.email?.toLowerCase() === newEmail.trim().toLowerCase())) {
      return setError('A user with this email already exists');
    }
    setSaving(true); setError('');
    try {
      const pwHash = await hashPassword(newPassword.trim());
      const userId = `user_${Date.now()}`;
      await setDoc(doc(db, 'users', userId), {
        name: newName.trim(),
        email: newEmail.trim().toLowerCase(),
        passwordHash: pwHash,
        role: newRole,
        createdAt: serverTimestamp(),
        createdBy: currentUser?.email || 'unknown',
      });
      logAudit('user_created', { userId, email: newEmail.trim().toLowerCase(), role: newRole, by: currentUser?.email });
      setNewName(''); setNewEmail(''); setNewPassword(''); setNewRole('operator');
      setShowAdd(false);
      await loadUsers();
    } catch (err) { setError('Failed: ' + err.message); }
    setSaving(false);
  };

  const handleDelete = async (user) => {
    if (user.id === currentUser?.id) return toast("You can't delete your own account", 'error');
    if (!confirm(`Remove user ${user.name} (${user.email})?`)) return;
    try {
      await deleteDoc(doc(db, 'users', user.id));
      logAudit('user_deleted', { userId: user.id, email: user.email, by: currentUser?.email });
      await loadUsers();
      toast('User removed', 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  };

  const handleUpdateRole = async (user) => {
    if (user.id === currentUser?.id && editRole !== 'admin') {
      return toast("You can't demote yourself", 'error');
    }
    try {
      await setDoc(doc(db, 'users', user.id), { role: editRole }, { merge: true });
      logAudit('user_role_changed', { userId: user.id, email: user.email, oldRole: user.role, newRole: editRole, by: currentUser?.email });
      setEditingId(null);
      await loadUsers();
      toast('Role updated', 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  };

  const handleResetPassword = async (user) => {
    if (!resetPw.trim() || resetPw.length < 4) return toast('Password must be at least 4 characters', 'error');
    try {
      const pwHash = await hashPassword(resetPw.trim());
      await setDoc(doc(db, 'users', user.id), { passwordHash: pwHash }, { merge: true });
      logAudit('user_password_reset', { userId: user.id, email: user.email, by: currentUser?.email });
      setEditingId(null); setResetPw('');
      toast('Password updated for ' + user.email, 'success');
    } catch (err) { toast('Failed: ' + err.message, 'error'); }
  };

  const roleColor = (r) => ({ admin: '#EF4444', manager: '#3B82F6', operator: '#22C55E' }[r] || '#888');

  const [importing, setImporting] = useState(false);

  const handleCsvImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return toast('CSV must be under 1 MB', 'error');
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) { toast('CSV is empty', 'error'); setImporting(false); return; }
      // Detect header
      const first = lines[0].toLowerCase();
      const hasHeader = first.includes('email') && first.includes('name');
      const dataLines = hasHeader ? lines.slice(1) : lines;
      const validRoles = new Set(['admin', 'manager', 'operator']);
      const existingEmails = new Set(users.map((u) => (u.email || '').toLowerCase()));
      const errors = [];
      const toCreate = [];
      dataLines.forEach((line, idx) => {
        const row = idx + (hasHeader ? 2 : 1);
        // naive CSV split (no quoted commas)
        const cells = line.split(',').map((c) => c.trim());
        const [name, email, password, role = 'operator'] = cells;
        if (!name || !email || !password) { errors.push(`Row ${row}: missing name/email/password`); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push(`Row ${row}: invalid email "${email}"`); return; }
        if (password.length < 4) { errors.push(`Row ${row}: password too short`); return; }
        const r = role.toLowerCase();
        if (!validRoles.has(r)) { errors.push(`Row ${row}: invalid role "${role}"`); return; }
        const lower = email.toLowerCase();
        if (existingEmails.has(lower)) { errors.push(`Row ${row}: ${email} already exists`); return; }
        if (toCreate.some((u) => u.email === lower)) { errors.push(`Row ${row}: duplicate email in CSV`); return; }
        toCreate.push({ name, email: lower, password, role: r });
      });
      let created = 0;
      for (const u of toCreate) {
        try {
          const pwHash = await hashPassword(u.password);
          const userId = `user_${Date.now()}_${created}`;
          await setDoc(doc(db, 'users', userId), {
            name: u.name,
            email: u.email,
            passwordHash: pwHash,
            role: u.role,
            createdAt: serverTimestamp(),
            createdBy: currentUser?.email || 'unknown',
          });
          created++;
        } catch (err) {
          errors.push(`${u.email}: ${err.message}`);
        }
      }
      logAudit('user_bulk_imported', { count: created, errors: errors.length, by: currentUser?.email });
      await loadUsers();
      if (created > 0 && errors.length === 0) {
        toast(`Imported ${created} user${created === 1 ? '' : 's'}`, 'success', 4000);
      } else if (created > 0) {
        toast(`Imported ${created}, ${errors.length} skipped. First error: ${errors[0]}`, 'info', 6000);
      } else {
        toast(`No users imported. ${errors[0] || 'Check CSV format.'}`, 'error', 6000);
      }
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
    setImporting(false);
  };

  return (
    <div style={s.container}>
      <Link to="/setup" style={s.backLink}>← Back to Setup</Link>
      <h1 style={s.title}>User Management</h1>
      <p style={{ color: '#888', fontSize: 14, marginBottom: 24 }}>
        Manage who can access the BookFlow application. Logged in as <strong style={{ color: '#ccc' }}>{currentUser?.name}</strong>.
      </p>

      {/* Role Permissions */}
      <div style={{ ...s.card, backgroundColor: '#1a1a2e', borderColor: '#334', marginBottom: 16 }}>
        <h3 style={{ color: '#818cf8', fontSize: 14, margin: '0 0 8px' }}>Permission Levels</h3>
        {ROLES.map((r) => (
          <div key={r.value} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, backgroundColor: roleColor(r.value) + '22', color: roleColor(r.value), minWidth: 70, textAlign: 'center' }}>
              {r.label}
            </span>
            <span style={{ color: '#888', fontSize: 13 }}>{r.desc}</span>
          </div>
        ))}
      </div>

      {/* Add User */}
      {!showAdd ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setShowAdd(true)} style={{ ...s.addBtn, marginBottom: 0, flex: '1 1 200px' }}>+ Add User</button>
            <label style={{ ...s.addBtn, marginBottom: 0, flex: '1 1 200px', textAlign: 'center', cursor: importing ? 'wait' : 'pointer', opacity: importing ? 0.6 : 1, background: '#1a1a1a', borderColor: '#333', color: '#ccc' }}>
              {importing ? 'Importing…' : '📥 Import CSV'}
              <input type="file" accept=".csv,text/csv" onChange={handleCsvImport} disabled={importing} style={{ display: 'none' }} />
            </label>
          </div>
          <p style={{ color: '#666', fontSize: 11, marginTop: 0, marginBottom: 16 }}>
            CSV columns: <code style={{ color: '#888' }}>name,email,password,role</code> (role: admin/manager/operator). Header row optional.
          </p>
        </>
      ) : (
        <div style={{ ...s.card, marginBottom: 16 }}>
          <h3 style={s.cardTitle}>New User</h3>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Full Name" style={s.input} autoFocus />
          <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
            placeholder="Email" style={{ ...s.input, marginTop: 8 }} />
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Password (min 4 chars)" style={{ ...s.input, marginTop: 8 }} />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} style={{ ...s.input, marginTop: 8 }}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {error && <p style={{ color: '#EF4444', fontSize: 13, marginTop: 8 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={handleAdd} disabled={saving} style={{ ...s.primaryBtn, flex: 1 }}>
              {saving ? 'Creating...' : 'Create User'}
            </button>
            <button onClick={() => { setShowAdd(false); setError(''); }} style={{ ...s.cancelBtn, flex: 1 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* User List */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3].map((i) => <div key={i} className="skeleton" style={{ height: 80 }}></div>)}
        </div>
      ) : users.length === 0 ? (
        <div style={{ ...s.card, textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>👥</div>
          <p style={{ color: '#aaa', fontSize: 15, marginBottom: 4 }}>No users yet</p>
          <p style={{ color: '#666', fontSize: 13 }}>Click <strong style={{ color: '#3B82F6' }}>+ Add User</strong> above to create your first account.</p>
        </div>
      ) : (
        <div>
          {users.map((u) => (
            <div key={u.id} style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>{u.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, backgroundColor: roleColor(u.role) + '22', color: roleColor(u.role) }}>
                      {u.role}
                    </span>
                    {u.id === currentUser?.id && <span style={{ fontSize: 11, color: '#666' }}>(you)</span>}
                  </div>
                  <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>{u.email}</div>
                  <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>
                    Added {u.createdAt?.toDate?.()?.toLocaleDateString() || '—'}
                    {u.createdBy ? ` by ${u.createdBy}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => { setEditingId(editingId === u.id ? null : u.id); setEditRole(u.role); setResetPw(''); }}
                    style={s.smallBtn}>
                    {editingId === u.id ? 'Close' : 'Edit'}
                  </button>
                  {u.id !== currentUser?.id && (
                    <button onClick={() => handleDelete(u)}
                      style={{ ...s.smallBtn, borderColor: '#EF4444', color: '#EF4444' }}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {editingId === u.id && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #333' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ color: '#888', fontSize: 13, minWidth: 50 }}>Role:</span>
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value)} style={{ ...s.input, flex: 1 }}>
                      {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <button onClick={() => handleUpdateRole(u)} disabled={editRole === u.role}
                      style={{ ...s.primaryBtn, padding: '8px 16px', opacity: editRole === u.role ? 0.5 : 1 }}>
                      Save
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: '#888', fontSize: 13, minWidth: 50 }}>Reset:</span>
                    <input type="password" value={resetPw} onChange={(e) => setResetPw(e.target.value)}
                      placeholder="New password..." style={{ ...s.input, flex: 1 }} />
                    <button onClick={() => handleResetPassword(u)} disabled={!resetPw.trim()}
                      style={{ ...s.primaryBtn, padding: '8px 16px', opacity: !resetPw.trim() ? 0.5 : 1 }}>
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  container: { minHeight: '100vh', backgroundColor: '#0a0a0a', color: '#f0f0f0', padding: '20px 20px 40px', fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif", maxWidth: 640, margin: '0 auto' },
  backLink: { color: '#555', textDecoration: 'none', fontSize: 13, display: 'inline-block', marginBottom: 14, fontWeight: 600 },
  title: { fontSize: 22, fontWeight: 800, margin: '0 0 8px', color: '#f0f0f0', letterSpacing: '-0.3px' },
  card: { backgroundColor: '#141414', borderRadius: 12, padding: '14px 16px', border: '1px solid #1e1e1e', marginBottom: 10 },
  cardTitle: { fontSize: 14, fontWeight: 700, color: '#aaa', marginTop: 0, marginBottom: 10, letterSpacing: '-0.2px' },
  input: { width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #2a2a2a', backgroundColor: '#1a1a1a', color: '#f0f0f0', fontSize: 14, boxSizing: 'border-box', fontWeight: 500 },
  addBtn: { padding: '10px 20px', borderRadius: 8, border: '1px dashed #2a2a2a', backgroundColor: 'transparent', color: '#3B82F6', fontSize: 13, fontWeight: 600, cursor: 'pointer', width: '100%', marginBottom: 14 },
  primaryBtn: { padding: '10px 20px', borderRadius: 8, border: 'none', backgroundColor: '#3B82F6', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  cancelBtn: { padding: '10px 20px', borderRadius: 8, border: '1px solid #2a2a2a', backgroundColor: 'transparent', color: '#666', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  smallBtn: { padding: '4px 10px', borderRadius: 4, border: '1px solid #2a2a2a', backgroundColor: 'transparent', color: '#666', fontSize: 11, fontWeight: 600, cursor: 'pointer' },
};
