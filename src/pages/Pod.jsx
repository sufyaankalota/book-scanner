import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { db } from '../firebase';
import {
  collection, doc, getDocs, getDoc, addDoc, setDoc, deleteDoc,
  query, where, onSnapshot, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { isValidISBN, cleanISBN } from '../utils/isbn';
import { playErrorBeep, playSuccessBeep, playColorBeep } from '../utils/audio';
import ExceptionModal from '../components/ExceptionModal';

const COLOR_NAMES = {
  '#EF4444': 'RED', '#3B82F6': 'BLUE', '#EAB308': 'YELLOW',
  '#22C55E': 'GREEN', '#F97316': 'ORANGE', '#A855F7': 'PURPLE',
  '#EC4899': 'PINK', '#14B8A6': 'TEAL', '#6366F1': 'INDIGO',
  '#84CC16': 'LIME',
};

function getColorName(hex) { return COLOR_NAMES[hex] || hex; }

const PHASE_OPERATOR = 'operator';
const PHASE_PAIR_SCANNER = 'pair_scanner';
const PHASE_READY = 'ready';
const PHASE_SCANNING = 'scanning';
const PHASE_PAUSED = 'paused';

const DEBOUNCE_MS = 1500;
const BARCODE_TIMEOUT_MS = 3000;
const IDLE_WARNING_MS = 120000;

export default function Pod() {
  const [searchParams] = useSearchParams();
  const podId = searchParams.get('id') || 'A';

  // Restore session state
  const savedState = (() => {
    try {
      const s = sessionStorage.getItem(`pod_${podId}_state`);
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  })();

  const [phase, setPhase] = useState(savedState.phase || PHASE_OPERATOR);
  const [operatorName, setOperatorName] = useState(savedState.operatorName || '');
  const [scannerPaired, setScannerPaired] = useState(savedState.scannerPaired || false);
  const [showSwitchOperator, setShowSwitchOperator] = useState(false);
  const [switchName, setSwitchName] = useState('');
  const [podLocked, setPodLocked] = useState(false);

  const [job, setJob] = useState(null);
  const [manifestCache, setManifestCache] = useState({});

  const [scanInput, setScanInput] = useState('');
  const [localCount, setLocalCount] = useState(0);
  const [firestoreCount, setFirestoreCount] = useState(0);
  const [exceptionCount, setExceptionCount] = useState(0);
  const [pace, setPace] = useState(0);
  const [flashColor, setFlashColor] = useState(null);
  const [flashText, setFlashText] = useState('');
  const [showExceptionModal, setShowExceptionModal] = useState(false);
  const [lastScanTime, setLastScanTime] = useState(null);
  const [recentScans, setRecentScans] = useState([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showIdleWarning, setShowIdleWarning] = useState(false);

  const lastScannedRef = useRef({ isbn: '', time: 0 });
  const inputRef = useRef(null);
  const pairInputRef = useRef(null);
  const barcodeTimeoutRef = useRef(null);
  const scanStartTimeRef = useRef(null);
  const dayRef = useRef(new Date().getDate());

  const totalScans = Math.max(localCount, firestoreCount);
  const isScanning = phase === PHASE_SCANNING;
  const isPaused = phase === PHASE_PAUSED;

  // ─── Persist state to sessionStorage ───
  useEffect(() => {
    if (phase !== PHASE_OPERATOR) {
      sessionStorage.setItem(`pod_${podId}_state`, JSON.stringify({
        phase: phase === PHASE_SCANNING ? PHASE_READY : phase,
        operatorName,
        scannerPaired,
      }));
    }
  }, [phase, operatorName, scannerPaired, podId]);

  // ─── Online/offline ───
  useEffect(() => {
    const onOn = () => setIsOnline(true);
    const onOff = () => setIsOnline(false);
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);
    return () => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); };
  }, []);

  // ─── beforeunload warning ───
  useEffect(() => {
    if (!isScanning && !isPaused) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isScanning, isPaused]);

  // ─── Midnight count reset ───
  useEffect(() => {
    const interval = setInterval(() => {
      const today = new Date().getDate();
      if (today !== dayRef.current) {
        dayRef.current = today;
        setLocalCount(0);
        setRecentScans([]);
        scanStartTimeRef.current = null;
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // ─── Scanner idle detection ───
  useEffect(() => {
    if (!isScanning) { setShowIdleWarning(false); return; }
    const interval = setInterval(() => {
      const ref = lastScanTime ? lastScanTime.getTime() : (scanStartTimeRef.current || Date.now());
      setShowIdleWarning(Date.now() - ref > IDLE_WARNING_MS);
    }, 10000);
    return () => clearInterval(interval);
  }, [isScanning, lastScanTime]);

  // ─── Barcode input timeout ───
  useEffect(() => {
    if (!scanInput) return;
    clearTimeout(barcodeTimeoutRef.current);
    barcodeTimeoutRef.current = setTimeout(() => setScanInput(''), BARCODE_TIMEOUT_MS);
    return () => clearTimeout(barcodeTimeoutRef.current);
  }, [scanInput]);

  // ─── Keep input focused ───
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
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler); };
  }, [isScanning, refocusInput]);

  useEffect(() => {
    if (!isScanning) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !showExceptionModal && !showSwitchOperator) {
        e.preventDefault();
        setShowExceptionModal(true);
        return;
      }
      if (!showExceptionModal && !showSwitchOperator) refocusInput();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isScanning, showExceptionModal, showSwitchOperator, refocusInput]);

  // ─── Load active job ───
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

  // ─── Pod lock check ───
  useEffect(() => {
    if (phase !== PHASE_OPERATOR) return;
    (async () => {
      try {
        const presDoc = await getDoc(doc(db, 'presence', podId));
        if (presDoc.exists()) {
          const data = presDoc.data();
          const lastSeen = data.lastSeen?.toDate?.();
          const isRecent = lastSeen && (Date.now() - lastSeen.getTime() < 60000);
          if (data.online && isRecent && data.operator) {
            setPodLocked(true);
          }
        }
      } catch {}
    })();
  }, [phase, podId]);

  // ─── Presence heartbeat ───
  useEffect(() => {
    if (phase === PHASE_OPERATOR) return;
    const presenceRef = doc(db, 'presence', podId);
    const write = () => {
      setDoc(presenceRef, {
        podId, scanners: scannerPaired ? [operatorName] : [],
        operator: operatorName, status: phase, online: true,
        lastSeen: serverTimestamp(),
      });
    };
    write();
    const interval = setInterval(write, 30000);
    return () => {
      clearInterval(interval);
      setDoc(presenceRef, { podId, scanners: [], operator: '', status: 'offline', online: false, lastSeen: serverTimestamp() });
    };
  }, [phase, podId, operatorName, scannerPaired]);

  // ─── Firestore scan count (improved pace) ───
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
      const startRef = scanStartTimeRef.current || now;
      const fifteenMinAgo = now - 15 * 60 * 1000;
      const windowStart = Math.max(fifteenMinAgo, startRef);
      const recent = snap.docs.filter((d) => {
        const ts = d.data().timestamp?.toDate?.();
        return ts && ts.getTime() > windowStart;
      });
      const elapsed = (now - windowStart) / 60000;
      if (elapsed > 0.5 && recent.length > 0) {
        setPace(Math.round((recent.length / elapsed) * 60));
      } else if (elapsed > 2) {
        setPace(0);
      }
    });
    return unsub;
  }, [job, podId]);

  // ─── Exception count ───
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

  // ─── Flash helper ───
  const flash = (color, text, duration = 600) => {
    setFlashColor(color);
    setFlashText(text);
    setTimeout(() => { setFlashColor(null); setFlashText(''); }, duration);
  };

  // ─── Scan handler with debounce + error handling ───
  const handleScan = (raw) => {
    const isbn = cleanISBN(raw);
    if (!isbn) return;

    // Duplicate debounce
    const now = Date.now();
    if (isbn === lastScannedRef.current.isbn && (now - lastScannedRef.current.time) < DEBOUNCE_MS) {
      flash('#EAB308', 'DUPLICATE — SKIPPED', 800);
      return;
    }
    lastScannedRef.current = { isbn, time: now };

    if (!isValidISBN(isbn)) {
      playErrorBeep();
      flash('#EF4444', 'INVALID SCAN — RESCAN', 1200);
      return;
    }

    if (!job) {
      playErrorBeep();
      flash('#EF4444', 'NO ACTIVE JOB');
      return;
    }

    // Optimistic update
    setLocalCount((c) => c + 1);
    setLastScanTime(new Date());
    setShowIdleWarning(false);
    if (!scanStartTimeRef.current) scanStartTimeRef.current = Date.now();

    const scannerName = operatorName;
    const scanId = `s_${now}_${Math.random().toString(36).slice(2, 6)}`;

    if (job.meta.mode === 'single') {
      playSuccessBeep();
      flash('#22C55E', '✓ SCANNED');
      setRecentScans((prev) => [{ id: scanId, isbn, poName: job.meta.name, time: new Date(), docId: null }, ...prev].slice(0, 20));

      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn,
        poName: job.meta.name, timestamp: serverTimestamp(), type: 'standard',
      }).then((docRef) => {
        setRecentScans((prev) => prev.map((s) => s.id === scanId ? { ...s, docId: docRef.id } : s));
      }).catch(() => {
        setLocalCount((c) => Math.max(0, c - 1));
        setRecentScans((prev) => prev.filter((s) => s.id !== scanId));
        playErrorBeep();
        flash('#EF4444', 'WRITE FAILED — RESCAN', 2000);
      });
      return;
    }

    // Multi-PO
    const poName = manifestCache[isbn];
    if (poName) {
      const color = job.poColors?.[poName] || '#22C55E';
      playColorBeep(color);
      flash(color, `${getColorName(color)} GAYLORD`);
      setRecentScans((prev) => [{ id: scanId, isbn, poName, color, time: new Date(), docId: null }, ...prev].slice(0, 20));

      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn, poName,
        timestamp: serverTimestamp(), type: 'standard',
      }).then((docRef) => {
        setRecentScans((prev) => prev.map((s) => s.id === scanId ? { ...s, docId: docRef.id } : s));
      }).catch(() => {
        setLocalCount((c) => Math.max(0, c - 1));
        setRecentScans((prev) => prev.filter((s) => s.id !== scanId));
        playErrorBeep();
        flash('#EF4444', 'WRITE FAILED — RESCAN', 2000);
      });
    } else {
      playErrorBeep();
      flash('#F97316', 'NOT IN MANIFEST — EXCEPTIONS', 1200);
      setRecentScans((prev) => [{ id: scanId, isbn, poName: 'EXCEPTIONS', time: new Date(), docId: null, isException: true }, ...prev].slice(0, 20));

      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn,
        poName: 'EXCEPTIONS', timestamp: serverTimestamp(), type: 'exception',
      }).then((docRef) => {
        setRecentScans((prev) => prev.map((s) => s.id === scanId ? { ...s, docId: docRef.id } : s));
      }).catch(() => {
        setLocalCount((c) => Math.max(0, c - 1));
        setRecentScans((prev) => prev.filter((s) => s.id !== scanId));
        playErrorBeep();
        flash('#EF4444', 'WRITE FAILED — RESCAN', 2000);
      });
    }
  };

  // ─── Undo last scan ───
  const handleUndo = async () => {
    const last = recentScans[0];
    if (!last || !last.docId) return;
    try {
      await deleteDoc(doc(db, 'scans', last.docId));
      setLocalCount((c) => Math.max(0, c - 1));
      setRecentScans((prev) => prev.slice(1));
      flash('#EAB308', 'LAST SCAN REMOVED', 800);
    } catch {
      flash('#EF4444', 'UNDO FAILED', 800);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = scanInput.trim();
      setScanInput('');
      if (val) handleScan(val);
    } else if (e.key.length === 1) {
      // Build barcode from individual keystrokes (works with readOnly + inputMode=none on iPad)
      setScanInput((prev) => prev + e.key);
    }
  };

  const handleException = (data) => {
    if (!job) return;
    addDoc(collection(db, 'exceptions'), {
      jobId: job.id, podId: data.podId, scannerId: data.scannerId,
      isbn: data.isbn, title: data.title || null, reason: data.reason,
      timestamp: serverTimestamp(),
    }).then(() => {
      flash('#F97316', '✓ Exception logged', 1000);
    }).catch(() => {
      flash('#EF4444', 'Failed to log exception', 1000);
    });
  };

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

  // Pace / target calculations
  const targetPerHour = job
    ? Math.round((job.meta.dailyTarget || 22000) / (job.meta.workingHours || 8) / (job.meta.pods?.length || 5))
    : 550;
  const paceRatio = targetPerHour > 0 ? pace / targetPerHour : 1;
  const paceColor = paceRatio >= 1 ? '#22C55E' : paceRatio >= 0.8 ? '#EAB308' : '#EF4444';
  const dailyPodTarget = job ? Math.round((job.meta.dailyTarget || 22000) / (job.meta.pods?.length || 5)) : 0;
  const dailyPct = dailyPodTarget > 0 ? Math.min(100, Math.round((totalScans / dailyPodTarget) * 100)) : 0;

  // ═══════════════════════════════════════════
  // PHASE: Enter Operator Name
  // ═══════════════════════════════════════════
  if (phase === PHASE_OPERATOR) {
    return (
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>← Back to Home</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <div style={styles.stepIndicator}>Step 1 of 2</div>
          <h2 style={styles.setupHeading}>Who's scanning?</h2>
          <p style={styles.setupHint}>Enter the operator name for this scanner station.</p>

          {podLocked && (
            <div style={styles.lockWarning}>
              ⚠️ This pod appears to be in use on another device. Continuing will take over the session.
            </div>
          )}

          <input
            type="text" value={operatorName}
            onChange={(e) => setOperatorName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && operatorName.trim()) {
                setPodLocked(false);
                setPhase(PHASE_PAIR_SCANNER);
              }
            }}
            placeholder="e.g. John, Maria..."
            style={styles.setupInput}
            autoFocus
          />
          <button
            onClick={() => { if (operatorName.trim()) { setPodLocked(false); setPhase(PHASE_PAIR_SCANNER); } }}
            disabled={!operatorName.trim()}
            style={{ ...styles.primaryBtn, marginTop: 16, opacity: operatorName.trim() ? 1 : 0.5 }}
          >
            Next → Pair Scanner
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // PHASE: Pair Scanner
  // ═══════════════════════════════════════════
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
              inputMode="none"
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

  // ═══════════════════════════════════════════
  // PHASE: Ready
  // ═══════════════════════════════════════════
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
              <span style={{ ...styles.readyValue, color: '#22C55E' }}>Paired ✓</span>
            </div>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>Job:</span>
              <span style={styles.readyValue}>{job?.meta?.name || 'No active job'}</span>
            </div>
          </div>
          <button
            onClick={() => { setPhase(PHASE_SCANNING); setTimeout(refocusInput, 100); }}
            style={{ ...styles.primaryBtn, fontSize: 24, padding: '20px 28px' }}
          >
            ▶ Start Scanning
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // PHASE: Scanning / Paused
  // ═══════════════════════════════════════════
  return (
    <div
      style={{
        ...styles.container,
        backgroundColor: flashColor || '#111',
        transition: 'background-color 0.15s ease-in',
      }}
    >
      {/* Offline banner */}
      {!isOnline && (
        <div style={styles.offlineBanner}>
          ⚠️ OFFLINE — scans will sync when reconnected
        </div>
      )}

      {/* Scanner idle warning */}
      {showIdleWarning && !isPaused && (
        <div style={styles.idleWarning}>
          ⚠️ No scans for 2+ minutes — is the scanner connected?
        </div>
      )}

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
              onClick={() => { setPhase(PHASE_SCANNING); setTimeout(refocusInput, 100); }}
              style={{ ...styles.primaryBtn, fontSize: 24, padding: '18px 40px', width: 'auto', marginBottom: 12 }}
            >
              ▶ Resume Scanning
            </button>
            <button
              onClick={() => setShowSwitchOperator(true)}
              style={{ ...styles.secondaryBtn, marginTop: 0, fontSize: 16, width: 280 }}
            >
              🔄 Switch Operator
            </button>
            <Link to="/" style={{ ...styles.secondaryBtn, marginTop: 8, fontSize: 14, textDecoration: 'none', display: 'block', textAlign: 'center', width: 280 }}>
              ← Back to Home
            </Link>
          </div>

          {showSwitchOperator && (
            <div style={styles.miniModal}>
              <h3 style={{ color: '#fff', marginBottom: 12, marginTop: 0 }}>Switch Operator</h3>
              <p style={{ color: '#999', fontSize: 14, marginBottom: 8 }}>
                The new operator will use the same paired scanner.
              </p>
              <input
                type="text" value={switchName}
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
                  style={{ ...styles.primaryBtn, width: 'auto' }}
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
            {operatorName} · {job?.meta?.name || 'No Job'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={styles.scannerBadge}>
            <div style={{ ...styles.dot, backgroundColor: '#22C55E' }} />
            Paired ✓
          </div>
          {recentScans.length > 0 && recentScans[0].docId && (
            <button onClick={handleUndo} style={styles.undoBtn}>↩ Undo</button>
          )}
          <button onClick={() => setPhase(PHASE_PAUSED)} style={styles.pauseBtn}>⏸ Pause</button>
        </div>
      </div>

      {/* Hidden scan input — readOnly + inputMode=none prevents iPad virtual keyboard;
          USB scanner keystrokes captured via onKeyDown */}
      <input
        ref={inputRef} type="text"
        onKeyDown={handleKeyDown}
        autoFocus inputMode="none" readOnly
        style={styles.hiddenInput}
        aria-label="Barcode scanner input"
      />

      {/* Stats */}
      <div style={styles.statsRow}>
        <div style={styles.stat}>
          <div style={styles.statValue}>{totalScans.toLocaleString()}</div>
          <div style={styles.statLabel}>Scanned ({dailyPct}% of pod target)</div>
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

      {lastScanTime && (
        <p style={{ textAlign: 'center', color: '#555', fontSize: 13, marginTop: 12 }}>
          Last scan: {lastScanTime.toLocaleTimeString()}
        </p>
      )}

      {/* Recent scans */}
      {recentScans.length > 0 && (
        <div style={styles.recentScans}>
          <div style={styles.recentTitle}>Recent Scans</div>
          {recentScans.slice(0, 8).map((s, i) => (
            <div key={s.id} style={{ ...styles.recentRow, opacity: i === 0 ? 1 : 0.5 + (0.5 / (i + 1)) }}>
              <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 600, color: s.isException ? '#F97316' : '#fff' }}>
                {s.isbn}
              </span>
              {s.poName && s.poName !== 'EXCEPTIONS' && (
                <span style={{ fontSize: 12, fontWeight: 700, color: s.color || '#888' }}>{s.poName}</span>
              )}
              {s.isException && (
                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: '#7f1d1d', color: '#fca5a5', fontWeight: 600 }}>
                  EXCEPTION
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
                {s.time.toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Exception button */}
      <button onClick={() => setShowExceptionModal(true)} style={styles.exceptionBtn}>
        ⚠️ LOG EXCEPTION
      </button>
      <p style={{ textAlign: 'center', color: '#555', fontSize: 12, marginTop: 4 }}>or press Esc</p>

      {!job && (
        <div style={styles.warning}>
          No active job. <Link to="/setup" style={{ color: '#93c5fd' }}>Go to Setup</Link>
        </div>
      )}

      {showExceptionModal && (
        <ExceptionModal
          podId={podId}
          scannerId={operatorName}
          onSubmit={handleException}
          onClose={() => { setShowExceptionModal(false); setTimeout(refocusInput, 100); }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════
const styles = {
  container: {
    minHeight: '100vh', color: '#fff', fontFamily: 'system-ui, sans-serif',
    padding: '16px 12px', display: 'flex', flexDirection: 'column', position: 'relative',
  },
  backLink: { color: '#666', textDecoration: 'none', fontSize: 14, marginBottom: 12, display: 'inline-block' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: 16, flexWrap: 'wrap', gap: 12,
  },
  podTitle: { fontSize: 'clamp(32px, 6vw, 48px)', fontWeight: 800, margin: 0 },

  // Scanner badge
  scannerBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 6,
    border: '1px solid #22C55E', backgroundColor: '#14532d',
    color: '#fff', fontSize: 14, fontWeight: 600,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },

  undoBtn: {
    padding: '8px 14px', borderRadius: 6, border: '1px solid #666',
    backgroundColor: '#333', color: '#ccc', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  pauseBtn: {
    padding: '8px 16px', borderRadius: 6,
    border: '1px solid #EAB308', backgroundColor: 'rgba(234,179,8,0.1)',
    color: '#EAB308', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },

  hiddenInput: { position: 'absolute', opacity: 0, height: 0, width: 0, top: -100, left: -100 },

  statsRow: { display: 'flex', gap: 16, justifyContent: 'center', marginTop: 32, flexWrap: 'wrap' },
  stat: { textAlign: 'center', minWidth: 140 },
  statValue: { fontSize: 'clamp(48px, 10vw, 72px)', fontWeight: 800, lineHeight: 1, color: '#fff' },
  statLabel: { fontSize: 'clamp(13px, 2vw, 18px)', color: '#999', marginTop: 8 },

  paceBarContainer: {
    marginTop: 24, height: 12, backgroundColor: '#333', borderRadius: 6,
    overflow: 'hidden', maxWidth: 600, alignSelf: 'center', width: '100%',
  },
  paceBar: { height: '100%', borderRadius: 6, transition: 'width 0.5s ease, background-color 0.5s ease' },

  exceptionBtn: {
    marginTop: 24, alignSelf: 'center', padding: '18px 36px', borderRadius: 12,
    border: '3px solid #F97316', backgroundColor: 'rgba(249,115,22,0.15)',
    color: '#F97316', fontSize: 'clamp(18px, 3vw, 24px)', fontWeight: 800, cursor: 'pointer', letterSpacing: 1,
  },

  flashOverlay: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, pointerEvents: 'none' },
  flashText: { fontSize: 'clamp(48px, 10vw, 72px)', fontWeight: 900, textAlign: 'center', color: '#fff', textShadow: '2px 2px 8px rgba(0,0,0,0.7)', padding: 20 },

  offlineBanner: {
    backgroundColor: '#7f1d1d', border: '1px solid #EF4444', borderRadius: 8,
    padding: '10px 16px', textAlign: 'center', color: '#fca5a5', fontSize: 14,
    fontWeight: 600, marginBottom: 12,
  },
  idleWarning: {
    backgroundColor: '#422006', border: '1px solid #F97316', borderRadius: 8,
    padding: '10px 16px', textAlign: 'center', color: '#fdba74', fontSize: 14,
    fontWeight: 600, marginBottom: 12,
  },
  lockWarning: {
    backgroundColor: '#422006', border: '1px solid #F97316', borderRadius: 8,
    padding: '12px 16px', color: '#fdba74', fontSize: 14,
    fontWeight: 600, marginBottom: 16, lineHeight: 1.4,
  },
  warning: { marginTop: 32, padding: 16, backgroundColor: '#7f1d1d', borderRadius: 8, textAlign: 'center', fontSize: 18 },

  recentScans: {
    marginTop: 24, backgroundColor: '#1a1a1a', borderRadius: 10,
    border: '1px solid #333', overflow: 'hidden', maxHeight: 260,
    overflowY: 'auto', alignSelf: 'center', width: '100%', maxWidth: 600,
  },
  recentTitle: {
    padding: '8px 14px', borderBottom: '1px solid #333',
    color: '#888', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: 1,
  },
  recentRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '6px 14px', borderBottom: '1px solid #222',
  },

  // Pause overlay
  pauseOverlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    zIndex: 900, gap: 16, padding: 24,
  },
  pauseBox: { textAlign: 'center' },

  // Setup card
  setupCard: {
    backgroundColor: '#1a1a1a', borderRadius: 12, padding: '24px 20px',
    maxWidth: 480, margin: '20px auto', width: '100%',
  },
  stepIndicator: { fontSize: 13, color: '#666', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  setupHeading: { color: '#fff', fontSize: 'clamp(22px, 4vw, 28px)', fontWeight: 700, marginBottom: 8, marginTop: 0 },
  setupHint: { color: '#888', fontSize: 15, marginBottom: 20, lineHeight: 1.4 },
  setupInput: {
    width: '100%', padding: '14px 16px', borderRadius: 8,
    border: '1px solid #444', backgroundColor: '#222', color: '#fff',
    fontSize: 18, boxSizing: 'border-box',
  },

  // Pair scanner
  pairBox: {
    textAlign: 'center', padding: '24px 16px', border: '2px dashed #444',
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
    padding: '12px 20px', borderRadius: 8,
    border: '1px solid #444', backgroundColor: '#222', color: '#ccc',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },

  miniModal: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, minWidth: 320, maxWidth: '90vw' },
};
