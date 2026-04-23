import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, getDocs, setDoc, doc, serverTimestamp } from 'firebase/firestore';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { useAuth } from '../contexts/AuthContext';

export default function AuthGate({ children, requiredRole }) {
  const { currentUser, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [noUsers, setNoUsers] = useState(false);
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPw, setSetupPw] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (currentUser) { setLoading(false); return; }
    // Check if any users exist (first-time setup)
    getDocs(collection(db, 'users')).then((snap) => {
      setNoUsers(snap.empty);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [currentUser]);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    setError('');
    try {
      const snap = await getDocs(collection(db, 'users'));
      let found = null;
      for (const d of snap.docs) {
        const data = d.data();
        if (data.email?.toLowerCase() === email.trim().toLowerCase()) {
          const match = await verifyPassword(password, data.passwordHash);
          if (match) { found = { id: d.id, ...data }; break; }
        }
      }
      if (found) {
        login(found);
      } else {
        setError('Invalid email or password');
        setPassword('');
      }
    } catch {
      setError('Login failed. Check your connection.');
    }
  };

  const handleFirstSetup = async () => {
    if (!setupName.trim() || !setupEmail.trim() || !setupPw.trim()) return;
    if (setupPw.length < 4) return setError('Password must be at least 4 characters');
    setCreating(true);
    setError('');
    try {
      const pwHash = await hashPassword(setupPw.trim());
      const userId = `user_${Date.now()}`;
      await setDoc(doc(db, 'users', userId), {
        name: setupName.trim(),
        email: setupEmail.trim().toLowerCase(),
        passwordHash: pwHash,
        role: 'admin',
        createdAt: serverTimestamp(),
      });
      login({ id: userId, name: setupName.trim(), email: setupEmail.trim().toLowerCase(), role: 'admin' });
    } catch (err) {
      setError('Failed to create account: ' + err.message);
    }
    setCreating(false);
  };

  if (loading) return null;

  // Permission check
  if (currentUser) {
    if (requiredRole) {
      const hierarchy = { admin: 3, manager: 2, operator: 1 };
      if ((hierarchy[currentUser.role] || 0) < (hierarchy[requiredRole] || 0)) {
        return (
          <div style={st.container}>
            <div style={st.card}>
              <h2 style={st.title}>🔒 Access Denied</h2>
              <p style={st.subtitle}>You need <strong>{requiredRole}</strong> access for this page.</p>
              <p style={{ color: '#666', fontSize: 13, marginTop: 8 }}>Logged in as {currentUser.name} ({currentUser.role})</p>
            </div>
          </div>
        );
      }
    }
    return children;
  }

  // First-time setup — no users exist
  if (noUsers) {
    return (
      <div style={st.container}>
        <div style={st.card}>
          <h2 style={st.title}>Welcome to BookFlow</h2>
          <p style={st.subtitle}>Create your admin account to get started.</p>
          <input type="text" value={setupName} onChange={(e) => setSetupName(e.target.value)}
            placeholder="Full Name" style={st.input} autoFocus />
          <input type="email" value={setupEmail} onChange={(e) => setSetupEmail(e.target.value)}
            placeholder="Email" style={{ ...st.input, marginTop: 10 }} />
          <input type="password" value={setupPw}
            onChange={(e) => setSetupPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleFirstSetup(); }}
            placeholder="Password" style={{ ...st.input, marginTop: 10 }} />
          {error && <p style={st.error}>{error}</p>}
          <button onClick={handleFirstSetup} disabled={creating || !setupName.trim() || !setupEmail.trim() || !setupPw.trim()}
            style={{ ...st.btn, opacity: creating ? 0.6 : 1 }}>
            {creating ? 'Creating...' : 'Create Admin Account'}
          </button>
        </div>
      </div>
    );
  }

  // Login form
  return (
    <div style={st.container}>
      <div style={st.card}>
        <h2 style={st.title}>🔒 BookFlow</h2>
        <p style={st.subtitle}>Sign in to continue</p>
        <input type="email" value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email" style={st.input} autoFocus />
        <input type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && email && password) handleLogin(); }}
          placeholder="Password" style={{ ...st.input, marginTop: 10 }} />
        {error && <p style={st.error}>{error}</p>}
        <button onClick={handleLogin} disabled={!email.trim() || !password.trim()}
          style={{ ...st.btn, opacity: !email.trim() || !password.trim() ? 0.5 : 1 }}>
          Sign In
        </button>
      </div>
    </div>
  );
}

const st = {
  container: {
    minHeight: '100vh', backgroundColor: '#0a0a0a', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui,sans-serif', padding: 24,
  },
  card: {
    backgroundColor: '#1a1a1a', borderRadius: 16, padding: 40, width: '100%', maxWidth: 400,
    border: '1px solid #333', textAlign: 'center',
  },
  title: { color: '#fff', fontSize: 22, fontWeight: 800, marginTop: 0, marginBottom: 4 },
  subtitle: { color: '#888', fontSize: 14, marginBottom: 20 },
  input: {
    width: '100%', padding: '14px 16px', borderRadius: 8, border: '1px solid #444',
    backgroundColor: '#222', color: '#fff', fontSize: 16, boxSizing: 'border-box',
  },
  error: { color: '#EF4444', fontSize: 14, marginTop: 8 },
  btn: {
    width: '100%', padding: '14px', borderRadius: 8, border: 'none',
    backgroundColor: '#3B82F6', color: '#fff', fontSize: 16, fontWeight: 700,
    cursor: 'pointer', marginTop: 16,
  },
};
