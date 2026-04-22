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
  const [step, setStep] = useState('reason');
  const [photoData, setPhotoData] = useState(null);
  const isbnRef = useRef(null);
  const fileRef = useRef(null);

  const handleReasonSelect = (r) => {
    setReason(r);
    setStep('details');
    setTimeout(() => isbnRef.current?.focus(), 100);
  };

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Compress to thumbnail via canvas
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX = 400;
        const scale = Math.min(MAX / img.width, MAX / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        setPhotoData(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const needsPhoto = !isbn.trim() && !title.trim();

  const handleSubmit = () => {
    if (needsPhoto && !photoData) return; // blocked — photo required
    onSubmit({
      reason,
      isbn: isbn.trim() || null,
      title: title.trim() || null,
      photo: photoData || null,
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
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.titleRow}>
          <h2 style={styles.title}>⚠️ Log Exception</h2>
          <button onClick={onClose} style={styles.closeX} aria-label="Close">✕</button>
        </div>

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
            <div style={styles.reasonTag}>{reason}</div>

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

            <p style={{ ...styles.fieldLabel, marginTop: 14, color: needsPhoto && !photoData ? '#F97316' : '#aaa' }}>
              📸 Photo {needsPhoto ? '(required — no ISBN or title entered)' : '(optional)'}:
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handlePhoto}
              style={{ display: 'none' }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => fileRef.current?.click()}
                style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #555', backgroundColor: '#222', color: '#ccc', fontSize: 14, cursor: 'pointer' }}>
                {photoData ? '📷 Retake Photo' : '📷 Take Photo'}
              </button>
              {photoData && (
                <>
                  <img src={photoData} alt="Exception photo" style={{ width: 48, height: 48, borderRadius: 6, objectFit: 'cover', border: '1px solid #555' }} />
                  <button onClick={() => setPhotoData(null)}
                    style={{ background: 'none', border: 'none', color: '#888', fontSize: 16, cursor: 'pointer', padding: 4 }}>✕</button>
                </>
              )}
            </div>

            <div style={styles.instructionBanner}>
              <span style={styles.instructionIcon}>📦</span>
              <span style={styles.instructionText}>
                Place this item in the <strong>EXCEPTION GAYLORD / BIN</strong>
              </span>
            </div>

            {needsPhoto && !photoData && (
              <p style={{ color: '#F97316', fontSize: 13, marginTop: 8, marginBottom: 0 }}>
                ⚠️ Photo is required when no ISBN or title is provided
              </p>
            )}

            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button onClick={handleSubmit}
                disabled={needsPhoto && !photoData}
                style={{ ...styles.submitBtn, opacity: needsPhoto && !photoData ? 0.5 : 1, cursor: needsPhoto && !photoData ? 'not-allowed' : 'pointer' }}>
                Log Exception
              </button>
              <button
                onClick={() => { setStep('reason'); setIsbn(''); setTitle(''); setReason(''); }}
                style={styles.backBtn}
              >
                ← Back
              </button>
            </div>
          </div>
        )}

        <button onClick={onClose} style={styles.cancelBtn}>
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
    backgroundColor: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
  },
  modal: {
    backgroundColor: 'var(--bg-card, #1a1a1a)',
    borderRadius: 16,
    padding: 32,
    width: '100%',
    maxWidth: 520,
    border: '2px solid #F97316',
    position: 'relative',
  },
  titleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: '#fff',
    margin: 0,
  },
  closeX: {
    background: 'none',
    border: '1px solid #555',
    borderRadius: 8,
    color: '#888',
    fontSize: 20,
    width: 40,
    height: 40,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
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
    border: '2px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)',
    color: 'var(--text, #fff)',
    fontSize: 20,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
  },
  input: {
    width: '100%',
    padding: '14px 16px',
    borderRadius: 8,
    border: '1px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)',
    color: 'var(--text, #fff)',
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
  instructionIcon: { fontSize: 24 },
  instructionText: { color: '#fdba74', fontSize: 15, lineHeight: 1.4 },
  submitBtn: {
    flex: 1,
    padding: '14px 20px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#F97316',
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
  },
  backBtn: {
    padding: '14px 20px',
    borderRadius: 8,
    border: '1px solid #555',
    backgroundColor: '#333',
    color: '#ccc',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
  },
  cancelBtn: {
    width: '100%',
    marginTop: 12,
    padding: '12px',
    borderRadius: 8,
    border: '1px solid #444',
    backgroundColor: 'transparent',
    color: '#888',
    fontSize: 14,
    cursor: 'pointer',
  },
};
