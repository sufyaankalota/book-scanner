import React, { useState, useRef, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { t } from '../utils/locale';
import { createWorker } from 'tesseract.js';

const EXCEPTION_REASON_KEYS = [
  'reasonDamaged',
  'reasonNoIsbn',
  'reasonNotBook',
  'reasonOther',
];

function generateToken() {
  return 'pu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export default function ExceptionModal({ podId, scannerId, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState('');
  const [step, setStep] = useState('reason');
  const [photoData, setPhotoData] = useState(null);
  const [photoMode, setPhotoMode] = useState(null); // 'phone' | null
  const [uploadToken, setUploadToken] = useState('');
  const [phoneWaiting, setPhoneWaiting] = useState(false);
  const titleRef = useRef(null);
  const fileRef = useRef(null);
  const [ocrStatus, setOcrStatus] = useState(''); // '' | 'reading' | 'done' | 'failed'
  const ocrImageRef = useRef(null); // high-res image for OCR

  // Run OCR when photo is captured to auto-fill title
  useEffect(() => {
    if (!photoData || title.trim()) return; // skip if already has title
    let cancelled = false;
    setOcrStatus('reading');
    (async () => {
      try {
        // Use the high-res image if available, otherwise use original photoData
        const imgSrc = ocrImageRef.current || photoData;

        // Upscale image for better OCR accuracy — Tesseract works best at 300+ DPI
        const upscaled = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const TARGET = 1600; // upscale to 1600px for OCR
            const scale = Math.max(TARGET / img.width, TARGET / img.height, 1);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            // Sharpen: use high-quality scaling
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            // Increase contrast for text detection
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = imageData.data;
            for (let i = 0; i < d.length; i += 4) {
              // Convert to grayscale
              const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              // Increase contrast
              const enhanced = gray < 128 ? Math.max(0, gray * 0.7) : Math.min(255, gray * 1.2 + 30);
              d[i] = d[i + 1] = d[i + 2] = enhanced;
            }
            ctx.putImageData(imageData, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = () => resolve(imgSrc); // fallback to original
          img.src = imgSrc;
        });

        const worker = await createWorker('eng');
        let data;
        try {
          ({ data } = await worker.recognize(upscaled));
        } finally {
          try { await worker.terminate(); } catch {}
        }
        if (cancelled) return;

        // Extract best title candidate from OCR results
        // Book titles are typically the largest text, often in the top half of the cover
        const lines = (data.lines || []).filter((l) => l.words && l.words.length > 0);
        if (lines.length > 0) {
          const scored = lines.map((line, idx) => {
            const text = line.text.trim()
              .replace(/[|_~`{}[\]]/g, '') // remove OCR noise characters
              .replace(/\s{2,}/g, ' ')     // collapse multiple spaces
              .trim();
            if (text.length < 2 || text.length > 120) return null;

            const avgConf = line.words.reduce((s, w) => s + w.confidence, 0) / line.words.length;
            if (avgConf < 30) return null;

            // Estimate font size from line bounding box height
            const lineHeight = line.bbox ? (line.bbox.y1 - line.bbox.y0) : 20;

            // Score: larger text (bigger font) + higher confidence + position bonus (top half)
            const positionInPage = lines.length > 1 ? idx / (lines.length - 1) : 0.5;
            const positionBonus = positionInPage < 0.6 ? 1.2 : 0.8; // favor top 60%
            const lengthBonus = Math.min(text.length, 50) / 50; // favor reasonable length
            const score = (avgConf / 100) * lineHeight * positionBonus * (0.5 + lengthBonus * 0.5);

            return { text, score, conf: avgConf, height: lineHeight };
          }).filter(Boolean).sort((a, b) => b.score - a.score);

          if (scored.length > 0) {
            setTitle(scored[0].text);
            setOcrStatus('done');
          } else {
            setOcrStatus('failed');
          }
        } else {
          // Fallback to raw text
          const rawText = (data.text || '').trim();
          const rawLines = rawText.split('\n').map((l) => l.trim()).filter((l) => l.length > 2 && l.length < 120);
          if (rawLines.length > 0) {
            setTitle(rawLines[0]);
            setOcrStatus('done');
          } else {
            setOcrStatus('failed');
          }
        }
      } catch {
        if (!cancelled) setOcrStatus('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [photoData]);

  // Listen for phone upload
  useEffect(() => {
    if (!uploadToken || !phoneWaiting) return;
    const unsub = onSnapshot(doc(db, 'photo-uploads', uploadToken), (snap) => {
      if (snap.exists() && snap.data().photo) {
        const rawPhoto = snap.data().photo;
        // Store full-res for OCR, then compress for display/storage
        ocrImageRef.current = rawPhoto;
        // Compress for Firestore storage
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
        img.onerror = () => setPhotoData(rawPhoto);
        img.src = rawPhoto;
        setPhoneWaiting(false);
        setPhotoMode(null);
        deleteDoc(doc(db, 'photo-uploads', uploadToken)).catch(() => {});
      }
    });
    return unsub;
  }, [uploadToken, phoneWaiting]);

  const handleReasonSelect = (r) => {
    setReason(r);
    setStep('details');
    setTimeout(() => titleRef.current?.focus(), 100);
  };

  // ─── Phone QR upload ───
  const startPhoneUpload = () => {
    const token = generateToken();
    setUploadToken(token);
    setPhoneWaiting(true);
    setPhotoMode('phone');
  };

  const getUploadUrl = () => `${window.location.origin}/upload?t=${uploadToken}`;
  const getQrUrl = () => `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(getUploadUrl())}`;

  const cancelPhoneUpload = () => {
    setPhoneWaiting(false);
    setPhotoMode(null);
    if (uploadToken) deleteDoc(doc(db, 'photo-uploads', uploadToken)).catch(() => {});
  };

  // ─── File upload (fallback) ───
  const handleFilePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // High-res version for OCR (1200px max)
        const ocrCanvas = document.createElement('canvas');
        const OCR_MAX = 1200;
        const ocrScale = Math.min(OCR_MAX / img.width, OCR_MAX / img.height, 1);
        ocrCanvas.width = img.width * ocrScale;
        ocrCanvas.height = img.height * ocrScale;
        ocrCanvas.getContext('2d').drawImage(img, 0, 0, ocrCanvas.width, ocrCanvas.height);
        ocrImageRef.current = ocrCanvas.toDataURL('image/png');

        // Compressed version for Firestore storage
        const canvas = document.createElement('canvas');
        const MAX = 400;
        const scale = Math.min(MAX / img.width, MAX / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        setPhotoData(canvas.toDataURL('image/jpeg', 0.6));
        setPhotoMode(null);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const needsPhoto = !title.trim();

  const handleSubmit = () => {
    if (needsPhoto && !photoData) return;
    // Store English reason text in Firestore for consistency
    const REASON_EN = { reasonDamaged: 'Damaged / Unsellable', reasonNoIsbn: 'No ISBN Barcode', reasonNotBook: 'Not a Book', reasonOther: 'Other' };
    onSubmit({
      reason: REASON_EN[reason] || reason,
      isbn: null,
      title: title.trim() || null,
      photo: photoData || null,
      podId,
      scannerId,
    });
    onClose();
  };

  const handleClose = () => {
    if (uploadToken) deleteDoc(doc(db, 'photo-uploads', uploadToken)).catch(() => {});
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.titleRow}>
          <h2 style={styles.title}>⚠️ {t('logException')}</h2>
          <button onClick={handleClose} style={styles.closeX} aria-label="Close">✕</button>
        </div>

        {step === 'reason' && (
          <div>
            <p style={styles.subtitle}>{t('whatsTheIssue')}</p>
            {EXCEPTION_REASON_KEYS.map((rKey) => (
              <button
                key={rKey}
                onClick={() => handleReasonSelect(rKey)}
                style={styles.reasonBtn}
              >
                {t(rKey)}
              </button>
            ))}
          </div>
        )}

        {step === 'details' && (
          <div>
            <div style={styles.reasonTag}>{t(reason)}</div>

            <div style={{ backgroundColor: '#1e3a5f', border: '1px solid #3B82F6', borderRadius: 8, padding: '12px 14px', marginBottom: 14, color: '#93c5fd', fontSize: 14, lineHeight: 1.5 }}>
              💡 {t('manualEntryHintModal')}
            </div>

            <p style={styles.fieldLabel}>{t('bookTitle')}</p>
            <input ref={titleRef} type="text" value={title}
              onChange={(e) => { setTitle(e.target.value); setOcrStatus(''); }} onKeyDown={handleKeyDown}
              placeholder={ocrStatus === 'reading' ? 'Reading text from photo...' : t('bookTitlePlaceholder')} style={styles.input} />
            {ocrStatus === 'reading' && (
              <p style={{ color: '#93c5fd', fontSize: 12, marginTop: 4, marginBottom: 0 }}>🔍 Extracting title from photo...</p>
            )}
            {ocrStatus === 'done' && title.trim() && (
              <p style={{ color: '#22C55E', fontSize: 12, marginTop: 4, marginBottom: 0 }}>✓ Title extracted from photo — you can edit it above</p>
            )}
            {ocrStatus === 'failed' && (
              <p style={{ color: '#F97316', fontSize: 12, marginTop: 4, marginBottom: 0 }}>Could not read title — please type it manually</p>
            )}

            <p style={{ ...styles.fieldLabel, marginTop: 16, color: needsPhoto && !photoData ? '#F97316' : 'var(--text-secondary, #aaa)' }}>
              📸 {t('photo')} {needsPhoto ? t('photoRequired') : t('photoOptional')}:
            </p>

            {/* Photo preview */}
            {photoData && !photoMode && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
                <img src={photoData} alt="Exception photo"
                  style={{ width: 90, height: 90, borderRadius: 12, objectFit: 'cover', border: '2px solid #555' }} />
                <span style={{ color: '#22C55E', fontSize: 15, fontWeight: 700 }}>✓ {t('photoCaptured')}</span>
                <button onClick={() => { setPhotoData(null); setOcrStatus(''); }}
                  style={{ background: 'none', border: 'none', color: '#888', fontSize: 18, cursor: 'pointer', padding: 6 }}>✕</button>
              </div>
            )}

            {/* Photo capture buttons */}
            {!photoMode && !photoData && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button onClick={startPhoneUpload} style={styles.photoBtn}>📱 {t('takePhotoPhone')}</button>
                <button onClick={() => fileRef.current?.click()} style={styles.photoBtn}>📁 {t('uploadFile')}</button>
                <input ref={fileRef} type="file" accept="image/*" onChange={handleFilePhoto} style={{ display: 'none' }} />
              </div>
            )}

            {/* Retake options */}
            {photoData && !photoMode && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button onClick={() => { setPhotoData(null); startPhoneUpload(); }} style={styles.photoBtnSmall}>📱 {t('retakePhone')}</button>
                <button onClick={() => { setPhotoData(null); fileRef.current?.click(); }} style={styles.photoBtnSmall}>📁 {t('retakeFile')}</button>
              </div>
            )}

            {/* Phone QR upload */}
            {photoMode === 'phone' && (
              <div style={styles.phoneBox}>
                <p style={{ color: '#ccc', fontSize: 14, marginBottom: 10, textAlign: 'center', fontWeight: 600 }}>
                  {t('scanQrHint')}
                </p>
                <div style={{ textAlign: 'center', marginBottom: 8 }}>
                  <img src={getQrUrl()} alt="Upload QR Code"
                    style={{ width: 180, height: 180, borderRadius: 8, background: '#fff', padding: 8 }} />
                </div>
                {phoneWaiting && (
                  <p style={{ color: '#EAB308', fontSize: 14, textAlign: 'center', fontWeight: 700 }}>
                    ⏳ {t('waitingForPhoto')}
                  </p>
                )}
                <button onClick={cancelPhoneUpload}
                  style={{ ...styles.photoBtnSmall, width: '100%', marginTop: 8 }}>{t('cancel')}</button>
              </div>
            )}

            <div style={styles.instructionBanner}>
              <span style={styles.instructionIcon}>📦</span>
              <span style={styles.instructionText}>
                {t('placeInExceptionBin')}
              </span>
            </div>

            {needsPhoto && !photoData && (
              <p style={{ color: '#F97316', fontSize: 14, fontWeight: 700, marginTop: 10, marginBottom: 0 }}>
                ⚠️ {t('photoRequiredWarning')}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={handleSubmit}
                disabled={needsPhoto && !photoData}
                style={{ ...styles.submitBtn, opacity: (needsPhoto && !photoData) ? 0.5 : 1, cursor: (needsPhoto && !photoData) ? 'not-allowed' : 'pointer' }}>
                {t('logException')}
              </button>
              <button onClick={() => { setStep('reason'); setTitle(''); setReason(''); setPhotoData(null); }}
                style={styles.backBtn}>← {t('back')}</button>
            </div>
          </div>
        )}

        <button onClick={handleClose} style={styles.cancelBtn}>{t('cancel')}</button>
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
    padding: 12,
  },
  modal: {
    backgroundColor: 'var(--bg-card, #1a1a1a)',
    borderRadius: 14,
    padding: '28px 24px',
    width: '100%',
    maxWidth: 560,
    border: '2px solid #F97316',
    position: 'relative',
    maxHeight: '92vh',
    overflowY: 'auto',
    fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif",
  },
  titleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 24,
    fontWeight: 800,
    color: '#fff',
    margin: 0,
  },
  closeX: {
    background: 'none',
    border: '1px solid #555',
    borderRadius: 6,
    color: '#888',
    fontSize: 18,
    width: 36,
    height: 36,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  subtitle: {
    fontSize: 17,
    color: '#ccc',
    marginBottom: 14,
    fontWeight: 700,
  },
  reasonTag: {
    display: 'inline-block',
    padding: '8px 14px',
    borderRadius: 8,
    backgroundColor: '#7f1d1d',
    color: '#fca5a5',
    fontSize: 15,
    fontWeight: 700,
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 15,
    color: 'var(--text-secondary, #aaa)',
    marginBottom: 8,
    fontWeight: 700,
  },
  reasonBtn: {
    display: 'block',
    width: '100%',
    padding: '16px 18px',
    marginBottom: 8,
    borderRadius: 10,
    border: '1px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)',
    color: 'var(--text, #fff)',
    fontSize: 17,
    fontWeight: 700,
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
    fontSize: 16,
    boxSizing: 'border-box',
    fontWeight: 600,
  },
  instructionBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    padding: '12px 14px',
    borderRadius: 8,
    backgroundColor: '#422006',
    border: '1px solid #F97316',
  },
  instructionIcon: { fontSize: 24 },
  instructionText: { color: '#fdba74', fontSize: 15, lineHeight: 1.4, fontWeight: 700 },
  submitBtn: {
    flex: 1,
    padding: '14px 20px',
    borderRadius: 10,
    border: 'none',
    backgroundColor: '#F97316',
    color: '#fff',
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
  },
  backBtn: {
    padding: '14px 20px',
    borderRadius: 10,
    border: '1px solid #555',
    backgroundColor: '#333',
    color: '#ccc',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
  },
  photoBtn: {
    padding: '12px 16px', borderRadius: 8, border: '1px solid #555',
    backgroundColor: '#222', color: '#ccc', fontSize: 14, cursor: 'pointer', fontWeight: 700,
  },
  photoBtnSmall: {
    padding: '10px 14px', borderRadius: 8, border: '1px solid #555',
    backgroundColor: '#333', color: 'var(--text-secondary, #aaa)', fontSize: 13, cursor: 'pointer', fontWeight: 600,
  },
  phoneBox: {
    marginBottom: 12, padding: 16, borderRadius: 10,
    border: '1px solid #A855F7', backgroundColor: '#1e1033',
  },
  cancelBtn: {
    width: '100%', marginTop: 12, padding: '12px', borderRadius: 8,
    border: '1px solid #444', backgroundColor: 'transparent', color: '#999', fontSize: 14, fontWeight: 700, cursor: 'pointer',
  },
};
