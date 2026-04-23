import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import { collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { hashPassword } from '../utils/crypto';
import { useAuth } from '../contexts/AuthContext';
import { logAudit } from '../utils/audit';

const ROLES = [
  { value: 'admin', label: 'Admin', desc: 'Full access — setup, dashboard, users, all settings' },
  { value: 'manager', label: 'Manager', desc: 'Dashboard, exports, job management' },
  { value: 'operator', label: 'Operator', desc: 'Pod and kiosk access only' },
];

export default function Users() {
  const { currentUser } = useAuth();
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
    if (user.id === currentUser?.id) return alert("You can't delete your own account");
    if (!confirm(`Remove user ${user.name} (${user.email})?`)) return;
    try {
      await deleteDoc(doc(db, 'users', user.id));
      logAudit('user_deleted', { userId: user.id, email: user.email, by: currentUser?.email });
      await loadUsers();
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleUpdateRole = async (user) => {
    if (user.id === currentUser?.id && editRole !== 'admin') {
      return alert("You can't demote yourself");
    }
    try {
      await setDoc(doc(db, 'users', user.id), { role: editRole }, { merge: true });
      logAudit('user_role_changed', { userId: user.id, email: user.email, oldRole: user.role, newRole: editRole, by: currentUser?.email });
      setEditingId(null);
      await loadUsers();
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const handleResetPassword = async (user) => {
    if (!resetPw.trim() || resetPw.length < 4) return alert('Password must be at least 4 characters');
    try {
      const pwHash = await hashPassword(resetPw.trim());
      await setDoc(doc(db, 'users', user.id), { passwordHash: pwHash }, { merge: true });
      logAudit('user_password_reset', { userId: user.id, email: user.email, by: currentUser?.email });
      setEditingId(null); setResetPw('');
      alert('Password updated for ' + user.email);
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const roleColor = (r) => ({ admin: '#EF4444', manager: '#3B82F6', operator: '#22C55E' }[r] || '#888');

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
        <button onClick={() => setShowAdd(true)} style={s.addBtn}>+ Add User</button>
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
        <p style={{ color: '#888' }}>Loading...</p>
      ) : users.length === 0 ? (
        <p style={{ color: '#888' }}>No users yet.</p>
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
