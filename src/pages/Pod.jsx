import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection,
  doc,
  getDocs,
  addDoc,
  setDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { isValidISBN, cleanISBN } from '../utils/isbn';
import { playErrorBeep } from '../utils/audio';
import ExceptionModal from '../components/ExceptionModal';

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

// Setup phases
const PHASE_OPERATOR = 'operator';
const PHASE_PAIR_SCANNER = 'pair_scanner';
const PHASE_READY = 'ready';
const PHASE_SCANNING = 'scanning';
const PHASE_PAUSED = 'paused';

export default function Pod() {
  const [searchParams] = useSearchParams();
  const podId = searchParams.get('id') || 'A';

  // Setup phases
  const [phase, setPhase] = useState(PHASE_OPERATOR);
  const [operatorName, setOperatorName] = useState('');
  const [scannerPaired, setScannerPaired] = useState(false);
  const [showSwitchOperator, setShowSwitchOperator] = useState(false);
  const [switchName, setSwitchName] = useState('');

  // Job data
  const [job, setJob] = useState(null);
  const [manifestCache, setManifestCache] = useState({});

  // Scanning state
  const [scanInput, setScanInput] = useState('');
  const [localCount, setLocalCount] = useState(0); // optimistic local count
  const [firestoreCount, setFirestoreCount] = useState(0);
  const [exceptionCount, setExceptionCount] = useState(0);
  const [pace, setPace] = useState(0);
  const [flashColor, setFlashColor] = useState(null);
  const [flashText, setFlashText] = useState('');
  const [showExceptionModal, setShowExceptionModal] = useState(false);
  const [lastScanTime, setLastScanTime] = useState(null);

  const inputRef = useRef(null);
  const pairInputRef = useRef(null);
  const recentScansRef = useRef([]);

  const totalScans = Math.max(localCount, firestoreCount);
  const isScanning = phase === PHASE_SCANNING;
  const isPaused = phase === PHASE_PAUSED;

  // Keep input focused at all times during scanning
  const refocusInput = useCallback(() => {
    if (isScanning && inputRef.current && !showExceptionModal && !showSwitchOperator) {
      inputRef.current.focus();
    }
  }, [isScanning, showExceptionModal, showSwitchOperator]);

  useEffect(() => {
    if (!isScanning) return;
    const handler = () => setTimeout(refocusInput, 50);
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [isScanning, refocusInput]);

  // Also refocus on keydown if not in a modal
  useEffect(() => {
    if (!isScanning) return;
    const handler = (e) => {
      if (!showExceptionModal && !showSwitchOperator) {
        refocusInput();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isScanning, showExceptionModal, showSwitchOperator, refocusInput]);

  // Load active job
  useEffect(() => {
    const q = query(collection(db, 'jobs'), where('meta.active', '==', true));
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const jobDoc = snap.docs[0];
        const data = jobDoc.data();
        setJob({ id: jobDoc.id, ...data });

        if (data.meta.mode === 'multi') {
          getDocs(collection(db, 'jobs', jobDoc.id, 'manifest')).then((ms) => {
            const cache = {};
            ms.forEach((d) => { cache[d.id] = d.data().poName; });
            setManifestCache(cache);
          });
        }
      } else {
        setJob(null);
      }
    });
    return unsub;
  }, []);

  // Presence heartbeat
  useEffect(() => {
    if (phase === PHASE_OPERATOR) return;

    const presenceRef = doc(db, 'presence', podId);

    const writePresence = () => {
      setDoc(presenceRef, {
        podId,
        scanners: scannerPaired ? [operatorName] : [],
        operator: operatorName,
        status: phase,
        online: true,
        lastSeen: serverTimestamp(),
      });
    };

    writePresence();
    const interval = setInterval(writePresence, 30000);
    return () => {
      clearInterval(interval);
      setDoc(presenceRef, { podId, scanners: [], operator: operatorName, status: 'offline', online: false, lastSeen: serverTimestamp() });
    };
  }, [phase, podId, operatorName, scannerPaired]);

  // Listen for scan count for this pod (Firestore sync)
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
      setFirestoreCount(snap.size);

      const now = Date.now();
      const fifteenMinAgo = now - 15 * 60 * 1000;
      const recent = snap.docs.filter((d) => {
        const ts = d.data().timestamp?.toDate?.();
        return ts && ts.getTime() > fifteenMinAgo;
      });
      const elapsed = Math.min(15, (now - today.getTime()) / 60000);
      if (elapsed > 0 && recent.length > 0) {
        setPace(Math.round((recent.length / Math.min(15, elapsed)) * 60));
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
    const unsub = onSnapshot(q, (snap) => setExceptionCount(snap.size));
    return unsub;
  }, [job, podId]);

  const flash = (color, text, duration = 600) => {
    setFlashColor(color);
    setFlashText(text);
    setTimeout(() => { setFlashColor(null); setFlashText(''); }, duration);
  };

  const getCurrentScannerName = () => operatorName;

  const handleScan = (raw) => {
    const isbn = cleanISBN(raw);
    if (!isbn) return;

    if (!isValidISBN(isbn)) {
      playErrorBeep();
      flash('#EF4444', 'INVALID SCAN — RESCAN', 1200);
      return;
    }

    if (!job) {
      flash('#EF4444', 'NO ACTIVE JOB');
      return;
    }

    // Optimistic local count update
    setLocalCount((c) => c + 1);
    setLastScanTime(new Date());
    recentScansRef.current.push(Date.now());

    const scannerName = getCurrentScannerName();

    if (job.meta.mode === 'single') {
      flash('#22C55E', '✓ SCANNED');
      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn,
        poName: job.meta.name, timestamp: serverTimestamp(), type: 'standard',
      });
      return;
    }

    // Multi-PO
    const poName = manifestCache[isbn];
    if (poName) {
      const color = job.poColors?.[poName] || '#22C55E';
      flash(color, `${getColorName(color)} GAYLORD`);
      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn, poName,
        timestamp: serverTimestamp(), type: 'standard',
      });
    } else {
      flash('#F97316', 'NOT IN MANIFEST — EXCEPTIONS PALLET', 1200);
      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn,
        poName: 'EXCEPTIONS', timestamp: serverTimestamp(), type: 'exception',
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

  const handleException = (data) => {
    if (!job) return;
    addDoc(collection(db, 'exceptions'), {
      jobId: job.id, podId: data.podId, scannerId: data.scannerId,
      isbn: data.isbn, title: data.title || null, reason: data.reason,
      timestamp: serverTimestamp(),
    });
  };

  // Scanner pairing handler
  const handlePairScan = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = e.target.value.trim();
      e.target.value = '';
      if (val) {
        setScannerPaired(true);
        setPhase(PHASE_READY);
      }
    }
  };

  // Pace indicator
  const targetPerHour = job
    ? Math.round((job.meta.dailyTarget || 22000) / (job.meta.workingHours || 8) / (job.meta.pods?.length || 5))
    : 550;
  const paceRatio = targetPerHour > 0 ? pace / targetPerHour : 1;
  const paceColor = paceRatio >= 1 ? '#22C55E' : paceRatio >= 0.8 ? '#EAB308' : '#EF4444';

  // ─── PHASE: Enter Operator Name ───
  if (phase === PHASE_OPERATOR) {
    return (
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <div style={styles.stepIndicator}>Step 1 of 2</div>
          <h2 style={styles.setupHeading}>Who's scanning?</h2>
          <p style={styles.setupHint}>Enter the operator name for this scanner station.</p>
          <input
            type="text"
            value={operatorName}
            onChange={(e) => setOperatorName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && operatorName.trim()) {
                setPhase(PHASE_PAIR_SCANNER);
              }
            }}
            placeholder="e.g. John, Maria..."
            style={styles.setupInput}
            autoFocus
          />
          <button
            onClick={() => {
              if (operatorName.trim()) {
                setPhase(PHASE_PAIR_SCANNER);
              }
            }}
            disabled={!operatorName.trim()}
            style={{ ...styles.primaryBtn, marginTop: 16 }}
          >
            Next → Pair Scanner
          </button>
        </div>
      </div>
    );
  }

  // ─── PHASE: Pair Scanner ───
  if (phase === PHASE_PAIR_SCANNER) {
    return (
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <div style={styles.stepIndicator}>Step 2 of 2</div>
          <h2 style={styles.setupHeading}>Pair Scanner</h2>
          <p style={styles.setupHint}>
            Scan <strong>any barcode</strong> with the TERA scanner to confirm it's connected.
          </p>

          <div style={styles.pairBox}>
            <div style={styles.pairPulse} />
            <p style={styles.pairText}>Waiting for scan...</p>
            <input
              ref={pairInputRef}
              type="text"
              onKeyDown={handlePairScan}
              autoFocus
              style={styles.pairInput}
              placeholder="Scanner will type here..."
            />
          </div>

          <div style={styles.scannerStatus}>
            <div style={styles.scannerStatusRow}>
              <div style={{ ...styles.dot, backgroundColor: scannerPaired ? '#22C55E' : '#555' }} />
              <span style={styles.scannerStatusText}>
                Scanner ({operatorName}): {scannerPaired ? '✓ Paired' : 'Waiting...'}
              </span>
            </div>
          </div>

          {scannerPaired && (
            <button
              onClick={() => setPhase(PHASE_READY)}
              style={{ ...styles.primaryBtn, marginTop: 16 }}
            >
              Continue
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── PHASE: Ready (paired, not yet scanning) ───
  if (phase === PHASE_READY) {
    return (
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <h2 style={styles.setupHeading}>✓ Ready to Scan</h2>

          <div style={styles.readySummary}>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>Operator:</span>
              <span style={styles.readyValue}>{operatorName}</span>
            </div>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>Scanner:</span>
              <span style={{ ...styles.readyValue, color: '#22C55E' }}>
                Paired ✓
              </span>
            </div>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>Job:</span>
              <span style={styles.readyValue}>{job?.meta?.name || 'No active job'}</span>
            </div>
          </div>

          <button
            onClick={() => {
              setPhase(PHASE_SCANNING);
              setTimeout(refocusInput, 100);
            }}
            style={{ ...styles.primaryBtn, fontSize: 24, padding: '20px 28px' }}
          >
            ▶ Start Scanning
          </button>
        </div>
      </div>
    );
  }

  // ─── PHASE: Scanning / Paused ───
  return (
    <div
      style={{
        ...styles.container,
        backgroundColor: flashColor || '#111',
        transition: 'background-color 0.15s ease-in',
      }}
    >
      {/* Flash overlay */}
      {flashText && (
        <div style={styles.flashOverlay}>
          <span style={styles.flashText}>{flashText}</span>
        </div>
      )}

      {/* Pause overlay */}
      {isPaused && (
        <div style={styles.pauseOverlay}>
          <div style={styles.pauseBox}>
            <h2 style={{ fontSize: 36, margin: 0, color: '#EAB308' }}>⏸ PAUSED</h2>
            <p style={{ color: '#999', fontSize: 18, margin: '12px 0' }}>
              Operator: {operatorName} · Pod {podId}
            </p>
            <button
              onClick={() => {
                setPhase(PHASE_SCANNING);
                setTimeout(refocusInput, 100);
              }}
              style={{ ...styles.primaryBtn, fontSize: 24, padding: '18px 40px' }}
            >
              ▶ Resume Scanning
            </button>
            <button
              onClick={() => setShowSwitchOperator(true)}
              style={{ ...styles.secondaryBtn, marginTop: 12, fontSize: 16 }}
            >
              🔄 Switch Operator
            </button>
            <Link to="/" style={{ ...styles.secondaryBtn, marginTop: 8, fontSize: 14, textDecoration: 'none', display: 'block', textAlign: 'center' }}>
              ← Back to Home
            </Link>
          </div>

          {showSwitchOperator && (
            <div style={styles.miniModal}>
              <h3 style={{ color: '#fff', marginBottom: 12 }}>Switch Operator</h3>
              <p style={{ color: '#999', fontSize: 14, marginBottom: 8 }}>
                The new operator will use the same paired scanner.
              </p>
              <input
                type="text"
                value={switchName}
                onChange={(e) => setSwitchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && switchName.trim()) {
                    setOperatorName(switchName.trim());
                    setSwitchName('');
                    setShowSwitchOperator(false);
                    setPhase(PHASE_SCANNING);
                    setTimeout(refocusInput, 100);
                  }
                }}
                placeholder="New operator name..."
                style={styles.setupInput}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <button
                  onClick={() => {
                    if (switchName.trim()) {
                      setOperatorName(switchName.trim());
                      setSwitchName('');
                      setShowSwitchOperator(false);
                      setPhase(PHASE_SCANNING);
                      setTimeout(refocusInput, 100);
                    }
                  }}
                  style={styles.primaryBtn}
                >
                  Switch & Resume
                </button>
                <button onClick={() => { setShowSwitchOperator(false); setSwitchName(''); }} style={styles.secondaryBtn}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.podTitle}>Pod {podId}</h1>
          <p style={{ color: '#888', fontSize: 14, margin: 0 }}>
            Operator: {operatorName}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* Scanner status badge */}
          <div style={styles.scannerBadge}>
            <div style={{ ...styles.dot, backgroundColor: '#22C55E' }} />
            {operatorName} — Paired ✓
          </div>

          <button
            onClick={() => setPhase(PHASE_PAUSED)}
            style={styles.pauseBtn}
          >
            ⏸ Pause
          </button>
        </div>
      </div>

      {/* Hidden scan input */}
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
          <div style={{ ...styles.statValue, color: paceColor }}>{pace}</div>
          <div style={styles.statLabel}>Scans/hr (target: {targetPerHour})</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: exceptionCount > 0 ? '#F97316' : '#fff' }}>
            {exceptionCount}
          </div>
          <div style={styles.statLabel}>Exceptions</div>
        </div>
      </div>

      {/* Pace bar */}
      <div style={styles.paceBarContainer}>
        <div style={{ ...styles.paceBar, width: `${Math.min(100, paceRatio * 100)}%`, backgroundColor: paceColor }} />
      </div>

      {/* Last scan indicator */}
      {lastScanTime && (
        <p style={{ textAlign: 'center', color: '#555', fontSize: 13, marginTop: 12 }}>
          Last scan: {lastScanTime.toLocaleTimeString()}
        </p>
      )}

      {/* Exception button */}
      <button onClick={() => setShowExceptionModal(true)} style={styles.exceptionBtn}>
        ⚠️ LOG EXCEPTION
      </button>

      {!job && (
        <div style={styles.warning}>
          No active job found. <Link to="/setup" style={{ color: '#93c5fd' }}>Go to Setup</Link>
        </div>
      )}

      {showExceptionModal && (
        <ExceptionModal
          podId={podId}
          scannerId={getCurrentScannerName()}
          onSubmit={handleException}
          onClose={() => { setShowExceptionModal(false); setTimeout(refocusInput, 100); }}
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
  backLink: {
    color: '#666',
    textDecoration: 'none',
    fontSize: 14,
    marginBottom: 12,
    display: 'inline-block',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    flexWrap: 'wrap',
    gap: 12,
  },
  podTitle: { fontSize: 48, fontWeight: 800, margin: 0 },

  // Scanner badge
  scannerBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 6,
    border: '1px solid #22C55E', backgroundColor: '#14532d',
    color: '#fff', fontSize: 14, fontWeight: 600,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },

  pauseBtn: {
    padding: '8px 16px', borderRadius: 6,
    border: '1px solid #EAB308', backgroundColor: 'rgba(234,179,8,0.1)',
    color: '#EAB308', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },

  hiddenInput: { position: 'absolute', opacity: 0, height: 0, width: 0, top: -100, left: -100 },

  statsRow: { display: 'flex', gap: 24, justifyContent: 'center', marginTop: 40, flexWrap: 'wrap' },
  stat: { textAlign: 'center', minWidth: 160 },
  statValue: { fontSize: 72, fontWeight: 800, lineHeight: 1, color: '#fff' },
  statLabel: { fontSize: 18, color: '#999', marginTop: 8 },

  paceBarContainer: { marginTop: 32, height: 12, backgroundColor: '#333', borderRadius: 6, overflow: 'hidden', maxWidth: 600, alignSelf: 'center', width: '100%' },
  paceBar: { height: '100%', borderRadius: 6, transition: 'width 0.5s ease, background-color 0.5s ease' },

  exceptionBtn: {
    marginTop: 40, alignSelf: 'center', padding: '20px 40px', borderRadius: 12,
    border: '3px solid #F97316', backgroundColor: 'rgba(249,115,22,0.15)',
    color: '#F97316', fontSize: 24, fontWeight: 800, cursor: 'pointer', letterSpacing: 1,
  },

  flashOverlay: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, pointerEvents: 'none' },
  flashText: { fontSize: 72, fontWeight: 900, textAlign: 'center', color: '#fff', textShadow: '2px 2px 8px rgba(0,0,0,0.7)', padding: 20 },

  warning: { marginTop: 32, padding: 16, backgroundColor: '#7f1d1d', borderRadius: 8, textAlign: 'center', fontSize: 18 },

  // Pause overlay
  pauseOverlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    zIndex: 900, gap: 16,
  },
  pauseBox: { textAlign: 'center' },

  // Setup card
  setupCard: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 32, maxWidth: 480, margin: '20px auto' },
  stepIndicator: { fontSize: 13, color: '#666', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  setupHeading: { color: '#fff', fontSize: 28, fontWeight: 700, marginBottom: 8, marginTop: 0 },
  setupHint: { color: '#888', fontSize: 15, marginBottom: 20, lineHeight: 1.4 },
  setupInput: {
    width: '100%', padding: '14px 16px', borderRadius: 8,
    border: '1px solid #444', backgroundColor: '#222', color: '#fff',
    fontSize: 18, boxSizing: 'border-box',
  },

  // Pair scanner
  pairBox: {
    textAlign: 'center', padding: 32, border: '2px dashed #444',
    borderRadius: 12, backgroundColor: '#0a0a0a', marginBottom: 16,
  },
  pairPulse: {
    width: 16, height: 16, borderRadius: '50%', backgroundColor: '#EAB308',
    margin: '0 auto 12px', animation: 'pulse 2s infinite',
  },
  pairText: { color: '#EAB308', fontSize: 18, fontWeight: 600, marginBottom: 12 },
  pairInput: {
    width: '80%', padding: '12px 14px', borderRadius: 8,
    border: '1px solid #555', backgroundColor: '#1a1a1a', color: '#fff',
    fontSize: 16, textAlign: 'center', boxSizing: 'border-box',
  },

  scannerStatus: { marginTop: 12 },
  scannerStatusRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  scannerStatusText: { color: '#ccc', fontSize: 14 },

  // Ready summary
  readySummary: { backgroundColor: '#0a0a0a', borderRadius: 8, padding: 16, marginBottom: 20 },
  readyRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #222' },
  readyLabel: { color: '#888', fontSize: 14 },
  readyValue: { color: '#fff', fontSize: 14, fontWeight: 600 },

  // Buttons
  primaryBtn: {
    width: '100%', padding: '16px 28px', borderRadius: 8, border: 'none',
    backgroundColor: '#22C55E', color: '#fff', fontSize: 18,
    fontWeight: 700, cursor: 'pointer',
  },
  secondaryBtn: {
    width: '100%', padding: '12px 20px', borderRadius: 8,
    border: '1px solid #444', backgroundColor: '#222', color: '#ccc',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },

  modalOverlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  miniModal: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, minWidth: 360 },
};
