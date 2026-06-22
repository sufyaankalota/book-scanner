import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { verifyPassword } from '../utils/crypto';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

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
      <div style={styles.card} className="ui-card scale-enter glow-accent">
        <div style={styles.icon}><ShieldCheck size={24} /></div>
        <h2 style={styles.title}>Supervisor Access</h2>
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
        <Link to="/" style={styles.backLink}><ArrowLeft size={14} /> Back to Home</Link>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-sans)',
    padding: 24,
  },
  card: {
    padding: '36px 32px',
    width: '100%',
    maxWidth: 380,
    textAlign: 'center',
  },
  icon: { width: 48, height: 48, borderRadius: 16, margin: '0 auto 14px', display: 'grid', placeItems: 'center', color: 'var(--accent)', backgroundColor: 'var(--accent-soft)', border: '1px solid var(--accent-soft)' },
  title: { fontSize: 24, fontWeight: 800, color: 'var(--text)', marginBottom: 6, marginTop: 0, letterSpacing: 0, fontFamily: 'var(--font-display)' },
  subtitle: { fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 },
  input: {
    width: '100%',
    padding: '14px 18px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    backgroundColor: 'var(--bg-input)',
    color: 'var(--text)',
    fontSize: 24,
    textAlign: 'center',
    letterSpacing: 8,
    boxSizing: 'border-box',
    fontWeight: 600,
  },
  error: { color: 'var(--error)', fontSize: 13, marginTop: 8, marginBottom: 0 },
  btn: {
    width: '100%',
    marginTop: 16,
    padding: '12px 24px',
    borderRadius: 10,
    border: 'none',
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-contrast)',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
  },
  backLink: {
    display: 'inline-flex',
    marginTop: 16,
    color: 'var(--text-tertiary)',
    fontSize: 13,
    textDecoration: 'none',
    fontWeight: 600,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
};
