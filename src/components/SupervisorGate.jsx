import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { hashPassword, verifyPassword } from '../utils/crypto';

const DEFAULT_PIN = '1234';

export default function SupervisorGate({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sessionStorage.getItem('supervisorAuth') === 'true') {
      setAuthenticated(true);
    }
    setLoading(false);
  }, []);

  const handleSubmit = async () => {
    setError('');
    try {
      const configDoc = await getDoc(doc(db, 'config', 'supervisor'));
      if (configDoc.exists()) {
        const data = configDoc.data();
        // Support both hashed and legacy plaintext PINs
        let match = false;
        if (data.pinHash) {
          match = await verifyPassword(pin, data.pinHash);
        } else if (data.pin) {
          match = pin === data.pin;
        } else {
          match = pin === DEFAULT_PIN;
        }
        if (match) {
          sessionStorage.setItem('supervisorAuth', 'true');
          setAuthenticated(true);
        } else {
          setError('Incorrect PIN');
          setPin('');
        }
      } else {
        // No config doc — accept default
        if (pin === DEFAULT_PIN) {
          sessionStorage.setItem('supervisorAuth', 'true');
          setAuthenticated(true);
        } else {
          setError('Incorrect PIN');
          setPin('');
        }
      }
    } catch {
      // Offline fallback — accept default PIN
      if (pin === DEFAULT_PIN) {
        sessionStorage.setItem('supervisorAuth', 'true');
        setAuthenticated(true);
      } else {
        setError('Cannot verify PIN offline. Try the default.');
        setPin('');
      }
    }
  };

  if (loading) return null;
  if (authenticated) return children;

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h2 style={styles.title}>🔒 Supervisor Access</h2>
        <p style={styles.subtitle}>Enter the supervisor PIN to continue.</p>
        <input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter' && pin) handleSubmit(); }}
          placeholder="Enter PIN..."
          style={styles.input}
          autoFocus
          maxLength={8}
        />
        {error && <p style={styles.error}>{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={!pin}
          style={{ ...styles.btn, opacity: pin ? 1 : 0.5 }}
        >
          Unlock
        </button>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: 'var(--bg, #111)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif',
    padding: 24,
  },
  card: {
    backgroundColor: 'var(--bg-card, #1a1a1a)',
    borderRadius: 16,
    padding: 40,
    width: '100%',
    maxWidth: 420,
    textAlign: 'center',
    border: '1px solid var(--border, #333)',
  },
  title: { fontSize: 28, fontWeight: 700, color: 'var(--text, #fff)', marginBottom: 8, marginTop: 0 },
  subtitle: { fontSize: 16, color: 'var(--text-secondary, #888)', marginBottom: 24 },
  input: {
    width: '100%',
    padding: '16px 20px',
    borderRadius: 10,
    border: '2px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)',
    color: 'var(--text, #fff)',
    fontSize: 28,
    textAlign: 'center',
    letterSpacing: 8,
    boxSizing: 'border-box',
  },
  error: { color: '#EF4444', fontSize: 14, marginTop: 8, marginBottom: 0 },
  btn: {
    width: '100%',
    marginTop: 16,
    padding: '14px 28px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#3B82F6',
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
  },
  backLink: {
    display: 'inline-block',
    marginTop: 16,
    color: '#666',
    fontSize: 14,
    textDecoration: 'none',
  },
};
