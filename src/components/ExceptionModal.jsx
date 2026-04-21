import React, { useState, useRef } from 'react';

const EXCEPTION_REASONS = [
  'Damaged / Unsellable',
  'No ISBN Barcode',
  'Not a Book',
  'Other',
];

export default function ExceptionModal({ podId, scannerId, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [isbn, setIsbn] = useState('');
  const [title, setTitle] = useState('');
  const [step, setStep] = useState('reason'); // 'reason' | 'details'
  const isbnRef = useRef(null);

  const handleReasonSelect = (r) => {
    setReason(r);
    setStep('details');
    setTimeout(() => isbnRef.current?.focus(), 100);
  };

  const handleSubmit = () => {
    onSubmit({
      reason,
      isbn: isbn.trim() || null,
      title: title.trim() || null,
      podId,
      scannerId,
    });
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>⚠️ Log Exception</h2>

        {step === 'reason' && (
          <div>
            <p style={styles.subtitle}>What's the issue?</p>
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

        {step === 'details' && (
          <div>
            <div style={styles.reasonTag}>
              {reason}
            </div>

            <p style={styles.fieldLabel}>ISBN (scan or type):</p>
            <input
              ref={isbnRef}
              type="text"
              value={isbn}
              onChange={(e) => setIsbn(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Scan barcode or type ISBN..."
              style={styles.input}
            />

            <p style={{ ...styles.fieldLabel, marginTop: 14 }}>
              Or Book Title (if no ISBN):
            </p>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Harry Potter..."
              style={styles.input}
            />

            {/* Instruction banner */}
            <div style={styles.instructionBanner}>
              <span style={styles.instructionIcon}>📦</span>
              <span style={styles.instructionText}>
                Place this item in the <strong>EXCEPTION GAYLORD / BIN</strong>
              </span>
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button onClick={handleSubmit} style={styles.submitBtn}>
                Log Exception
              </button>
              <button
                onClick={() => {
                  setIsbn('');
                  setTitle('');
                  handleSubmit();
                }}
                style={styles.skipBtn}
              >
                Skip & Log
              </button>
            </div>
          </div>
        )}

        <button onClick={onClose} style={styles.closeBtn}>
          ← Cancel
        </button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 32,
    minWidth: 380,
    maxWidth: 520,
    border: '2px solid #F97316',
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: '#fff',
    marginBottom: 16,
  },
  subtitle: {
    fontSize: 20,
    color: '#ccc',
    marginBottom: 12,
  },
  reasonTag: {
    display: 'inline-block',
    padding: '6px 14px',
    borderRadius: 6,
    backgroundColor: '#7f1d1d',
    color: '#fca5a5',
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 15,
    color: '#aaa',
    marginBottom: 6,
    fontWeight: 600,
  },
  reasonBtn: {
    display: 'block',
    width: '100%',
    padding: '18px 20px',
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
    padding: '14px 16px',
    borderRadius: 8,
    border: '1px solid #444',
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 18,
    boxSizing: 'border-box',
  },
  instructionBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
    padding: '14px 16px',
    borderRadius: 8,
    backgroundColor: '#422006',
    border: '1px solid #F97316',
  },
  instructionIcon: {
    fontSize: 24,
  },
  instructionText: {
    fontSize: 16,
    color: '#fed7aa',
    lineHeight: 1.3,
  },
  submitBtn: {
    padding: '16px 24px',
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
    padding: '16px 24px',
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
    width: '100%',
    textAlign: 'center',
  },
};
