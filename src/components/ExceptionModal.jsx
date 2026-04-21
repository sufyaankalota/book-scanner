import React, { useState } from 'react';

const EXCEPTION_REASONS = [
  'Damaged / Unsellable',
  'No ISBN Barcode',
  'Not a Book',
  'Other',
];

export default function ExceptionModal({ podId, scannerId, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [isbn, setIsbn] = useState('');
  const [step, setStep] = useState('reason'); // 'reason' | 'isbn'

  const handleReasonSelect = (r) => {
    setReason(r);
    setStep('isbn');
  };

  const handleSubmit = () => {
    onSubmit({
      reason,
      isbn: isbn.trim() || null,
      podId,
      scannerId,
    });
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>Log Exception</h2>

        {step === 'reason' && (
          <div>
            <p style={styles.subtitle}>Select reason:</p>
            {EXCEPTION_REASONS.map((r) => (
              <button
                key={r}
                onClick={() => handleReasonSelect(r)}
                style={styles.reasonBtn}
              >
                {r}
              </button>
            ))}
          </div>
        )}

        {step === 'isbn' && (
          <div>
            <p style={styles.subtitle}>
              Reason: <strong>{reason}</strong>
            </p>
            <p style={styles.subtitle}>Scan ISBN if readable (optional):</p>
            <input
              type="text"
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              placeholder="Scan or type ISBN..."
              style={styles.input}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button onClick={handleSubmit} style={styles.submitBtn}>
                Log Exception
              </button>
              <button onClick={handleSubmit} style={styles.skipBtn}>
                Skip ISBN & Log
              </button>
            </div>
          </div>
        )}

        <button onClick={onClose} style={styles.closeBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 32,
    minWidth: 360,
    maxWidth: 500,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: '#fff',
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 18,
    color: '#ccc',
    marginBottom: 12,
  },
  reasonBtn: {
    display: 'block',
    width: '100%',
    padding: '16px 20px',
    marginBottom: 8,
    borderRadius: 8,
    border: '2px solid #444',
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 20,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 8,
    border: '1px solid #444',
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 18,
    boxSizing: 'border-box',
  },
  submitBtn: {
    padding: '14px 24px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#F97316',
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    flex: 1,
  },
  skipBtn: {
    padding: '14px 24px',
    borderRadius: 8,
    border: '1px solid #555',
    backgroundColor: '#333',
    color: '#ccc',
    fontSize: 18,
    fontWeight: 600,
    cursor: 'pointer',
    flex: 1,
  },
  closeBtn: {
    marginTop: 16,
    padding: '10px 20px',
    borderRadius: 6,
    border: '1px solid #555',
    backgroundColor: 'transparent',
    color: '#999',
    fontSize: 14,
    cursor: 'pointer',
  },
};
