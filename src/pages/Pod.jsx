import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { isValidISBN, cleanISBN } from '../utils/isbn';
import { playErrorBeep } from '../utils/audio';
import ExceptionModal from '../components/ExceptionModal';
import ScannerSelector from '../components/ScannerSelector';

// Color name lookup for display
const COLOR_NAMES = {
  '#EF4444': 'RED',
  '#3B82F6': 'BLUE',
  '#EAB308': 'YELLOW',
  '#22C55E': 'GREEN',
  '#F97316': 'ORANGE',
  '#A855F7': 'PURPLE',
};

function getColorName(hex) {
  return COLOR_NAMES[hex] || hex;
}

export default function Pod() {
  const [searchParams] = useSearchParams();
  const podId = searchParams.get('id') || 'A';

  // Setup phase
  const [setupDone, setSetupDone] = useState(false);
  const [scanner1, setScanner1] = useState('');
  const [scanner2, setScanner2] = useState('');
  const [activeScanner, setActiveScanner] = useState(1);
  const [showRegister2, setShowRegister2] = useState(false);
  const [scanner2Input, setScanner2Input] = useState('');

  // Job data
  const [job, setJob] = useState(null);
  const [manifestCache, setManifestCache] = useState({});

  // Scanning state
  const [scanInput, setScanInput] = useState('');
  const [totalScans, setTotalScans] = useState(0);
  const [exceptionCount, setExceptionCount] = useState(0);
  const [pace, setPace] = useState(0);
  const [flashColor, setFlashColor] = useState(null);
  const [flashText, setFlashText] = useState('');
  const [showExceptionModal, setShowExceptionModal] = useState(false);

  const inputRef = useRef(null);
  const scanTimestamps = useRef([]);

  // Keep input focused at all times
  const refocusInput = useCallback(() => {
    if (inputRef.current && !showExceptionModal && !showRegister2) {
      inputRef.current.focus();
    }
  }, [showExceptionModal, showRegister2]);

  useEffect(() => {
    const handler = () => refocusInput();
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('keydown', handler);
    };
  }, [refocusInput]);

  // Load active job
  useEffect(() => {
    const loadJob = async () => {
      const q = query(
        collection(db, 'jobs'),
        where('meta.active', '==', true)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const jobDoc = snap.docs[0];
        const data = jobDoc.data();
        setJob({ id: jobDoc.id, ...data });

        // Cache manifest locally for fast lookup
        if (data.meta.mode === 'multi') {
          const manifestSnap = await getDocs(
            collection(db, 'jobs', jobDoc.id, 'manifest')
          );
          const cache = {};
          manifestSnap.forEach((d) => {
            cache[d.id] = d.data().poName;
          });
          setManifestCache(cache);
        }
      }
    };
    loadJob();
  }, []);

  // Listen for scan count for this pod
  useEffect(() => {
    if (!job) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const q = query(
      collection(db, 'scans'),
      where('jobId', '==', job.id),
      where('podId', '==', podId),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );

    const unsub = onSnapshot(q, (snap) => {
      setTotalScans(snap.size);
      // Compute pace from scan timestamps
      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;
      const recentScans = snap.docs.filter((d) => {
        const ts = d.data().timestamp?.toDate?.();
        return ts && ts.getTime() > fifteenMinAgo;
      });
      const minutes = Math.min(15, (now - today.getTime()) / 60000);
      if (minutes > 0 && recentScans.length > 0) {
        setPace(Math.round((recentScans.length / Math.min(15, minutes)) * 60));
      }
    });

    return unsub;
  }, [job, podId]);

  // Listen for exception count
  useEffect(() => {
    if (!job) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const q = query(
      collection(db, 'exceptions'),
      where('jobId', '==', job.id),
      where('podId', '==', podId),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );

    const unsub = onSnapshot(q, (snap) => {
      setExceptionCount(snap.size);
    });

    return unsub;
  }, [job, podId]);

  const flash = (color, text, duration = 600) => {
    setFlashColor(color);
    setFlashText(text);
    setTimeout(() => {
      setFlashColor(null);
      setFlashText('');
    }, duration);
  };

  const handleScan = async (raw) => {
    const isbn = cleanISBN(raw);
    if (!isbn) return;

    const currentScanner =
      activeScanner === 1 ? scanner1 : scanner2 || scanner1;

    // Track timestamps for pace
    scanTimestamps.current.push(Date.now());

    // Validate ISBN
    if (!isValidISBN(isbn)) {
      playErrorBeep();
      flash('#EF4444', 'INVALID SCAN — RESCAN', 1200);
      return;
    }

    if (!job) {
      flash('#EF4444', 'NO ACTIVE JOB');
      return;
    }

    // Single PO mode
    if (job.meta.mode === 'single') {
      flash('#22C55E', '✓ SCANNED');
      // Fire-and-forget write
      addDoc(collection(db, 'scans'), {
        jobId: job.id,
        podId,
        scannerId: currentScanner,
        isbn,
        poName: job.meta.name,
        timestamp: serverTimestamp(),
        type: 'standard',
      });
      return;
    }

    // Multi-PO mode
    const poName = manifestCache[isbn];
    if (poName) {
      const color = job.poColors?.[poName] || '#22C55E';
      const colorName = getColorName(color);
      flash(color, `${colorName} GAYLORD`);
      addDoc(collection(db, 'scans'), {
        jobId: job.id,
        podId,
        scannerId: currentScanner,
        isbn,
        poName,
        timestamp: serverTimestamp(),
        type: 'standard',
      });
    } else {
      // Not in manifest — exceptions pallet
      flash('#F97316', 'NOT IN MANIFEST — EXCEPTIONS PALLET', 1200);
      addDoc(collection(db, 'scans'), {
        jobId: job.id,
        podId,
        scannerId: currentScanner,
        isbn,
        poName: 'EXCEPTIONS',
        timestamp: serverTimestamp(),
        type: 'exception',
      });
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = scanInput.trim();
      setScanInput('');
      if (val) handleScan(val);
    }
  };

  const handleException = async (data) => {
    if (!job) return;
    await addDoc(collection(db, 'exceptions'), {
      jobId: job.id,
      podId: data.podId,
      scannerId: data.scannerId,
      isbn: data.isbn,
      reason: data.reason,
      timestamp: serverTimestamp(),
    });
  };

  const handleRegisterScanner2 = () => {
    if (scanner2Input.trim()) {
      setScanner2(scanner2Input.trim());
      setShowRegister2(false);
      setScanner2Input('');
      setActiveScanner(2);
      setTimeout(refocusInput, 100);
    }
  };

  // Pace indicator
  const targetPerHour = job
    ? Math.round(
        (job.meta.dailyTarget || 22000) /
          (job.meta.workingHours || 8) /
          (job.meta.pods?.length || 5)
      )
    : 550;
  const paceRatio = targetPerHour > 0 ? pace / targetPerHour : 1;
  const paceColor =
    paceRatio >= 1 ? '#22C55E' : paceRatio >= 0.8 ? '#EAB308' : '#EF4444';

  // Scanner setup screen
  if (!setupDone) {
    return (
      <div style={styles.container}>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <h2 style={{ color: '#fff', fontSize: 24, marginBottom: 16 }}>
            Scanner Setup
          </h2>
          <label style={styles.label}>Scanner 1 Name / Operator</label>
          <input
            type="text"
            value={scanner1}
            onChange={(e) => setScanner1(e.target.value)}
            placeholder="e.g. Scanner 1, John..."
            style={styles.setupInput}
            autoFocus
          />
          <button
            onClick={() => {
              if (scanner1.trim()) setSetupDone(true);
            }}
            disabled={!scanner1.trim()}
            style={styles.startBtn}
          >
            Start Scanning
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...styles.container,
        backgroundColor: flashColor || '#111',
        transition: 'background-color 0.15s ease-in',
      }}
    >
      {/* Flash text overlay */}
      {flashText && (
        <div style={styles.flashOverlay}>
          <span style={styles.flashText}>{flashText}</span>
        </div>
      )}

      {/* Header bar */}
      <div style={styles.header}>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <ScannerSelector
          scanner1={scanner1}
          scanner2={scanner2}
          activeScanner={activeScanner}
          onSetActive={setActiveScanner}
          onRegister2={() => setShowRegister2(true)}
        />
      </div>

      {/* Hidden scan input (always focused) */}
      <input
        ref={inputRef}
        type="text"
        value={scanInput}
        onChange={(e) => setScanInput(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        style={styles.hiddenInput}
      />

      {/* Stats */}
      <div style={styles.statsRow}>
        <div style={styles.stat}>
          <div style={styles.statValue}>{totalScans.toLocaleString()}</div>
          <div style={styles.statLabel}>Scanned Today</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: paceColor }}>
            {pace}
          </div>
          <div style={styles.statLabel}>
            Scans/hr (target: {targetPerHour})
          </div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: exceptionCount > 0 ? '#F97316' : '#fff' }}>
            {exceptionCount}
          </div>
          <div style={styles.statLabel}>Exceptions</div>
        </div>
      </div>

      {/* Pace indicator bar */}
      <div style={styles.paceBarContainer}>
        <div
          style={{
            ...styles.paceBar,
            width: `${Math.min(100, paceRatio * 100)}%`,
            backgroundColor: paceColor,
          }}
        />
      </div>

      {/* Exception button */}
      <button
        onClick={() => setShowExceptionModal(true)}
        style={styles.exceptionBtn}
      >
        LOG EXCEPTION
      </button>

      {/* No job warning */}
      {!job && (
        <div style={styles.warning}>
          No active job found. Go to /setup to create one.
        </div>
      )}

      {/* Register Scanner 2 modal */}
      {showRegister2 && (
        <div style={styles.modalOverlay}>
          <div style={styles.miniModal}>
            <h3 style={{ color: '#fff', marginBottom: 12 }}>
              Register Scanner 2
            </h3>
            <input
              type="text"
              value={scanner2Input}
              onChange={(e) => setScanner2Input(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRegisterScanner2();
              }}
              placeholder="Scanner 2 name / operator..."
              style={styles.setupInput}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
              <button onClick={handleRegisterScanner2} style={styles.startBtn}>
                Register
              </button>
              <button
                onClick={() => {
                  setShowRegister2(false);
                  setTimeout(refocusInput, 100);
                }}
                style={styles.cancelBtn}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Exception modal */}
      {showExceptionModal && (
        <ExceptionModal
          podId={podId}
          scannerId={
            activeScanner === 1 ? scanner1 : scanner2 || scanner1
          }
          onSubmit={handleException}
          onClose={() => {
            setShowExceptionModal(false);
            setTimeout(refocusInput, 100);
          }}
        />
      )}
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    color: '#fff',
    fontFamily: 'system-ui, sans-serif',
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  podTitle: {
    fontSize: 48,
    fontWeight: 800,
    margin: 0,
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 0,
    width: 0,
    top: -100,
    left: -100,
  },
  statsRow: {
    display: 'flex',
    gap: 24,
    justifyContent: 'center',
    marginTop: 40,
    flexWrap: 'wrap',
  },
  stat: {
    textAlign: 'center',
    minWidth: 160,
  },
  statValue: {
    fontSize: 72,
    fontWeight: 800,
    lineHeight: 1,
    color: '#fff',
  },
  statLabel: {
    fontSize: 18,
    color: '#999',
    marginTop: 8,
  },
  paceBarContainer: {
    marginTop: 32,
    height: 12,
    backgroundColor: '#333',
    borderRadius: 6,
    overflow: 'hidden',
    maxWidth: 600,
    alignSelf: 'center',
    width: '100%',
  },
  paceBar: {
    height: '100%',
    borderRadius: 6,
    transition: 'width 0.5s ease, background-color 0.5s ease',
  },
  exceptionBtn: {
    marginTop: 40,
    alignSelf: 'center',
    padding: '20px 40px',
    borderRadius: 12,
    border: '3px solid #F97316',
    backgroundColor: 'rgba(249, 115, 22, 0.15)',
    color: '#F97316',
    fontSize: 24,
    fontWeight: 800,
    cursor: 'pointer',
    letterSpacing: 1,
  },
  flashOverlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 500,
    pointerEvents: 'none',
  },
  flashText: {
    fontSize: 72,
    fontWeight: 900,
    textAlign: 'center',
    color: '#fff',
    textShadow: '2px 2px 8px rgba(0,0,0,0.7)',
    padding: 20,
  },
  warning: {
    marginTop: 32,
    padding: 16,
    backgroundColor: '#7f1d1d',
    borderRadius: 8,
    textAlign: 'center',
    fontSize: 18,
  },
  setupCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 32,
    maxWidth: 400,
    margin: '40px auto',
  },
  label: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: '#aaa',
    marginBottom: 6,
  },
  setupInput: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 8,
    border: '1px solid #444',
    backgroundColor: '#222',
    color: '#fff',
    fontSize: 18,
    boxSizing: 'border-box',
  },
  startBtn: {
    marginTop: 16,
    padding: '14px 28px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#22C55E',
    color: '#fff',
    fontSize: 18,
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%',
  },
  cancelBtn: {
    padding: '14px 28px',
    borderRadius: 8,
    border: '1px solid #555',
    backgroundColor: '#333',
    color: '#ccc',
    fontSize: 18,
    fontWeight: 600,
    cursor: 'pointer',
    flex: 1,
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  miniModal: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 32,
    minWidth: 340,
  },
};
