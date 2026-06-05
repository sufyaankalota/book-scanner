import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { db, functions } from '../firebase';
import { httpsCallable } from 'firebase/functions';
import {
  collection, doc, getDocs, getDocsFromServer, getDoc, addDoc, setDoc, deleteDoc, updateDoc,
  query, where, onSnapshot, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore';
import { isValidISBN, cleanISBN, detectBarcodeType, isbnAlternates } from '../utils/isbn';
import { playErrorBeep, playSuccessBeep, playColorBeep, playDuplicateBeep, playNotInManifestBeep, playAiReadyChime, speak, getVolume, setVolume } from '../utils/audio';
import { checkMilestone, triggerConfetti, getMilestoneMessage } from '../utils/confetti';
import { t, getLang, setLang, tColor } from '../utils/locale';
import { cycleTheme, getTheme } from '../utils/theme';
import { logAudit } from '../utils/audit';
import { exportShiftSummary } from '../utils/export';
import { lookupIsbn, clearChunkCache } from '../utils/manifestStore';
import { classify, MATCH_CONFIDENT, MATCH_AMBIGUOUS } from '../utils/fuzzy';
import { PER_POD_DAILY_TARGET, PER_POD_DAILY_MIN, PER_POD_BONUS_TARGET } from '../utils/target';
import { displayOperatorName } from '../utils/operator';
import ExceptionModal from '../components/ExceptionModal';
import BookCamera from '../components/BookCamera';

const COLOR_NAMES = {
  '#EF4444': 'RED', '#3B82F6': 'BLUE', '#EAB308': 'YELLOW',
  '#22C55E': 'GREEN', '#F97316': 'ORANGE', '#A855F7': 'PURPLE',
  '#EC4899': 'PINK', '#14B8A6': 'TEAL', '#92400E': 'BROWN',
  '#CA8A04': 'GOLD', '#0a0a0a': 'BLACK', '#f5f5f5': 'WHITE',
};
// Approximate name lookup so any close black/white/grey still gets a word
// (and TTS never blurts out a hex code).
function nearestColorName(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  // Greyscale: pick the closest neutral by luminance
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min <= 20) {
    if (max <= 40) return 'BLACK';
    if (max >= 215) return 'WHITE';
    return 'GREY';
  }
  return null;
}
function getColorName(hex) {
  if (!hex) return '';
  const k = String(hex).toLowerCase();
  for (const [key, name] of Object.entries(COLOR_NAMES)) {
    if (key.toLowerCase() === k) return name;
  }
  const near = nearestColorName(hex);
  if (near) return near;
  // Don't fall back to hex — TTS would read it digit by digit.
  return 'COLOR';
}
// Pick contrasting text color for a given flash background.
function isLightColor(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  // Perceptual luminance — anything brighter than mid-grey gets dark text
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160;
}

const PHASE_OPERATOR = 'operator';
const PHASE_PAIR_SCANNER = 'pair_scanner';
const PHASE_READY = 'ready';
const PHASE_SCANNING = 'scanning';
const PHASE_PAUSED = 'paused';

const DEBOUNCE_MS = 5000;
const BARCODE_TIMEOUT_MS = 3000;
const IDLE_WARNING_MS = 120000;
const AUTO_CLOSE_SHIFT_MS = 30 * 60 * 1000; // 30 minutes idle → auto-close shift

export default function Pod() {
  const [searchParams] = useSearchParams();
  const podId = (searchParams.get('id') || 'A').trim().toUpperCase();
  const fromPods = searchParams.get('from') === 'pods';
  const backPath = fromPods ? '/pods' : '/';
  const navigate = useNavigate();

  const savedState = (() => {
    try {
      // Pod shift state persists across page reloads AND laptop restarts
      // (localStorage, not sessionStorage). Auto-discards if it's from a
      // previous calendar day so a stale shift never carries over.
      const raw = localStorage.getItem(`pod_${podId}_state`);
      if (!raw) return {};
      const s = JSON.parse(raw);
      const today = new Date().toDateString();
      if (s.shiftDate && s.shiftDate !== today) {
        localStorage.removeItem(`pod_${podId}_state`);
        return {};
      }
      return s;
    } catch { return {}; }
  })();

  const [phase, setPhase] = useState(savedState.phase || PHASE_OPERATOR);
  const [operatorName, setOperatorName] = useState(savedState.operatorName || '');
  const [scannerPaired, setScannerPaired] = useState(savedState.scannerPaired || false);
  const [showSwitchOperator, setShowSwitchOperator] = useState(false);
  const [switchName, setSwitchName] = useState('');
  const [podLocked, setPodLocked] = useState(false);

  const [job, setJob] = useState(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [jobError, setJobError] = useState(null);
  const [manifestCache, setManifestCache] = useState({});
  // Title index for AI cover-photo → ISBN fuzzy match. Loaded lazily once
  // per job. Stays empty if the manifest doesn't include titles.
  // Title-index for AI cover match lives server-side (matchManifestTitle).
  const [aiMatchCandidates, setAiMatchCandidates] = useState(null); // { capturedTitle, photo, candidates: [...], seq } when ambiguous
  // True while a server-side AI match call is in flight (between camera snap
  // and candidate panel). Surfaced as a non-blocking pill so operators can
  // keep scanning regular barcodes during the wait.
  const [aiProcessing, setAiProcessing] = useState(false);
  // Running counter so each AI snap gets a visible sequence number ("AI #3")
  // — lets operators correlate a panel/recent-scans row to the physical
  // book they photographed instead of guessing.
  const aiSeqRef = useRef(0);
  // Mini history of resolved AI matches this shift, shown in the pinned
  // right-side rail so operators can audit what AI has done recently.
  // Newest first, capped at 6 entries.
  const [aiHistory, setAiHistory] = useState([]); // [{ seq, isbn, poName, color, photo, title, time }]
  const [showTitleSearch, setShowTitleSearch] = useState(false);
  const [titleSearchQuery, setTitleSearchQuery] = useState('');
  const [titleSearchBusy, setTitleSearchBusy] = useState(false);
  const [exceptionPrefill, setExceptionPrefill] = useState(null); // { title, photo } when AI couldn't match

  const [localCount, setLocalCount] = useState(0);
  const [firestoreCount, setFirestoreCount] = useState(0);
  const [exceptionCount, setExceptionCount] = useState(0);
  const [autoExceptionCount, setAutoExceptionCount] = useState(0);
  const [manualEntryCount, setManualEntryCount] = useState(0);
  const [pace, setPace] = useState(0);
  const [flashColor, setFlashColor] = useState(null);
  const [flashText, setFlashText] = useState('');
  // When an AI cover-match result lands, instead of stealing the center-screen
  // flash (which would compete with the regular barcode scan's flash) we
  // pulse the right-side AI panel with the bin color. Keeps the two
  // workflows visually in their own lanes.
  const [aiPulse, setAiPulse] = useState(null); // { color, text, seq } | null
  const [showExceptionModal, setShowExceptionModal] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualIsbn, setManualIsbn] = useState('');
  const [showIsbnCamera, setShowIsbnCamera] = useState(false);
  const [duplicateConfirm, setDuplicateConfirm] = useState(null); // legacy; no longer triggered. Kept so guards stay benign until a follow-up sweep.
  const [lastScanTime, setLastScanTime] = useState(null);
  const [recentScans, setRecentScans] = useState([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showIdleWarning, setShowIdleWarning] = useState(false);

  // New feature states
  const [trainingMode, setTrainingMode] = useState(false);
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('pod-fontsize') || '100', 10));
  const [showSettings, setShowSettings] = useState(false);
  const [breakTimer, setBreakTimer] = useState(null); // null | seconds remaining
  const [breakTotal, setBreakTotal] = useState(0);
  const [showBreakPicker, setShowBreakPicker] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState('');
  const [milestoneMsg, setMilestoneMsg] = useState('');
  const [showEndShift, setShowEndShift] = useState(false);
  const [shiftStats, setShiftStats] = useState(null);
  const [supervisorMessage, setSupervisorMessage] = useState('');
  const [volLevel, setVolLevel] = useState(getVolume());
  const [lang, setLangState] = useState(getLang());
  const [theme, setThemeState] = useState(getTheme());

  // ─── New feature states ───
  const [scanStreak, setScanStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0); // loaded per-operator below
  const [lastBarcodeType, setLastBarcodeType] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [breakMinutesUsed, setBreakMinutesUsed] = useState(savedState.breakMinutesUsed || 0);
  const [operatorHistory, setOperatorHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('operator-history') || '[]'); } catch { return []; }
  });
  // Personal record to beat: most recent prior day this operator scanned (any pod).
  // null = not yet queried; { count: 0 } = queried, no prior scans found.
  const [previousBest, setPreviousBest] = useState(null); // { count, dateLabel } | null

  const lastScannedRef = useRef({ isbn: '', time: 0 });
  // Rapid-fire glitch guard: a same-ISBN scan that lands within this many ms
  // of the previous one is treated as a trigger-bounce or stack-of-barcodes
  // glitch — silently dropped, no exception, no count. A legitimate physical
  // duplicate (operator picks up a second copy, orients, pulls trigger) takes
  // longer than this; those go to the duplicate-as-exception path below.
  const RAPID_DUP_COOLDOWN_MS = 2_000;
  const [cooldownToast, setCooldownToast] = useState('');
  const cooldownToastTimerRef = useRef(null);
  const showCooldownToast = (msg) => {
    setCooldownToast(msg);
    if (cooldownToastTimerRef.current) clearTimeout(cooldownToastTimerRef.current);
    cooldownToastTimerRef.current = setTimeout(() => setCooldownToast(''), 1500);
  };
  const inputRef = useRef(null);
  const manualInputRef = useRef(null);
  const pairInputRef = useRef(null);
  // Barcode scanner buffer — a ref (not state) so chars accumulate synchronously.
  // React 18 batches state updates across keydown events that arrive in the same
  // microtask burst (which is exactly how barcode scanners type). Using state
  // caused the Enter handler to read an empty/partial buffer on the first scan.
  const scanBufferRef = useRef('');
  const scanStartTimeRef = useRef(savedState.scanStartAt || null);
  const dayRef = useRef(new Date().getDate());
  const shiftDocRef = useRef(null);
  const breakIntervalRef = useRef(null);
  const [pendingOffline, setPendingOffline] = useState(0);

  // Voice callout for PO color (Multi-PO mode). ON by default; persists per device.
  // Operators want hands/eyes free during scan, so voice helps confirm bin destination.
  const [ttsEnabled, setTtsEnabled] = useState(() => localStorage.getItem('pod-tts') !== '0');

  const totalScans = Math.max(localCount, firestoreCount);
  const isScanning = phase === PHASE_SCANNING;
  const isPaused = phase === PHASE_PAUSED;

  // ─── Save operator to history ───
  const saveOperatorToHistory = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const history = JSON.parse(localStorage.getItem('operator-history') || '[]');
      const filtered = history.filter((n) => n.toLowerCase() !== trimmed.toLowerCase());
      const updated = [trimmed, ...filtered].slice(0, 10);
      localStorage.setItem('operator-history', JSON.stringify(updated));
      setOperatorHistory(updated);
    } catch {}
  };

  // ─── Atomic pod claim ───
  // Race-safe: if another operator is already heartbeating this pod, refuse.
  // Otherwise stamp the claim before advancing — the regular heartbeat will
  // immediately overwrite this with full state.
  const claimPod = async (name) => {
    const ref = doc(db, 'presence', podId);
    try {
      return await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) {
          const d = snap.data();
          const lastSeen = d.lastSeen?.toDate?.();
          const isRecent = lastSeen && Date.now() - lastSeen.getTime() < 60000;
          const otherOperator = d.operator && d.operator.toLowerCase() !== name.trim().toLowerCase();
          if (d.online && isRecent && otherOperator) {
            return { ok: false, currentOperator: d.operator };
          }
        }
        tx.set(ref, {
          podId, operator: name.trim(), status: PHASE_PAIR_SCANNER,
          online: true, scanners: [], lastSeen: serverTimestamp(),
        }, { merge: true });
        return { ok: true };
      });
    } catch (err) {
      // Network or rules failure — degrade to a soft check (existing podLocked banner).
      return { ok: true, degraded: true, error: err?.message };
    }
  };

  const advanceFromOperator = async () => {
    // Canonicalize: "maria " / "MARIA" / "Maria" all save as "Maria"
    // so future scans roll up to one leaderboard row.
    const name = displayOperatorName(operatorName);
    if (!name) return;
    setOperatorName(name);
    const result = await claimPod(name);
    if (!result.ok) {
      setPodLocked(true);
      flash('#EF4444', `Pod in use by ${result.currentOperator}`, 2500);
      return;
    }
    saveOperatorToHistory(name);
    setPodLocked(false);
    // Fire-and-forget: look up this operator's most recent prior day total
    // so we can show them a record to beat. Doesn't block pod entry.
    loadPreviousBest(name);
    setPhase(PHASE_PAIR_SCANNER);
  };

  // ─── Personal record to beat ───
  // Query the last 7 days of scans for this operator and pick the most recent
  // prior day with any scans. Single getDocs (not realtime). Best-effort: any
  // error just leaves previousBest=null so the UI gracefully hides.
  const loadPreviousBest = async (name) => {
    if (!name) return;
    try {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const weekAgo = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
      const q = query(
        collection(db, 'scans'),
        where('scannerId', '==', name),
        where('timestamp', '>=', Timestamp.fromDate(weekAgo)),
        where('timestamp', '<', Timestamp.fromDate(start)),
      );
      const snap = await getDocs(q);
      if (snap.empty) { setPreviousBest({ count: 0, dateLabel: '' }); return; }
      // Group by local date (YYYY-MM-DD) and pick the most recent.
      const byDay = new Map();
      for (const d of snap.docs) {
        const ts = d.data().timestamp?.toDate?.();
        if (!ts) continue;
        const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
        byDay.set(key, (byDay.get(key) || 0) + 1);
      }
      if (!byDay.size) { setPreviousBest({ count: 0, dateLabel: '' }); return; }
      const sortedKeys = [...byDay.keys()].sort().reverse();
      const topKey = sortedKeys[0];
      const count = byDay.get(topKey);
      // Friendly label: "yesterday" if it's literally yesterday, else weekday name
      const [y, m, dd] = topKey.split('-').map(Number);
      const recordDate = new Date(y, m - 1, dd);
      const yesterday = new Date(start.getTime() - 24 * 60 * 60 * 1000);
      yesterday.setHours(0, 0, 0, 0);
      const isYesterday = recordDate.getTime() === yesterday.getTime();
      const dateLabel = isYesterday ? 'yesterday' : recordDate.toLocaleDateString(undefined, { weekday: 'long' });
      setPreviousBest({ count, dateLabel });
    } catch {
      // Silent fail — motivational ribbon is non-critical.
    }
  };

  // ─── Font size ───
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}%`;
    localStorage.setItem('pod-fontsize', String(fontSize));
    return () => { document.documentElement.style.fontSize = ''; };
  }, [fontSize]);

  // ─── Persist state ───
  // Stored in localStorage (not sessionStorage) so progress survives laptop
  // restarts and re-logins. Cleared only on explicit End Shift, or auto-
  // discarded on next-day load (see savedState loader above).
  useEffect(() => {
    if (phase !== PHASE_OPERATOR) {
      try {
        localStorage.setItem(`pod_${podId}_state`, JSON.stringify({
          phase: phase === PHASE_SCANNING ? PHASE_READY : phase,
          operatorName,
          scannerPaired,
          breakMinutesUsed,
          scanStartAt: scanStartTimeRef.current || null,
          shiftDate: new Date().toDateString(),
        }));
      } catch {}
    }
  }, [phase, operatorName, scannerPaired, breakMinutesUsed, podId]);

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
        setLocalCount(0); setRecentScans([]); scanStartTimeRef.current = null;
        setAiHistory([]); aiSeqRef.current = 0;
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // ─── Load previous-best on operator restore (page refresh mid-shift) ───
  // advanceFromOperator already kicks this off for fresh sign-ins; this covers
  // the case where savedState already had an operator and we never went
  // through PHASE_OPERATOR this load.
  useEffect(() => {
    if (operatorName) {
      loadPreviousBest(operatorName);
    } else {
      setPreviousBest(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatorName]);

  // ─── Scanner idle detection (visual warning only — disconnect alarm disabled) ───
  useEffect(() => {
    if (!isScanning) { setShowIdleWarning(false); return; }
    const interval = setInterval(() => {
      const ref = lastScanTime ? lastScanTime.getTime() : (scanStartTimeRef.current || Date.now());
      setShowIdleWarning(Date.now() - ref > IDLE_WARNING_MS);
    }, 10000);
    return () => clearInterval(interval);
  }, [isScanning, lastScanTime]); // eslint-disable-line

  // ─── Auto-close idle shift (30 min no scans) ───
  useEffect(() => {
    if (!isScanning || !shiftDocRef.current) return;
    const interval = setInterval(async () => {
      const ref = lastScanTime ? lastScanTime.getTime() : (scanStartTimeRef.current || Date.now());
      if (Date.now() - ref > AUTO_CLOSE_SHIFT_MS) {
        try {
          await updateDoc(doc(db, 'shifts', shiftDocRef.current), {
            endTime: serverTimestamp(), totalScans: totalScans, autoEnded: true,
          });
          logAudit('shift_auto_close', { operator: operatorName, podId, totalScans, reason: '30min_idle' });
          shiftDocRef.current = null;
        } catch {}
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [isScanning, lastScanTime]); // eslint-disable-line

  // ─── Listen for server-side auto-clockout (5:30 PM end-of-day, etc.) ───
  // The autoClockOutEndOfDay scheduled function flips endTime + autoEnded on
  // every active shift. When our own shift closes, finalize the UI just like
  // a manual end-shift so the station doesn't keep showing as active.
  useEffect(() => {
    if (!isScanning || !shiftDocRef.current) return;
    const myShiftId = shiftDocRef.current;
    const unsub = onSnapshot(doc(db, 'shifts', myShiftId), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.endTime && data.autoEnded && shiftDocRef.current === myShiftId) {
        const reason = data.autoEndedReason || 'auto_end';
        logAudit('shift_auto_clockout_received', { operator: operatorName, podId, reason });
        shiftDocRef.current = null;
        flash('#EAB308', `Shift auto-ended (${reason}) — clocking out…`, 4000);
        // Clear local state and bounce to operator screen.
        try { localStorage.removeItem(`pod_${podId}_state`); } catch {}
        setShowEndShift(false);
        setShiftStats(null);
        setPhase(PHASE_OPERATOR);
        setOperatorName('');
        setScannerPaired(false);
        setLocalCount(0);
        setRecentScans([]);
        setAiHistory([]); aiSeqRef.current = 0;
        setScanStreak(0);
        setBreakMinutesUsed(0);
        if (fromPods) navigate('/pods');
      }
    });
    return unsub;
  }, [isScanning, podId, operatorName, fromPods]); // eslint-disable-line

  // ─── Job-wide ISBN dedup (HARD BLOCK across pods, shifts, sessions) ───
  // Source of truth is jobs/{jobId}/scanned-isbns/{isbn} which is maintained
  // by the onScanWrite Cloud Function. We mirror it into a Set and check on
  // every scan. Both ISBN-10 and ISBN-13 forms are kept in the set so a book
  // scanned once as ISBN-13 cannot be re-scanned as its ISBN-10 form.
  // seenIsbnRef remains — still used by the AI picker for the visual badge.
  const seenIsbnRef = useRef(new Set());
  const scannedIsbnsRef = useRef(new Set());
  const [scannedIsbnsLoaded, setScannedIsbnsLoaded] = useState(false);

  const isbnDupKeys = (raw) => {
    const c = cleanISBN(raw || '').toUpperCase();
    if (!c) return [];
    const { isbn13, isbn10 } = isbnAlternates(c);
    const out = new Set([c]);
    if (isbn13) out.add(isbn13);
    if (isbn10) out.add(isbn10);
    return [...out];
  };

  const isAlreadyScannedForJob = (raw) => {
    const keys = isbnDupKeys(raw);
    for (const k of keys) if (scannedIsbnsRef.current.has(k)) return true;
    return false;
  };

  // Reset caches + subscribe to scanned-isbns when the job changes.
  useEffect(() => {
    seenIsbnRef.current = new Set();
    scannedIsbnsRef.current = new Set();
    setScannedIsbnsLoaded(false);
    if (!job?.id) return;
    const unsub = onSnapshot(collection(db, 'jobs', job.id, 'scanned-isbns'), (snap) => {
      const set = new Set();
      snap.forEach((d) => {
        for (const k of isbnDupKeys(d.id)) set.add(k);
      });
      scannedIsbnsRef.current = set;
      setScannedIsbnsLoaded(true);
    }, () => {
      // If the listener errors out, fail-open so scanning still works —
      // optimistic in-session adds will still catch back-to-back dupes.
      setScannedIsbnsLoaded(true);
    });
    return unsub;
  }, [job?.id]);

  // ─── Offline pending count (Firestore cache indicator) ───
  useEffect(() => {
    if (!isOnline) {
      const interval = setInterval(() => {
        setPendingOffline((prev) => prev); // trigger re-render to check status
      }, 5000);
      return () => clearInterval(interval);
    } else {
      setPendingOffline(0);
    }
  }, [isOnline]);

  // ─── Barcode input timeout ───
  // Reset the scanner buffer if no Enter arrives within BARCODE_TIMEOUT_MS
  // (covers half-typed scans / abandoned input).
  useEffect(() => {
    const id = setInterval(() => {
      if (scanBufferRef.current && Date.now() - (scanBufferRef.lastTs || 0) > BARCODE_TIMEOUT_MS) {
        scanBufferRef.current = '';
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ─── Keep input focused ───
  // NOTE: aiMatchCandidates is intentionally NOT in the blocklist. The AI
  // candidate picker now renders as a non-blocking side panel so operators
  // can keep scanning regular barcodes (with full screen flashes & PO color
  // callouts) while they decide on the AI match. They've been doing this
  // by ear; this just makes it visual.
  const refocusInput = useCallback(() => {
    if (isScanning && inputRef.current && !showExceptionModal && !showSwitchOperator && !showSettings && !showBreakPicker && !showEndShift && !showManualEntry && !duplicateConfirm && !showTitleSearch && !showIsbnCamera) {
      inputRef.current.focus();
    }
  }, [isScanning, showExceptionModal, showSwitchOperator, showSettings, showBreakPicker, showEndShift, showManualEntry, duplicateConfirm, showTitleSearch, showIsbnCamera]);

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
      // ─── Bare numpad shortcuts (no modifier) ───
      // Barcode scanner guns emit Digit0-9 codes; physical numeric keypads
      // emit Numpad0-9. So we can intercept bare numpad keys safely without
      // any chance of colliding with a scan. This is the fastest path for
      // operators — one-finger jump to any action.
      const noModal = !showExceptionModal && !showSwitchOperator && !showSettings && !showManualEntry && !showIsbnCamera && !showBreakPicker && !showEndShift && !duplicateConfirm && !showTitleSearch && !aiMatchCandidates;
      if (noModal && !e.ctrlKey && !e.altKey && !e.metaKey && e.code && e.code.startsWith('Numpad')) {
        // Map numpad keys to the same actions as Ctrl+digit:
        //   NumPad1 = AI camera
        //   NumPad2 = Type ISBN
        //   NumPad3 = Damaged / exception
        //   NumPad4 = Type Title (AI fuzzy)
        //   NumPad0 = Undo last
        //   NumPad. (Decimal) = Pause
        //   NumPad+ (Add)     = Settings toggle
        //   NumPad- (Subtract)= Switch operator
        //   NumPad* (Multiply)= Help/shortcuts overlay
        // Enter on the numpad is left alone so it can submit any focused form.
        switch (e.code) {
          case 'Numpad1':
            e.preventDefault();
            if (aiProcessing || aiMatchCandidates) { flash('#EAB308', 'Resolve current AI match first', 1500); return; }
            setShowIsbnCamera(true);
            return;
          case 'Numpad2':
            e.preventDefault();
            setShowManualEntry(true);
            setTimeout(() => manualInputRef.current?.focus(), 100);
            return;
          case 'Numpad3':
            e.preventDefault();
            setShowExceptionModal(true);
            return;
          case 'Numpad4':
            e.preventDefault();
            setShowTitleSearch(true);
            setTitleSearchQuery('');
            return;
          case 'Numpad0':
            e.preventDefault();
            if (recentScans.length > 0 && recentScans[0].docId && recentScans[0].docId !== 'training') {
              handleUndo();
            }
            return;
          case 'NumpadDecimal':
            e.preventDefault();
            setPhase(PHASE_PAUSED);
            return;
          case 'NumpadAdd':
            e.preventDefault();
            setShowSettings((p) => !p);
            return;
          case 'NumpadSubtract':
            e.preventDefault();
            setPhase(PHASE_PAUSED);
            setShowSwitchOperator(true);
            return;
          case 'NumpadMultiply':
            e.preventDefault();
            setShowShortcuts((p) => !p);
            return;
          default:
            break;
        }
      }
      // Quick-action shortcuts. Use Ctrl+digit (Chromebook-kiosk-safe — F1/F2/F3
      // are reserved by ChromeOS, and scanners never emit Ctrl modifiers so they
      // won't collide with barcode scans).
      if (noModal && e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === '1') {
          e.preventDefault();
          // Don't open a second AI snap while one is still pending — the
          // operator needs to resolve the current panel first to avoid
          // pairing the wrong physical book with the wrong ISBN.
          if (aiProcessing || aiMatchCandidates) {
            flash('#EAB308', 'Resolve current AI match first', 1500);
            return;
          }
          setShowIsbnCamera(true);
          return;
        }
        if (k === '2') {
          e.preventDefault();
          setShowManualEntry(true);
          setTimeout(() => manualInputRef.current?.focus(), 100);
          return;
        }
        if (k === '3') {
          e.preventDefault();
          setShowExceptionModal(true);
          return;
        }
        if (k === '4') {
          e.preventDefault();
          setShowTitleSearch(true);
          setTitleSearchQuery('');
          return;
        }
        // Ctrl+letter actions — keep on left-hand row so operators can hit
        // them without leaving the home position. Scanner guns never emit
        // Ctrl modifiers so these can't collide with a barcode scan.
        if (k === 'u') {
          e.preventDefault();
          if (recentScans.length > 0 && recentScans[0].docId && recentScans[0].docId !== 'training') {
            handleUndo();
          }
          return;
        }
        if (k === 'p') {
          e.preventDefault();
          setPhase(PHASE_PAUSED);
          return;
        }
        if (k === 's') {
          e.preventDefault();
          setPhase(PHASE_PAUSED);
          setShowSwitchOperator(true);
          return;
        }
        if (k === 'e') {
          e.preventDefault();
          handleEndShift();
          return;
        }
        if (k === ',') {
          e.preventDefault();
          setShowSettings((p) => !p);
          return;
        }
      }
      if (e.key === 'Escape' && !showExceptionModal && !showSwitchOperator && !showSettings && !duplicateConfirm && !showEndShift && !showShortcuts && !showTitleSearch && !showManualEntry && !aiMatchCandidates && !showIsbnCamera) {
        e.preventDefault(); setShowExceptionModal(true); return;
      }
      if (e.key === '?' && !showExceptionModal && !showSwitchOperator && !duplicateConfirm && !showEndShift) {
        e.preventDefault(); setShowShortcuts((p) => !p); return;
      }
      if (!showExceptionModal && !showSwitchOperator && !showSettings && !showTitleSearch && !showManualEntry && !aiMatchCandidates) refocusInput();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // handleUndo / handleEndShift are stable in scope and read via closure;
    // recentScans is read via the latest closure when the user actually presses Ctrl+U.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScanning, showExceptionModal, showSwitchOperator, showSettings, showManualEntry, showIsbnCamera, showBreakPicker, showEndShift, duplicateConfirm, showTitleSearch, aiMatchCandidates, refocusInput, recentScans, showShortcuts]);

  // ─── Pause overlay shortcuts ───
  // Visible on the pause screen so operators can pick an action without
  // reaching for the mouse. Single keys (no modifier) are safe here because
  // scanning is paused and the input isn't focused.
  useEffect(() => {
    if (!isPaused || breakTimer !== null) return;
    const handler = (e) => {
      if (showSwitchOperator || showEndShift) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      const k = e.key.toLowerCase();
      // Numpad shortcuts work without modifier so operators can resume / take
      // a break with one finger from the right-hand keypad.
      if (e.code === 'Numpad1' || e.key === ' ' || k === '1' || k === 'r') {
        e.preventDefault(); setPhase(PHASE_SCANNING); setTimeout(refocusInput, 100); return;
      }
      if (e.code === 'Numpad2' || k === '2') {
        e.preventDefault(); setBreakTimer(15 * 60); setBreakTotal(15 * 60); setBreakMinutesUsed((p) => p + 15); return;
      }
      if (e.code === 'Numpad3' || k === '3') {
        e.preventDefault(); setBreakTimer(30 * 60); setBreakTotal(30 * 60); setBreakMinutesUsed((p) => p + 30); return;
      }
      if (e.code === 'NumpadSubtract' || k === 's') {
        e.preventDefault(); setShowSwitchOperator(true); return;
      }
      if (e.code === 'NumpadMultiply' || k === 'e') {
        e.preventDefault(); handleEndShift(); return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaused, breakTimer, showSwitchOperator, showEndShift, refocusInput]);

  // ─── Break-timer overlay shortcut: Space resumes early ───
  useEffect(() => {
    if (breakTimer === null) return;
    const handler = (e) => {
      if (e.key === ' ' || e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setBreakTimer(null); setPhase(PHASE_SCANNING); setTimeout(refocusInput, 100);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [breakTimer, refocusInput]);

  // ─── (Removed) duplicate-confirm keyboard shortcuts ─ dialog no longer fires ───

  // ─── End-shift confirm shortcut: Enter/NumPadEnter/NumPad1 confirms, Esc/NumPad0 cancels ───
  useEffect(() => {
    if (!showEndShift) return;
    const handler = (e) => {
      if (e.key === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Numpad1') { e.preventDefault(); confirmEndShift(); }
      else if (e.key === 'Escape' || e.code === 'Numpad0') { e.preventDefault(); setShowEndShift(false); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEndShift]);

  // ─── Help overlay: Esc closes ───
  useEffect(() => {
    if (!showShortcuts) return;
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); setShowShortcuts(false); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showShortcuts]);

  // ─── Load active job ───
  // We deliberately do NOT use where('meta.active','==',true) here. The
  // pod's persistent local cache can hold a stale empty result for that
  // indexed query while a fresh job exists on the server, which surfaces
  // as "No active job" on every pod even though the dashboard sees the
  // job just fine. Fetching the full jobs list (always small) and filtering
  // client-side sidesteps the stale cached index.
  useEffect(() => {
    let cancelled = false;

    const applySnap = (snap, source) => {
      if (cancelled) return;
      setJobError(null);
      setJobLoading(false);
      let pickedDoc = null;
      snap.forEach((d) => {
        const data = d.data();
        if (data?.meta?.active === true) pickedDoc = { id: d.id, data };
      });
      if (!pickedDoc) {
        const open = [];
        snap.forEach((d) => {
          const data = d.data();
          if (!data?.meta?.closedAt && !data?.meta?.queued) open.push({ id: d.id, data });
        });
        if (open.length === 1) pickedDoc = open[0];
      }
      if (pickedDoc) {
        const picked = { id: pickedDoc.id, ...pickedDoc.data };
        setJob((prev) => (prev && prev.id === picked.id && source === 'cache') ? prev : picked);
        if (picked.meta.mode === 'multi' && !picked.manifestMeta?.chunked) {
          getDocs(collection(db, 'jobs', picked.id, 'manifest')).then((ms) => {
            const cache = {};
            ms.forEach((d) => {
              const data = d.data();
              cache[d.id] = data.poName;
            });
            setManifestCache(cache);
          }).catch((err) => {
            console.error('Failed to load manifest:', err);
            flash('#EF4444', 'Manifest load failed — retry by reloading the page', 4000);
          });
        } else if (picked.manifestMeta?.chunked) {
          clearChunkCache();
        }
      } else {
        setJob(null);
      }
    };

    // 1) Force a server fetch immediately — bypasses any wedged persistent
    //    cache state that previously caused pods to stick on "Loading…".
    getDocsFromServer(collection(db, 'jobs'))
      .then((snap) => applySnap(snap, 'server'))
      .catch((err) => {
        // Server fetch failed — onSnapshot below will still cover us from
        // cache; only surface the error if the live listener never resolves.
        console.warn('Initial server fetch failed, relying on cache listener:', err?.message);
      });

    // 2) Live listener for subsequent updates (and as a cache fallback if
    //    the kiosk is fully offline at boot).
    const unsub = onSnapshot(collection(db, 'jobs'), (snap) => {
      applySnap(snap, snap.metadata.fromCache ? 'cache' : 'server');
    }, (err) => {
      if (cancelled) return;
      console.error('Active-job listener failed:', err);
      setJobError(err?.message || 'Failed to load job');
      setJobLoading(false);
    });

    // 3) Hard safety net — never let pods sit on "Loading…" forever.
    const fallbackTimer = setTimeout(() => {
      if (cancelled) return;
      setJobLoading((wasLoading) => {
        if (wasLoading) setJobError('Timed out fetching active job — check connection and reload.');
        return false;
      });
    }, 8000);

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      unsub();
    };
  }, []);

  // ─── Pod lock check (uses 60s threshold to flag stale sessions sooner) ───
  useEffect(() => {
    if (phase !== PHASE_OPERATOR) return;
    (async () => {
      try {
        const presDoc = await getDoc(doc(db, 'presence', podId));
        if (presDoc.exists()) {
          const data = presDoc.data();
          const lastSeen = data.lastSeen?.toDate?.();
          const isRecent = lastSeen && (Date.now() - lastSeen.getTime() < 60000);
          if (data.online && isRecent && data.operator) setPodLocked(true);
        }
      } catch {}
    })();
  }, [phase, podId]);

  // ─── Presence heartbeat (with supervisor message) ───
  const operatorRef = useRef(operatorName);
  const phaseRef = useRef(phase);
  const scannerPairedRef = useRef(scannerPaired);
  const breakTimerRef = useRef(null);
  useEffect(() => { operatorRef.current = operatorName; }, [operatorName]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { scannerPairedRef.current = scannerPaired; }, [scannerPaired]);
  useEffect(() => { breakTimerRef.current = breakTimer; }, [breakTimer]);

  // ─── Load best streak per-operator ───
  useEffect(() => {
    if (!operatorName) { setBestStreak(0); return; }
    try {
      const v = parseInt(localStorage.getItem(`bestStreak_${operatorName}`) || '0', 10);
      setBestStreak(Number.isFinite(v) ? v : 0);
    } catch { setBestStreak(0); }
    setScanStreak(0);
  }, [operatorName]);

  useEffect(() => {
    if (phase === PHASE_OPERATOR) return;
    const presenceDocRef = doc(db, 'presence', podId);
    const write = () => {
      setDoc(presenceDocRef, {
        podId, scanners: scannerPairedRef.current ? [operatorRef.current] : [],
        operator: operatorRef.current, status: phaseRef.current, online: true,
        onBreak: breakTimerRef.current !== null,
        breakSecondsRemaining: breakTimerRef.current ?? 0,
        lastSeen: serverTimestamp(),
      }, { merge: true });
    };
    write();
    const interval = setInterval(write, 10000);
    const onVisible = () => { if (document.visibilityState === 'visible') write(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    // Listen for supervisor messages
    const unsub = onSnapshot(presenceDocRef, (snap) => {
      const data = snap.data();
      if (data?.message) setSupervisorMessage(data.message);
    });

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      unsub();
      setDoc(presenceDocRef, { podId, scanners: [], operator: '', status: 'offline', online: false, lastSeen: serverTimestamp() }, { merge: true });
    };
  }, [phase === PHASE_OPERATOR, podId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Firestore scan count (per-operator, today) ───
  // We scope this query to the *current operator* so that:
  //   1) the Pod's "Total Scanned" / pace numbers match this operator's
  //      row on Today's Leaderboard (previously the Pod was pod-wide so
  //      Operator B inherited Operator A's count after a switch);
  //   2) switching operators on the same pod gives an immediate clean slate
  //      without any client-side reset gymnastics — the listener naturally
  //      re-queries with the new scannerId.
  // We still need the podId filter (Firestore can't index on scannerId+jobId
  // alone here without an extra composite index) — both filters are cheap
  // because there's an existing index on jobId+podId+timestamp.
  useEffect(() => {
    if (!job || !operatorName) { setFirestoreCount(0); setManualEntryCount(0); setAutoExceptionCount(0); setPace(0); return; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(
      collection(db, 'scans'), where('jobId', '==', job.id),
      where('podId', '==', podId),
      where('scannerId', '==', operatorName),
      where('timestamp', '>=', Timestamp.fromDate(today))
    );
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map((d) => d.data());
      const manualCount = docs.filter((d) => d.source === 'manual').length;
      const autoExcCount = docs.filter((d) => d.type === 'exception' && d.source !== 'manual' && d.source !== 'ai-match').length;
      setFirestoreCount(docs.length);
      setManualEntryCount(manualCount);
      setAutoExceptionCount(autoExcCount);
      const now = Date.now();
      const startRef = scanStartTimeRef.current || now;
      const fifteenMinAgo = now - 15 * 60 * 1000;
      const windowStart = Math.max(fifteenMinAgo, startRef);
      const recent = snap.docs.filter((d) => {
        const ts = d.data().timestamp?.toDate?.();
        return ts && ts.getTime() > windowStart && d.data().type === 'standard';
      });
      const elapsed = (now - windowStart) / 60000;
      if (elapsed > 0.5 && recent.length > 0) setPace(Math.round((recent.length / elapsed) * 60));
      else if (elapsed > 2) setPace(0);
    });
    return unsub;
  }, [job, podId, operatorName]);

  // ─── Manual exception count ───
  useEffect(() => {
    if (!job) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q = query(
      collection(db, 'exceptions'), where('jobId', '==', job.id),
      where('podId', '==', podId), where('timestamp', '>=', Timestamp.fromDate(today))
    );
    const unsub = onSnapshot(q, (snap) => setExceptionCount(snap.size));
    return unsub;
  }, [job, podId]);

  // ─── Break timer countdown ───
  useEffect(() => {
    if (breakTimer === null) { clearInterval(breakIntervalRef.current); return; }
    clearInterval(breakIntervalRef.current);
    breakIntervalRef.current = setInterval(() => {
      setBreakTimer((prev) => {
        if (prev <= 1) {
          clearInterval(breakIntervalRef.current);
          playErrorBeep();
          flash('#EAB308', t('breakDone'), 3000);
          try { new Notification('Break Over!', { body: 'Time to get back to scanning!' }); } catch {}
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(breakIntervalRef.current);
  }, [breakTimer]); // eslint-disable-line

  // ─── Shift tracking ───
  const startShift = async (nameOverride) => {
    if (trainingMode) return;
    const name = nameOverride || operatorName;
    try {
      const docRef = await addDoc(collection(db, 'shifts'), {
        operatorName: name, podId, jobId: job?.id || '',
        startTime: serverTimestamp(), endTime: null, totalScans: 0,
      });
      shiftDocRef.current = docRef.id;
      logAudit('shift_start', { operator: name, podId });
    } catch {}
  };

  const endShift = async () => {
    if (shiftDocRef.current) {
      try {
        await updateDoc(doc(db, 'shifts', shiftDocRef.current), {
          endTime: serverTimestamp(), totalScans: totalScans,
        });
        logAudit('shift_end', { operator: operatorName, podId, totalScans });
      } catch {}
    }
  };

  // ─── Flash helper ───
  const flash = (color, text, duration = 1500) => {
    setFlashColor(color); setFlashText(text);
    setTimeout(() => { setFlashColor(null); setFlashText(''); }, duration);
  };

  // ─── AI panel pulse ───
  // Brief side-panel highlight when an AI match resolves. Lives in its own
  // visual lane (right edge) so it never overlaps a regular barcode scan's
  // center-screen flash.
  const pulseAiPanel = (color, text, seq) => {
    setAiPulse({ color, text, seq });
    setTimeout(() => setAiPulse(null), 2200);
  };

  // Append to the AI mini-history (newest first, max 6 entries).
  const recordAiHistory = ({ seq, isbn, poName, color, photo, title }) => {
    setAiHistory((prev) => [{ seq, isbn, poName, color, photo, title, time: new Date() }, ...prev].slice(0, 6));
  };

  // ─── Scan handler ───
  // opts: { isManual?: bool, source?: 'manual'|'ai-match', capturedTitle?: string, matchScore?: number }
  const handleScan = async (raw, opts = false) => {
    // Back-compat: callers may pass `true` to mean { isManual: true }
    const o = typeof opts === 'boolean' ? { isManual: opts } : (opts || {});
    const isManual = !!o.isManual;
    const isbn = cleanISBN(raw);
    if (!isbn) return;

    // Reject invalid ISBNs BEFORE any side effects (lastScannedRef / seenIsbnRef
    // / duplicate prompts). Otherwise a bad scan poisons the next scan: the
    // following valid book either triggers a phantom duplicate dialog or, if
    // the operator dismisses/confirms it, gets routed to EXCEPTIONS (black bin)
    // because the ref state is out of sync with what was actually written.
    if (!isValidISBN(isbn)) {
      playErrorBeep(); flash('#F59E0B', t('invalidIsbn'), 2000);
      setLastBarcodeType(detectBarcodeType(isbn));
      return;
    }

    // Rapid-fire glitch guard — same ISBN as the previous scan within 2s.
    // This is the trigger-bounce / sheet-of-barcodes abuse path: silent drop,
    // no exception, no count. A real physical duplicate from a stack takes
    // longer than 2s to pick up + orient + trigger, so those fall through to
    // the duplicate-as-exception path below.
    if (isbn === lastScannedRef.current.isbn && (Date.now() - lastScannedRef.current.time) < RAPID_DUP_COOLDOWN_MS) {
      showCooldownToast(`🔁 ${isbn} — rapid repeat, ignored`);
      return;
    }

    // HARD duplicate block (legitimate path) — a book that's already been
    // scanned for this job (any pod, any shift, ISBN-10 or ISBN-13 form) is
    // logged as an exception. Operator gets credit (exceptions are billable),
    // the duplicate is visible in the customer portal, but the standard scan
    // count isn't inflated.
    if (isAlreadyScannedForJob(isbn)) {
      playDuplicateBeep();
      flash('#EF4444', `🚫 ${isbn} — duplicate, logged as exception`, 2500);
      lastScannedRef.current = { isbn, time: Date.now() };
      addDoc(collection(db, 'exceptions'), {
        jobId: job.id,
        podId,
        scannerId: scannerName,
        isbn,
        title: o.capturedTitle || null,
        reason: 'Duplicate scan — already scanned for this job',
        photo: o.capturedPhoto || null,
        timestamp: serverTimestamp(),
        source: o.source || 'scan',
      }).catch(() => {});
      return;
    }

    lastScannedRef.current = { isbn, time: Date.now() };
    seenIsbnRef.current.add(isbn);
    for (const k of isbnDupKeys(isbn)) scannedIsbnsRef.current.add(k);
    processScan(isbn, o);
  };

  // Verify the manager PIN against config/supervisor (hashed or legacy plaintext).
  // (Kept as a stub so any remaining callers compile; duplicate-PIN flow has been removed.)
  const verifyManagerPin = async () => false;

  const confirmDuplicate = () => {
    if (!duplicateConfirm) return;
    setDuplicateConfirm(null);
  };

  const cancelDuplicate = () => {
    setDuplicateConfirm(null);
  };

  // ─── AI cover → manifest title fuzzy match ───
  // Treats successful matches as manual entries with source='ai-match' so they
  // bill as an exception line item but still credit toward the right PO.
  const openExceptionForCapture = (capturedTitle, capturedPhoto) => {
    setExceptionPrefill({ title: capturedTitle || '', photo: capturedPhoto || null });
    setShowExceptionModal(true);
  };

  // Run a manifest title match and open the candidate picker.
  // Used by both the AI camera flow and the manual "Search by Title" flow.
  const runTitleMatch = async ({ title, author, coverText, photo, displayTitle, preCandidates }) => {
    if (!job?.id) {
      flash('#EF4444', 'No active job — logging exception', 2500);
      openExceptionForCapture(displayTitle || title || coverText || '', photo);
      return;
    }
    let candidates = Array.isArray(preCandidates) ? preCandidates : null;
    if (!candidates) {
      setAiProcessing(true);
      try {
        // Use extractAndMatch (warm, minInstances=1) in text-only mode instead of
        // matchManifestTitle (min=0) to avoid 60–90s cold starts on typed search.
        const call = httpsCallable(functions, 'extractAndMatch');
        const res = await call({
          jobId: job.id,
          title: title || '',
          author: author || '',
          // no imageBase64 → server skips Vision and matches text directly
          topK: 5,
          minScore: 0.2,
        });
        candidates = res.data?.candidates || [];
      } catch (err) {
        console.error('extractAndMatch (text-only) failed:', err);
        const prefill = coverText || title || author || displayTitle || '';
        flash('#EF4444', 'Title match service unavailable — logging exception', 2500);
        openExceptionForCapture(prefill, photo);
        setAiProcessing(false);
        return;
      } finally {
        setAiProcessing(false);
      }
    }
    // Annotate already-scanned candidates so the picker can mark them disabled.
    // Uses the job-wide dedup set (covers cross-pod / cross-shift / ISBN-10↓13
    // alternates), with the in-session set as a fallback.
    candidates = candidates.map((c) => ({
      ...c,
      alreadyScanned: !!(c.isbn && (isAlreadyScannedForJob(c.isbn) || seenIsbnRef.current.has(cleanISBN(c.isbn)))),
    }));

    const shown = displayTitle || candidates[0]?.variant || title || coverText || author || '';
    // Assign a sequence number so this AI book is visually tied to its
    // panel + recent-scans row + cover thumbnail. Operators can read it off
    // the side panel ("AI #4") and match it to the physical book in hand.
    aiSeqRef.current += 1;
    const seq = aiSeqRef.current;
    // Audible cue so they know to look at the side panel without having to
    // glance up after every barcode scan.
    playAiReadyChime();
    if (!candidates.length) {
      flash('#EAB308', 'No likely matches — log exception or type ISBN', 2200);
      setAiMatchCandidates({ capturedTitle: shown, photo, candidates: [], seq });
      return;
    }
    setAiMatchCandidates({ capturedTitle: shown, photo, candidates, seq });
  };

  const handleAiCoverResult = async (data) => {
    if (!data) return;
    const capturedTitle = (data.title || '').trim();
    const capturedAuthor = (data.author || '').trim();
    const coverText = (data.coverText || '').trim();
    const photo = data.image || null;
    if (!capturedTitle && !capturedAuthor && !coverText) {
      flash('#EF4444', 'AI couldn\u2019t read the cover — please log an exception', 2500);
      openExceptionForCapture('', photo);
      return;
    }
    await runTitleMatch({
      title: capturedTitle,
      author: capturedAuthor,
      coverText,
      photo,
      displayTitle: capturedTitle || coverText || capturedAuthor,
      preCandidates: Array.isArray(data.candidates) ? data.candidates : null,
    });
  };

  const handleTypedTitleSearch = async (typed) => {
    const query = (typed || '').trim();
    if (!query) return;
    await runTitleMatch({
      title: query,
      photo: null,
      displayTitle: query,
    });
  };

  // ─── AI Match picker keyboard shortcuts ───
  // 1-9   → pick candidate at that index
  // m     → switch to manual ISBN entry
  // e     → log exception (with captured title/photo prefilled)
  // Esc   → close picker
  const pickAiCandidate = (idx) => {
    if (!aiMatchCandidates) return;
    const c = aiMatchCandidates.candidates[idx];
    if (!c) return;
    if (c.alreadyScanned) {
      // Route through handleScan so the duplicate is logged as an exception
      // (same path as a barcode rescan). The hard-block in handleScan will
      // catch it; the operator sees the duplicate beep + flash.
      const sel = aiMatchCandidates;
      setAiMatchCandidates(null);
      handleScan(c.isbn, {
        isManual: true,
        source: 'ai-match',
        capturedTitle: sel.capturedTitle,
        matchScore: c.score,
        capturedPhoto: sel.photo,
        aiSeq: sel.seq,
      });
      return;
    }
    const sel = aiMatchCandidates;
    setAiMatchCandidates(null);
    handleScan(c.isbn, {
      isManual: true,
      source: 'ai-match',
      capturedTitle: sel.capturedTitle,
      matchScore: c.score,
      // Pass photo + seq down so the recent-scans row carries a thumbnail
      // and the same AI #N label, letting the operator visually correlate
      // the row to the physical book that was photographed.
      capturedPhoto: sel.photo,
      aiSeq: sel.seq,
    });
  };
  useEffect(() => {
    if (!aiMatchCandidates) return;
    const handler = (e) => {
      // Numpad keys are reserved for the human operator (scanner guns never
      // emit them) so they work even when the hidden scanner input is
      // focused. Top-row digits / letters still respect input focus to
      // avoid hijacking typed text.
      const isNumpad = !!(e.code && e.code.startsWith('Numpad'));
      const tag = (e.target?.tagName || '').toLowerCase();
      if (!isNumpad && (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Numpad1-9 picks candidate immediately (regardless of focus).
      if (isNumpad && e.code >= 'Numpad1' && e.code <= 'Numpad9') {
        const idx = Number(e.code.slice(-1)) - 1;
        if (idx < aiMatchCandidates.candidates.length) {
          e.preventDefault();
          pickAiCandidate(idx);
        }
        return;
      }

      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        if (idx < aiMatchCandidates.candidates.length) {
          e.preventDefault();
          pickAiCandidate(idx);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAiMatchCandidates(null);
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setAiMatchCandidates(null);
        setShowManualEntry(true);
        setTimeout(() => manualInputRef.current?.focus(), 100);
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        const sel = aiMatchCandidates;
        setAiMatchCandidates(null);
        openExceptionForCapture(sel.capturedTitle, sel.photo);
        return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [aiMatchCandidates]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Process scan (after validation/confirmation) ───
  // opts: { isManual?, source?, capturedTitle?, matchScore? }
  const processScan = async (isbn, opts = {}) => {
    if (typeof opts === 'boolean') opts = { isManual: opts };
    const isManual = !!opts.isManual;
    // Default source: 'manual' for typed entries, 'ai-match' is set explicitly by AI flow
    const source = opts.source || (isManual ? 'manual' : null);
    const sourceMeta = source ? { source } : {};
    if (opts.capturedTitle) sourceMeta.capturedTitle = opts.capturedTitle;
    if (typeof opts.matchScore === 'number') sourceMeta.matchScore = opts.matchScore;
    if (opts.duplicateOverride) sourceMeta.duplicateOverride = true;
    const isAiMatch = source === 'ai-match';
    const now = Date.now();

    if (!isValidISBN(isbn)) {
      playErrorBeep(); flash('#F59E0B', t('invalidIsbn'), 2000);
      setLastBarcodeType(detectBarcodeType(isbn));
      return;
    }
    if (!job) { playErrorBeep(); flash('#EF4444', t('noActiveJob')); return; }

    setLastBarcodeType(detectBarcodeType(isbn));
    setLastScanTime(new Date());
    setShowIdleWarning(false);
    if (!scanStartTimeRef.current) scanStartTimeRef.current = Date.now();

    // Always write the canonical operator name so leaderboards roll up correctly
    // even if `operatorName` was somehow set without going through the entry form.
    const scannerName = displayOperatorName(operatorName) || operatorName;
    const scanId = `s_${now}_${Math.random().toString(36).slice(2, 6)}`;

    // Training mode: don't write to Firestore, don't count
    if (trainingMode) {
      playSuccessBeep();
      flash('#818cf8', t('trainingMode') + ' ✓');
      setRecentScans((prev) => [{ id: scanId, isbn, poName: 'TRAINING', time: new Date(), docId: 'training' }, ...prev].slice(0, 20));
      return;
    }

    // Optimistic update — every scan that lands in /scans bumps Total Scans
    // (matches the Kiosk's per-pod count exactly).
    setLocalCount((c) => c + 1);

    // Milestone check
    const newTotal = totalScans + 1;
    const milestone = checkMilestone(newTotal);
    if (milestone) {
      triggerConfetti();
      setMilestoneMsg(getMilestoneMessage(milestone));
      setTimeout(() => setMilestoneMsg(''), 4000);
    }

    // Daily-goal milestones — minimum (1800) and bonus (2200 = gift card).
    // Fire only on the exact scan that crosses the threshold so it celebrates
    // once per shift, not on every subsequent scan.
    if (newTotal === PER_POD_DAILY_MIN) {
      triggerConfetti();
      setMilestoneMsg(`🎯 Minimum hit! ${PER_POD_DAILY_MIN.toLocaleString()} scans — ${PER_POD_BONUS_TARGET - PER_POD_DAILY_MIN} more for a gift card!`);
      setTimeout(() => setMilestoneMsg(''), 5000);
    } else if (newTotal === PER_POD_BONUS_TARGET) {
      triggerConfetti();
      setMilestoneMsg(`🎁 GIFT CARD EARNED! ${PER_POD_BONUS_TARGET.toLocaleString()} scans — keep going, ${operatorName}!`);
      setTimeout(() => setMilestoneMsg(''), 6000);
    }

    if (job.meta.mode === 'single') {
      playSuccessBeep();
      // AI matches announce in their own visual lane (the pinned panel) so the
      // full-screen flash is reserved for regular barcode scans only — keeps
      // the two streams visually disambiguated while the operator multitasks.
      if (isAiMatch) {
        pulseAiPanel('#22C55E', '✓ ' + t('scanSuccess'), opts.aiSeq);
        recordAiHistory({ seq: opts.aiSeq, isbn, poName: job.meta.name, color: '#22C55E', photo: opts.capturedPhoto, title: opts.capturedTitle });
      } else {
        flash('#22C55E', '✓ ' + t('scanSuccess'));
      }
      setScanStreak((s) => { const n = s + 1; if (n > bestStreak) { setBestStreak(n); try { localStorage.setItem(`bestStreak_${operatorName}`, String(n)); } catch {} } return n; });
      setRecentScans((prev) => [{ id: scanId, isbn, poName: job.meta.name, time: new Date(), docId: null, isManual, isAiMatch, capturedPhoto: opts.capturedPhoto || null, capturedTitle: opts.capturedTitle || null, aiSeq: opts.aiSeq || null }, ...prev].slice(0, 20));
      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn,
        poName: job.meta.name, timestamp: serverTimestamp(), type: 'standard', ...sourceMeta,
      }).then((docRef) => {
        setRecentScans((prev) => prev.map((s) => s.id === scanId ? { ...s, docId: docRef.id } : s));
      }).catch(() => {
        setLocalCount((c) => Math.max(0, c - 1));
        setRecentScans((prev) => prev.filter((s) => s.id !== scanId));
        playErrorBeep(); flash('#EF4444', t('writeFailed'), 2000);
      });
      return;
    }

    // Multi-PO
    let poName;
    if (job.manifestMeta?.chunked) {
      const manifestPath = job.manifestSource || `jobs/${job.id}`;
      poName = await lookupIsbn(manifestPath, isbn, job.manifestMeta.numChunks);
    } else {
      poName = manifestCache[isbn];
    }
    if (poName) {
      const color = job.poColors?.[poName] || '#22C55E';
      const poNum = job.poNumbers?.[poName];
      playColorBeep(color);
      if (ttsEnabled) speak(poNum ? t('ttsNumberColor', { n: poNum, color: tColor(getColorName(color)) }) : t('ttsColorOnly', { color: tColor(getColorName(color)) }));
      // AI matches announce in their own visual lane (the pinned panel) so the
      // full-screen flash is reserved for regular barcode scans only.
      if (isAiMatch) {
        pulseAiPanel(color, `${poNum ? `#${poNum} ` : ''}${tColor(getColorName(color))} ${t('gaylord')}`, opts.aiSeq);
        recordAiHistory({ seq: opts.aiSeq, isbn, poName, color, photo: opts.capturedPhoto, title: opts.capturedTitle });
      } else {
        flash(color, `${poNum ? `#${poNum} ` : ''}${tColor(getColorName(color))} ${t('gaylord')}`);
      }
      setScanStreak((s) => { const n = s + 1; if (n > bestStreak) { setBestStreak(n); try { localStorage.setItem(`bestStreak_${operatorName}`, String(n)); } catch {} } return n; });
      setRecentScans((prev) => [{ id: scanId, isbn, poName, color, time: new Date(), docId: null, isManual, isAiMatch, capturedPhoto: opts.capturedPhoto || null, capturedTitle: opts.capturedTitle || null, aiSeq: opts.aiSeq || null }, ...prev].slice(0, 20));
      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn, poName,
        timestamp: serverTimestamp(), type: 'standard', ...sourceMeta,
      }).then((docRef) => {
        setRecentScans((prev) => prev.map((s) => s.id === scanId ? { ...s, docId: docRef.id } : s));
      }).catch(() => {
        setLocalCount((c) => Math.max(0, c - 1));
        setRecentScans((prev) => prev.filter((s) => s.id !== scanId));
        playErrorBeep(); flash('#EF4444', t('writeFailed'), 2000);
      });
    } else {
      playNotInManifestBeep();
      const excColor = job.exceptionColor || '#EF4444';
      const excNum = job.exceptionNumber;
      if (ttsEnabled) speak(excNum ? t('ttsNumberException', { n: excNum, color: tColor(getColorName(excColor)) }) : t('ttsExceptionOnly', { color: tColor(getColorName(excColor)) }));
      // AI matches announce in their own visual lane (the pinned panel) only.
      if (isAiMatch) {
        pulseAiPanel(excColor, `${excNum ? `#${excNum} ` : ''}${tColor(getColorName(excColor))} ${t('exceptions')}`, opts.aiSeq);
        recordAiHistory({ seq: opts.aiSeq, isbn, poName: 'EXCEPTIONS', color: excColor, photo: opts.capturedPhoto, title: opts.capturedTitle });
      } else {
        flash(excColor, `${excNum ? `#${excNum} ` : ''}${tColor(getColorName(excColor))} ${t('exceptions')}`, 2000);
      }
      setScanStreak(0);
      setRecentScans((prev) => [{ id: scanId, isbn, poName: 'EXCEPTIONS', time: new Date(), docId: null, isException: true, capturedPhoto: opts.capturedPhoto || null, capturedTitle: opts.capturedTitle || null, aiSeq: opts.aiSeq || null }, ...prev].slice(0, 20));
      addDoc(collection(db, 'scans'), {
        jobId: job.id, podId, scannerId: scannerName, isbn,
        poName: 'EXCEPTIONS', timestamp: serverTimestamp(), type: 'exception', ...sourceMeta,
      }).then((docRef) => {
        setRecentScans((prev) => prev.map((s) => s.id === scanId ? { ...s, docId: docRef.id } : s));
      }).catch(() => {
        setLocalCount((c) => Math.max(0, c - 1));
        setRecentScans((prev) => prev.filter((s) => s.id !== scanId));
        playErrorBeep(); flash('#EF4444', t('writeFailed'), 2000);
      });
    }
  };

  // ─── Undo last scan ───
  const handleUndo = async () => {
    const last = recentScans[0];
    if (!last || !last.docId || last.docId === 'training') return;
    try {
      await deleteDoc(doc(db, 'scans', last.docId));
      setLocalCount((c) => Math.max(0, c - 1));
      setRecentScans((prev) => prev.slice(1));
      flash('#EAB308', t('lastScanRemoved'), 1500);
    } catch { flash('#EF4444', t('undoFailed'), 1500); }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = (scanBufferRef.current || '').trim();
      scanBufferRef.current = '';
      if (val) handleScan(val);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      scanBufferRef.current = (scanBufferRef.current || '') + e.key;
      scanBufferRef.lastTs = Date.now();
    }
  };

  const handleException = (data) => {
    if (!job) return;
    if (trainingMode) {
      flash('#818cf8', t('trainingMode') + ' — ' + t('exceptionNotSaved'));
      return;
    }
    addDoc(collection(db, 'exceptions'), {
      jobId: job.id, podId: data.podId, scannerId: data.scannerId,
      isbn: data.isbn, title: data.title || null, reason: data.reason,
      photo: data.photo || null,
      timestamp: serverTimestamp(),
    }).then(() => flash('#EF4444', '✓ ' + t('exception'), 1000))
      .catch(() => flash('#EF4444', t('failedLogException'), 1000));
  };

  const handlePairScan = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const raw = e.target.value.trim(); e.target.value = '';
      if (!raw) return;
      // Require a real barcode — prevents accidental keyboard pairing or fake input.
      // Accepts ISBN-10/13, EAN-13, UPC-A; falls back to permissive 8–18 digit code.
      const cleaned = cleanISBN(raw);
      const isLikelyBarcode = isValidISBN(cleaned) || /^\d{8,18}$/.test(cleaned);
      if (!isLikelyBarcode) {
        playErrorBeep();
        flash('#EF4444', 'NOT A BARCODE — use scanner', 1500);
        return;
      }
      setScannerPaired(true);
      setPhase(PHASE_READY);
    }
  };

  // End shift summary
  const handleEndShift = async () => {
    const elapsed = scanStartTimeRef.current ? ((Date.now() - scanStartTimeRef.current) / 3600000).toFixed(1) : '0';
    const stats = {
      operator: operatorName, pod: podId, total: totalScans,
      exceptions: autoExceptionCount + exceptionCount, pace,
      hours: elapsed, job: job?.meta?.name || 'Unknown',
      breakMinutes: breakMinutesUsed,
    };
    setShiftStats(stats);
    setShowEndShift(true);
    await endShift();
  };

  const confirmEndShift = () => {
    // Auto-export shift summary
    if (shiftStats && shiftStats.total > 0) {
      try { exportShiftSummary(shiftStats); } catch {}
    }
    setShowEndShift(false); setShiftStats(null);
    setPhase(PHASE_OPERATOR); setOperatorName('');
    setScannerPaired(false); setLocalCount(0);
    setRecentScans([]); scanStartTimeRef.current = null;
    setAiHistory([]); aiSeqRef.current = 0;
    setScanStreak(0); setBreakMinutesUsed(0);
    localStorage.removeItem(`pod_${podId}_state`);
    // On kiosk devices, go back to pod selector
    if (fromPods) navigate('/pods');
  };

  // Dismiss supervisor message
  const dismissMessage = async () => {
    setSupervisorMessage('');
    try {
      await updateDoc(doc(db, 'presence', podId), { message: '' });
    } catch {}
  };

  // Pace / target calculations
  // Daily per-pod target is fixed at 2,200 books — crew size varies day to day.
  const dailyPodTarget = PER_POD_DAILY_TARGET;
  const targetPerHour = Math.round(dailyPodTarget / (job?.meta?.workingHours || 8));
  const paceRatio = targetPerHour > 0 ? pace / targetPerHour : 1;
  const paceColor = paceRatio >= 1 ? '#22C55E' : paceRatio >= 0.8 ? '#EAB308' : '#EF4444';
  const dailyPct = dailyPodTarget > 0 ? Math.min(100, Math.round((totalScans / dailyPodTarget) * 100)) : 0;
  const goalPct = dailyPodTarget > 0 ? Math.min(100, Math.round((targetPerHour * (job?.meta?.workingHours || 8) / dailyPodTarget) * 100)) : 50;

  const scaleStyle = {};

  // ═══════════════════════════════════════════
  // PHASE: Enter Operator Name
  // ═══════════════════════════════════════════
  if (phase === PHASE_OPERATOR) {
    return (
      <div style={styles.container}>
        <Link to={backPath} style={styles.backLink}>{fromPods ? t('backToPods') : t('backToHome')}</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <div style={styles.stepIndicator}>{t('step1Of2')}</div>
          <h2 style={styles.setupHeading}>{t('enterName')}?</h2>
          <p style={styles.setupHint}>{t('operatorHint')}</p>
          {podLocked && (
            <div style={styles.lockWarning}>
              {t('podInUseWarning')}
            </div>
          )}
          <input type="text" value={operatorName}
            onChange={(e) => setOperatorName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && operatorName.trim()) advanceFromOperator();
            }}
            placeholder={t('operatorPlaceholder')} style={styles.setupInput} autoFocus />

          {/* Recent operators quick-select */}
          {operatorHistory.length > 0 && !operatorName.trim() && (
            <div style={{ marginTop: 14 }}>
              <p style={{ color: '#888', fontSize: 14, marginBottom: 6, fontWeight: 600 }}>{t('recentOperators')}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {operatorHistory.slice(0, 6).map((name) => (
                  <button key={name} onClick={() => { setOperatorName(name); }}
                    style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text, #ccc)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => { if (operatorName.trim()) advanceFromOperator(); }}
            disabled={!operatorName.trim()}
            style={{ ...styles.primaryBtn, marginTop: 16, opacity: operatorName.trim() ? 1 : 0.5 }}
          >{t('nextPairScanner')}</button>
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
        <Link to={backPath} style={styles.backLink}>{fromPods ? t('backToPods') : t('backToHome')}</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <div style={styles.stepIndicator}>{t('step2Of2')}</div>
          <h2 style={styles.setupHeading}>{t('pairScanner')}</h2>
          <p style={styles.setupHint}>{t('pairScannerHint')}</p>
          <div style={styles.pairBox}>
            <div style={styles.pairPulse} />
            <p style={styles.pairText}>{t('waitingForScan')}</p>
            <input ref={pairInputRef} type="text" onKeyDown={handlePairScan}
              autoFocus inputMode="none" style={styles.pairInput} placeholder={t('waitingForScanLong')} />
          </div>
          <div style={styles.scannerStatus}>
            <div style={styles.scannerStatusRow}>
              <div style={{ ...styles.dot, backgroundColor: scannerPaired ? '#22C55E' : '#555' }} />
              <span style={styles.scannerStatusText}>
                {t('scannerLabel')} ({operatorName}): {scannerPaired ? '✓ ' + t('paired') : t('waiting') + '...'}
              </span>
            </div>
          </div>
          {scannerPaired && (
            <button onClick={() => setPhase(PHASE_READY)}
              style={{ ...styles.primaryBtn, marginTop: 16 }}>{t('continueBtn')}</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // PHASE: Ready (with settings)
  // ═══════════════════════════════════════════
  if (phase === PHASE_READY) {
    return (
      <div style={styles.container}>
        <Link to={backPath} style={styles.backLink}>{fromPods ? t('backToPods') : t('backToHome')}</Link>
        <h1 style={styles.podTitle}>Pod {podId}</h1>
        <div style={styles.setupCard}>
          <h2 style={styles.setupHeading}>✓ {t('scanReady')}</h2>
          <div style={styles.readySummary}>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>{t('operator')}:</span>
              <span style={styles.readyValue}>{operatorName}</span>
            </div>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>{t('scannerLabel')}:</span>
              <span style={{ ...styles.readyValue, color: '#22C55E' }}>{t('paired')} ✓</span>
            </div>
            <div style={styles.readyRow}>
              <span style={styles.readyLabel}>{t('job')}:</span>
              <span style={styles.readyValue}>{job?.meta?.name || t('noActiveJobLabel')}</span>
            </div>
          </div>

          {/* Personal record to beat */}
          {previousBest && previousBest.count > 0 && (
            <div style={{
              backgroundColor: 'var(--bg-input, #0a0a0a)',
              border: '2px solid #EAB308', borderRadius: 10,
              padding: '14px 18px', marginBottom: 16, textAlign: 'center',
            }}>
              <div style={{ fontSize: 14, color: 'var(--text-secondary, #aaa)', fontWeight: 600, marginBottom: 4 }}>
                🏆 {t('recordToBeat')} ({previousBest.dateLabel})
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, color: '#EAB308', lineHeight: 1 }}>
                {previousBest.count.toLocaleString()}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary, #888)', marginTop: 4 }}>
                {t('beatItToday')}, {operatorName}!
              </div>
            </div>
          )}

          {/* Daily targets — minimum + gift-card bonus */}
          <div style={{
            display: 'flex', gap: 10, marginBottom: 16,
          }}>
            <div style={{
              flex: 1, padding: '12px 14px', borderRadius: 10,
              border: '2px solid #3B82F6', backgroundColor: 'var(--bg-input, #0a0a0a)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary, #93C5FD)', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                🎯 {t('minimum')}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#3B82F6', lineHeight: 1.2 }}>
                {PER_POD_DAILY_MIN.toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>{t('perShift')}</div>
            </div>
            <div style={{
              flex: 1, padding: '12px 14px', borderRadius: 10,
              border: '2px solid #22C55E', backgroundColor: 'var(--bg-input, #0a0a0a)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 12, color: '#86efac', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                🎁 {t('giftCard')}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#22C55E', lineHeight: 1.2 }}>
                {PER_POD_BONUS_TARGET.toLocaleString()}+
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>{t('giftCardHint')}</div>
            </div>
          </div>

          {/* Settings panel in Ready phase */}
          <div style={{ backgroundColor: 'var(--bg-input, #0a0a0a)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <h3 style={{ color: 'var(--text-secondary, #aaa)', fontSize: 15, fontWeight: 700, marginTop: 0, marginBottom: 12 }}>{t('settings')}</h3>

            <label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ color: 'var(--text-secondary, #ccc)', fontSize: 15, minWidth: 95, fontWeight: 600 }}>{t('training')}:</span>
              <button onClick={() => setTrainingMode(!trainingMode)}
                style={{ padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  backgroundColor: trainingMode ? '#818cf8' : 'var(--bg-input, #333)', color: 'var(--text, #fff)', fontSize: 14, fontWeight: 700 }}>
                {trainingMode ? t('onLabel') : t('offLabel')}
              </button>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-secondary, #ccc)', fontSize: 15, minWidth: 95, fontWeight: 600 }}>{t('fontSize')}:</span>
              <input type="range" min={80} max={140} value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ color: 'var(--text-secondary, #888)', fontSize: 14, fontWeight: 600 }}>{fontSize}%</span>
            </label>
            <div style={{ marginLeft: 107, marginBottom: 12, padding: '6px 12px', borderRadius: 6, backgroundColor: 'var(--bg-card, #1a1a1a)', border: '1px solid var(--border, #333)' }}>
              <span style={{ fontSize: `${fontSize * 0.48}px`, fontWeight: 800, color: 'var(--text, #fff)' }}>1,234</span>
              <span style={{ fontSize: `${fontSize * 0.14}px`, color: 'var(--text-secondary, #999)', marginLeft: 8 }}>{t('totalScansPreview')}</span>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ color: 'var(--text-secondary, #ccc)', fontSize: 15, minWidth: 95, fontWeight: 600 }}>{t('volume')}:</span>
              <input type="range" min={0} max={100} value={volLevel}
                onChange={(e) => { const v = Number(e.target.value); setVolLevel(v); setVolume(v); }} style={{ flex: 1 }} />
              <span style={{ color: 'var(--text-secondary, #888)', fontSize: 14, fontWeight: 600 }}>{volLevel}%</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <span style={{ color: 'var(--text-secondary, #ccc)', fontSize: 15, minWidth: 95, fontWeight: 600 }}>{t('language')}:</span>
              <select value={lang} onChange={(e) => { setLang(e.target.value); setLangState(e.target.value); }}
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text, #fff)', fontSize: 15, fontWeight: 600 }}>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--text-secondary, #ccc)', fontSize: 15, minWidth: 95, fontWeight: 600 }}>{t('theme')}:</span>
              <button onClick={() => { const next = cycleTheme(); setThemeState(next); }}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text-secondary, #ccc)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                {theme === 'light' ? '☀️ Light' : theme === 'dark' ? '🌙 Dark' : '🌑 Dim'}
              </button>
            </label>
          </div>

          {trainingMode && (
            <div style={{ backgroundColor: '#312e81', border: '1px solid #818cf8', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#c7d2fe', fontSize: 15, fontWeight: 700 }}>
              🎓 {t('trainingNotSaved')}
            </div>
          )}

          <button onClick={() => { setPhase(PHASE_SCANNING); startShift(); setTimeout(refocusInput, 100); }}
            style={{ ...styles.primaryBtn, fontSize: 24, padding: '20px 28px' }}>
            ▶ {t('startScanning')}
          </button>
        </div>
      </div>
    );
  }

  // Whether the pinned AI side panel is visible. When pinned we widen the
  // main content area (drop maxWidth + center) so stat numbers, the pace
  // bar, recent-scan rows etc. don't get squished under the 380px reservation.
  const aiPanelVisible = !!(aiMatchCandidates || aiProcessing || aiHistory.length > 0 || showIsbnCamera);

  // ═══════════════════════════════════════════
  // PHASE: Scanning / Paused
  // ═══════════════════════════════════════════
  return (
    <div
      className="pod-screen"
      style={{
        ...styles.container,
        ...scaleStyle,
        ...(aiPanelVisible
          ? { paddingRight: 'calc(380px + 24px)', maxWidth: 'none', margin: 0 }
          : null),
      }}
    >
      {/* Full-screen flash overlay */}
      {flashColor && (
        <div style={{
          position: 'fixed', inset: 0,
          backgroundColor: flashColor,
          transition: 'opacity 0.15s ease-in', zIndex: 400, pointerEvents: 'none',
        }} />
      )}

      {/* AI processing pill — now folded into the pinned AI panel below.
          Kept only as a fallback for sessions that haven't used AI yet (so
          there's no pinned panel) — though aiProcessing implies one is in
          flight so the pinned panel will have rendered anyway. We leave this
          unrendered to avoid a duplicate "AI matching" indicator. */}
      <style>{`@keyframes aipulse { 0%,100% { opacity: 0.4; transform: scale(0.85);} 50% { opacity: 1; transform: scale(1.15);} }
@keyframes aipanelpulse { 0% { box-shadow: 0 0 0 0 var(--pulse-color, #EAB308); } 70% { box-shadow: 0 0 0 18px rgba(0,0,0,0); } 100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); } }`}</style>

      {/* Training mode banner */}
      {trainingMode && (
        <div style={{ backgroundColor: '#312e81', border: '1px solid #818cf8', borderRadius: 8, padding: '8px 14px', textAlign: 'center', color: '#c7d2fe', fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
            🎓 {t('trainingMode')} — {t('trainingNotSaved').split('—')[1]?.trim() || ''}
        </div>
      )}

      {/* ISBN search tip banner */}
      <div className="pod-banner" style={{ backgroundColor: '#1a1a2e', border: '1px solid #334155', borderRadius: 8, padding: '10px 14px', marginBottom: 8, color: '#94a3b8', fontSize: 13, lineHeight: 1.5 }}>
        📖 <strong style={{ color: '#e2e8f0' }}>{t('cantScanTip')}</strong> {t('cantScanHint')}
      </div>

      {!isOnline && <div style={styles.offlineBanner}>{t('offlineBanner')}</div>}
      {showIdleWarning && !isPaused && <div style={styles.idleWarning}>{t('idleWarning')}</div>}

      {/* Supervisor message */}
      {supervisorMessage && (
        <div style={{ backgroundColor: '#1e3a5f', border: '2px solid #3B82F6', borderRadius: 8, padding: '12px 16px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: '#93c5fd', fontWeight: 700, marginBottom: 4 }}>📩 {t('messageFromSupervisor')}</div>
            <div style={{ color: '#fff', fontSize: 17, fontWeight: 700 }}>{supervisorMessage}</div>
          </div>
          <button onClick={dismissMessage} style={{ background: 'none', border: '1px solid #3B82F6', borderRadius: 6, color: '#93c5fd', padding: '8px 14px', cursor: 'pointer', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
            {t('dismiss')}
          </button>
        </div>
      )}

      {/* Milestone celebration */}
      {milestoneMsg && (
        <div style={{ position: 'fixed', top: '20%', left: '50%', transform: 'translateX(-50%)', zIndex: 800, backgroundColor: 'rgba(0,0,0,0.9)', border: '3px solid #EAB308', borderRadius: 16, padding: '24px 48px', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🎉</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#EAB308' }}>{milestoneMsg}</div>
        </div>
      )}

      {flashText && (
        <div style={styles.flashOverlay}>
          <span style={{ ...styles.flashText, color: isLightColor(flashColor) ? '#0a0a0a' : '#fff', textShadow: isLightColor(flashColor) ? '2px 2px 12px rgba(255,255,255,0.6)' : '2px 2px 12px rgba(0,0,0,0.8)' }}>{flashText}</span>
        </div>
      )}

      {cooldownToast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 850, backgroundColor: 'rgba(31,41,55,0.95)', border: '1px solid #4b5563', borderRadius: 10, padding: '10px 18px', color: '#cbd5e1', fontSize: 14, fontWeight: 600, fontFamily: 'monospace', pointerEvents: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}>
          {cooldownToast}
        </div>
      )}

      {/* Break timer overlay */}
      {breakTimer !== null && (
        <div style={styles.pauseOverlay}>
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontSize: 28, color: '#EAB308', margin: 0 }}>☕ {t('breakTimer')}</h2>
            <div style={{ fontSize: 72, fontWeight: 900, color: '#fff', fontFamily: 'monospace', margin: '16px 0' }}>
              {Math.floor(breakTimer / 60)}:{String(breakTimer % 60).padStart(2, '0')}
            </div>
            <div style={{ height: 8, backgroundColor: '#333', borderRadius: 4, overflow: 'hidden', maxWidth: 300, margin: '0 auto 24px' }}>
              <div style={{ height: '100%', backgroundColor: '#EAB308', borderRadius: 4, width: `${breakTotal > 0 ? ((breakTotal - breakTimer) / breakTotal) * 100 : 0}%`, transition: 'width 1s linear' }} />
            </div>
            <button onClick={() => { setBreakTimer(null); setPhase(PHASE_SCANNING); setTimeout(refocusInput, 100); }}
              style={{ ...styles.primaryBtn, width: 'auto', padding: '14px 40px', fontSize: 18 }}
              title="Press Space">
              ▶ {t('resume')} Early <kbd style={{ ...kbdHintStyle, marginLeft: 8, fontSize: 13 }}>Space</kbd>
            </button>
          </div>
        </div>
      )}

      {/* Pause overlay */}
      {isPaused && breakTimer === null && (
        <div style={styles.pauseOverlay}>
          <div style={styles.pauseBox}>
            <h2 style={{ fontSize: 36, margin: 0, color: '#EAB308' }}>⏸ {t('paused')}</h2>
            <p style={{ color: '#999', fontSize: 20, margin: '12px 0' }}>
              {operatorName} · Pod {podId}
            </p>
            <button onClick={() => { setPhase(PHASE_SCANNING); setTimeout(refocusInput, 100); }}
              style={{ ...styles.primaryBtn, fontSize: 24, padding: '18px 40px', width: 'auto', marginBottom: 12 }}
              title="Press Space, R, or 1">
              ▶ {t('resume')} <kbd style={{ ...kbdHintStyle, marginLeft: 8, fontSize: 13 }}>Space</kbd>
            </button>

            {/* Break timer buttons */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, justifyContent: 'center' }}>
              <button onClick={() => { setBreakTimer(15 * 60); setBreakTotal(15 * 60); setBreakMinutesUsed((p) => p + 15); }}
                style={{ ...styles.secondaryBtn, backgroundColor: '#422006', borderColor: '#EAB308', color: '#EAB308' }}
                title="Press 2">
                ☕ {t('break15')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>2</kbd>
              </button>
              <button onClick={() => { setBreakTimer(30 * 60); setBreakTotal(30 * 60); setBreakMinutesUsed((p) => p + 30); }}
                style={{ ...styles.secondaryBtn, backgroundColor: '#422006', borderColor: '#EAB308', color: '#EAB308' }}
                title="Press 3">
                ☕ {t('break30')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>3</kbd>
              </button>
            </div>

            <button onClick={() => setShowSwitchOperator(true)}
              style={{ ...styles.secondaryBtn, marginTop: 0, fontSize: 16, width: 280 }}
              title="Press S">
              🔄 {t('switchOperator')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>S</kbd>
            </button>
            <button onClick={handleEndShift}
              style={{ ...styles.secondaryBtn, marginTop: 8, fontSize: 16, width: 280, borderColor: '#EF4444', color: '#EF4444' }}
              title="Press E">
              🚪 {t('endShift')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>E</kbd>
            </button>
            <Link to={backPath} style={{ ...styles.secondaryBtn, marginTop: 8, fontSize: 14, textDecoration: 'none', display: 'block', textAlign: 'center', width: 280 }}>
              {fromPods ? t('backToPods') : t('backToHome')}
            </Link>
          </div>

          {showSwitchOperator && (
            <div style={styles.miniModal}>
              <h3 style={{ color: '#fff', marginBottom: 12, marginTop: 0 }}>{t('switchOperator')}</h3>
            <p style={{ color: '#999', fontSize: 14, marginBottom: 10, fontWeight: 500 }}>
                {t('switchOperatorHint')}
              </p>
              <input type="text" value={switchName}
                onChange={(e) => setSwitchName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && switchName.trim()) {
                    const newName = displayOperatorName(switchName);
                    await endShift();
                    saveOperatorToHistory(newName);
                    setOperatorName(newName); setSwitchName('');
                    setShowSwitchOperator(false); setPhase(PHASE_SCANNING);
                    startShift(newName); setTimeout(refocusInput, 100);
                  }
                }}
                placeholder={t('newOperatorPlaceholder')} style={styles.setupInput} autoFocus />
              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <button onClick={async () => {
                  if (switchName.trim()) {
                    const newName = displayOperatorName(switchName);
                    await endShift();
                    saveOperatorToHistory(newName);
                    setOperatorName(newName); setSwitchName('');
                    setShowSwitchOperator(false); setPhase(PHASE_SCANNING);
                    startShift(newName); setTimeout(refocusInput, 100);
                  }
                }} style={{ ...styles.primaryBtn, width: 'auto' }}>{t('switchAndResume')}</button>
                <button onClick={() => { setShowSwitchOperator(false); setSwitchName(''); }} style={styles.secondaryBtn}>{t('cancel')}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* End Shift Summary Modal */}
      {showEndShift && shiftStats && (
        <div style={styles.pauseOverlay}>
          <div style={{ backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, maxWidth: 420, width: '90%', textAlign: 'center' }}>
            <h2 style={{ color: '#fff', marginTop: 0, fontSize: 24 }}>{t('shiftSummary')}</h2>
            <div style={{ textAlign: 'left', margin: '20px 0' }}>
              {[
                [t('operator'), shiftStats.operator],
                ['Pod', shiftStats.pod],
                [t('job'), shiftStats.job],
                [t('totalScans'), shiftStats.total.toLocaleString()],
                [t('exceptions'), shiftStats.exceptions],
                [t('avgPace'), `${shiftStats.pace}/hr`],
                [t('hoursWorked'), `${shiftStats.hours}h`],
                [t('breakTime'), `${shiftStats.breakMinutes || 0} min`],
                [t('bestStreak'), `${bestStreak} ${t('totalScans').toLowerCase()}`],
              ].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #333' }}>
                  <span style={{ color: '#888' }}>{label}</span>
                  <span style={{ color: '#fff', fontWeight: 700 }}>{val}</span>
                </div>
              ))}
            </div>
            <p style={{ color: '#999', fontSize: 14, marginBottom: 12, fontWeight: 500 }}>{t('shiftReportWillDownload')}</p>
            <button onClick={confirmEndShift}
              style={{ ...styles.primaryBtn, backgroundColor: '#EF4444' }}
              title="Press Enter">
              {t('confirmEndShift')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>Enter</kbd>
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.podTitle}>Pod {podId}</h1>
          <p style={{ color: '#888', fontSize: 15, margin: 0, fontWeight: 500 }}>
            {operatorName} · {job?.meta?.name || t('noActiveJobLabel')}
            {trainingMode && <span style={{ color: '#818cf8', marginLeft: 8 }}>🎓 {t('training')}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={styles.scannerBadge}>
            <div style={{ ...styles.dot, backgroundColor: '#22C55E' }} />
            {t('paired')} ✓
          </div>
          {recentScans.length > 0 && recentScans[0].docId && recentScans[0].docId !== 'training' && (
            <button onClick={handleUndo} style={styles.undoBtn} title="Press Ctrl + U">
              ↩ {t('undoLastScan')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>Ctrl + U</kbd>
            </button>
          )}
          <button onClick={() => setShowSettings(!showSettings)} style={styles.settingsBtn} title="Press Ctrl + ,">⚙️</button>
          <button onClick={() => setPhase(PHASE_PAUSED)} style={styles.pauseBtn} title="Press Ctrl + P">
            ⏸ {t('pause')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>Ctrl + P</kbd>
          </button>
        </div>
      </div>

      {/* Inline settings panel */}
      {showSettings && (
        <div style={{ backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 10, padding: '12px 16px', border: '1px solid var(--border, #333)', marginBottom: 10, maxWidth: 480, alignSelf: 'center', width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 600, minWidth: 60 }}>{t('volume')}</span>
              <input type="range" min={0} max={100} value={volLevel}
                onChange={(e) => { const v = Number(e.target.value); setVolLevel(v); setVolume(v); }} style={{ flex: 1 }} />
              <span style={{ color: '#888', fontSize: 12, fontWeight: 600, minWidth: 32 }}>{volLevel}%</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 600, minWidth: 60 }}>{t('fontSize')}</span>
              <input type="range" min={80} max={140} value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ color: '#888', fontSize: 12, fontWeight: 600, minWidth: 32 }}>{fontSize}%</span>
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              <button onClick={() => { const next = cycleTheme(); setThemeState(next); }}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text-secondary, #ccc)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: 1 }}>
                {theme === 'light' ? '☀️ Light' : theme === 'dark' ? '🌙 Dark' : '🌑 Dim'}
              </button>
              <button onClick={() => { const next = lang === 'en' ? 'es' : 'en'; setLang(next); setLangState(next); }}
                style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text-secondary, #ccc)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: 1 }}>
                {lang === 'en' ? '🇺🇸 English' : '🇲🇽 Español'}
              </button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <input
                type="checkbox"
                checked={ttsEnabled}
                onChange={(e) => {
                  setTtsEnabled(e.target.checked);
                  localStorage.setItem('pod-tts', e.target.checked ? '1' : '0');
                }}
              />
              <span style={{ color: 'var(--text-secondary, #aaa)', fontSize: 13, fontWeight: 600 }}>
                {t('voiceCallout')}
              </span>
            </label>
          </div>
        </div>
      )}

      {/* Hidden scan input */}
      <input ref={inputRef} type="text" onKeyDown={handleKeyDown}
        autoFocus inputMode="none" readOnly style={styles.hiddenInput} aria-label="Barcode scanner input" />

      {/* Duplicate info */}
      {duplicateInfo && (
        <div style={{ textAlign: 'center', color: '#EAB308', fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
          ⚠️ {duplicateInfo}
        </div>
      )}

      {/* Scan streak & barcode type */}
      {(scanStreak >= 5 || lastBarcodeType) && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginBottom: 8, flexWrap: 'wrap' }}>
          {scanStreak >= 5 && (
            <span style={{ fontSize: 15, fontWeight: 700, color: '#22C55E' }}>
              🔥 {scanStreak} {t('scanStreak')}{scanStreak >= bestStreak && scanStreak > 5 ? t('newBest') : ''}
            </span>
          )}
          {lastBarcodeType && (
            <span style={{ fontSize: 12, color: '#999', padding: '3px 8px', borderRadius: 4, backgroundColor: 'var(--bg-card, #1a1a1a)', fontWeight: 600 }}>
              {lastBarcodeType}
            </span>
          )}
        </div>
      )}

      {/* Record-to-beat pill — collapses once they pass it */}
      {previousBest && previousBest.count > 0 && (
        (() => {
          const beaten = totalScans >= previousBest.count;
          const remaining = Math.max(0, previousBest.count - totalScans);
          return (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
              <span style={{
                fontSize: 13, fontWeight: 700,
                padding: '4px 12px', borderRadius: 999,
                backgroundColor: beaten ? '#14532d' : 'var(--bg-card, #1a1a1a)',
                border: `1px solid ${beaten ? '#22C55E' : '#EAB308'}`,
                color: beaten ? '#86efac' : '#FCD34D',
              }}>
                {beaten
                  ? t('beatRecord', { date: previousBest.dateLabel, count: previousBest.count.toLocaleString() })
                  : t('toBeatRecord', { remaining: remaining.toLocaleString(), date: previousBest.dateLabel, count: previousBest.count.toLocaleString() })}
              </span>
            </div>
          );
        })()
      )}

      {/* Daily milestone pill — minimum (1800) and gift-card bonus (2200) */}
      {(() => {
        const hitBonus = totalScans >= PER_POD_BONUS_TARGET;
        const hitMin = totalScans >= PER_POD_DAILY_MIN;
        let bg, border, color, text;
        if (hitBonus) {
          bg = '#14532d'; border = '#22C55E'; color = '#86efac';
          text = t('giftCardEarned', { count: totalScans.toLocaleString() });
        } else if (hitMin) {
          const toBonus = PER_POD_BONUS_TARGET - totalScans;
          bg = 'var(--bg-card, #1a1a1a)'; border = '#EAB308'; color = '#FCD34D';
          text = t('moreForGiftCard', { n: toBonus.toLocaleString(), target: PER_POD_BONUS_TARGET.toLocaleString() });
        } else {
          const toMin = PER_POD_DAILY_MIN - totalScans;
          bg = 'var(--bg-card, #1a1a1a)'; border = '#3B82F6'; color = '#93C5FD';
          text = t('toMinimum', { n: toMin.toLocaleString(), min: PER_POD_DAILY_MIN.toLocaleString(), bonus: PER_POD_BONUS_TARGET.toLocaleString() });
        }
        return (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
            <span style={{
              fontSize: 13, fontWeight: 700,
              padding: '4px 12px', borderRadius: 999,
              backgroundColor: bg, border: `1px solid ${border}`, color,
            }}>
              {text}
            </span>
          </div>
        );
      })()}

      {/* Daily-goal pace nudge — reminds the operator they're trending below
          the 1,800/day minimum so they can pick up the pace before EOD.
          Quiet for the first 30 minutes of a shift (numbers aren't meaningful
          yet) and once they've already beaten the minimum. */}
      {(() => {
        if (totalScans >= PER_POD_DAILY_MIN) return null;
        if (!scanStartTimeRef.current) return null;
        const elapsedMs = Date.now() - scanStartTimeRef.current;
        if (elapsedMs < 30 * 60 * 1000) return null; // first half-hour: too noisy
        // Assume a standard 8-hour shift from first scan; cap remaining at 0.
        const SHIFT_MS = 8 * 60 * 60 * 1000;
        const remainingMs = SHIFT_MS - elapsedMs;
        if (remainingMs <= 0) return null; // shift over — no point nagging
        const remainingHrs = remainingMs / 3600000;
        const projected = totalScans + pace * remainingHrs;
        const needed = Math.ceil((PER_POD_DAILY_MIN - totalScans) / remainingHrs);
        // Only nag if they're meaningfully off-pace (>5% short of projection).
        if (projected >= PER_POD_DAILY_MIN * 0.95) return null;
        return (
          <div style={{
            backgroundColor: 'rgba(234,179,8,0.12)',
            border: '2px solid #EAB308',
            borderRadius: 10,
            padding: '10px 16px',
            marginBottom: 8,
            color: '#FDE68A',
            fontSize: 15,
            fontWeight: 700,
            textAlign: 'center',
          }}>
            {t('behindDailyPace', { goal: PER_POD_DAILY_MIN.toLocaleString(), needed: needed.toLocaleString(), pace: pace.toLocaleString() })}
          </div>
        );
      })()}

      {/* Offline queue indicator */}
      {!isOnline && (
        <div style={{ textAlign: 'center', backgroundColor: '#7f1d1d', border: '1px solid #EF4444', borderRadius: 8, padding: '8px 16px', marginBottom: 8 }}>
          <div style={{ color: '#fca5a5', fontSize: 15, fontWeight: 700 }}>📡 {t('offlineMode')}</div>
          <div style={{ color: '#f87171', fontSize: 13, marginTop: 2 }}>
            {t('offlineHint')}
          </div>
        </div>
      )}

      {/* Stats — primary count gets 2x grid weight; three secondary stats
          share the remaining width. Sizes scale to container, not viewport,
          so digits never overflow their tile when the AI panel narrows the
          main column. */}
      <div style={styles.statsRow}>
        <div style={styles.statBig}>
          <div style={styles.statValueBig}>{totalScans.toLocaleString()}</div>
          <div style={styles.statLabel}>{t('totalScans')} ({dailyPct}%)</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: paceColor }}>{pace}</div>
          <div style={styles.statLabel}>{t('pacePerHour')} · {t('goal')} {targetPerHour}</div>
        </div>
        <div style={styles.stat}>
          <div style={{ ...styles.statValue, color: manualEntryCount > 0 ? '#3B82F6' : 'var(--text-secondary, #666)' }}>
            {manualEntryCount}
          </div>
          <div style={styles.statLabel}>{t('manualLabel')}</div>
        </div>
        <div style={{ ...styles.stat, cursor: 'pointer' }} onClick={() => setShowExceptionModal(true)}>
          <div style={{ ...styles.statValue, color: (autoExceptionCount + exceptionCount) > 0 ? '#EF4444' : 'var(--text-secondary, #666)' }}>
            {autoExceptionCount + exceptionCount}
          </div>
          <div style={styles.statLabel}>{t('exceptions')}</div>
        </div>
      </div>

      {/* Pace bar with goal marker */}
      <div style={styles.paceBarContainer}>
        <div style={{ ...styles.paceBar, width: `${Math.min(100, paceRatio * 100)}%`, backgroundColor: paceColor }} />
        {/* Goal marker line */}
        <div style={{
          position: 'absolute', left: `${Math.min(100, goalPct)}%`, top: 0, bottom: 0,
          width: 2, backgroundColor: '#fff', opacity: 0.6, zIndex: 1,
        }} />
        <div style={{
          position: 'absolute', left: `${Math.min(100, goalPct)}%`, top: -20,
          fontSize: 12, color: '#999', transform: 'translateX(-50%)', fontWeight: 600,
        }}>{t('goal')}</div>
      </div>

      {lastScanTime && (
        <p style={{ textAlign: 'center', color: 'var(--text-tertiary, #666)', fontSize: 14, marginTop: 12, fontWeight: 500 }}>
          {t('lastScan')}: {lastScanTime.toLocaleTimeString()}
        </p>
      )}

      {/* Recent scans */}
      {recentScans.length > 0 && (
        <div className="pod-recent" style={styles.recentScans}>
          <div style={styles.recentTitle}>{t('recentScans')}</div>
          {recentScans.slice(0, 8).map((s, i) => (
            <div key={s.id} style={{
              ...styles.recentRow,
              opacity: i === 0 ? 1 : 0.55 + (0.4 / (i + 1)),
              ...(i === 0 ? { borderLeft: '4px solid #22C55E', backgroundColor: 'rgba(34,197,94,0.06)' } : null),
            }}>
              {/* AI-match rows show a small cover thumbnail so the operator
                  can correlate the on-screen entry to the physical book they
                  photographed (especially when several books are in flight). */}
              {s.capturedPhoto && (
                <img src={s.capturedPhoto} alt="cover"
                  style={{ width: 32, height: 42, objectFit: 'cover', borderRadius: 4, border: '1px solid #3B82F6', flexShrink: 0 }} />
              )}
              <span
                onClick={() => {
                  navigator.clipboard?.writeText(s.isbn).catch(() => {});
                  flash('#3B82F6', `📋 Copied ${s.isbn}`, 1200);
                }}
                role="button"
                tabIndex={0}
                title="Click to copy ISBN"
                aria-label={`Copy ISBN ${s.isbn} to clipboard`}
                style={{ fontFamily: 'monospace', fontSize: i === 0 ? 22 : 18, fontWeight: 900, letterSpacing: 0.5, color: s.isException ? '#EF4444' : s.poName === 'TRAINING' ? '#818cf8' : '#fff', cursor: 'pointer', userSelect: 'all' }}
              >
                {s.isbn}
              </span>
              {s.poName && s.poName !== 'EXCEPTIONS' && s.poName !== 'TRAINING' && (
                <span style={{ fontSize: 15, fontWeight: 800, color: s.color || '#888' }}>{s.poName}</span>
              )}
              {s.poName === 'TRAINING' && <span style={{ fontSize: 13, padding: '3px 8px', borderRadius: 4, backgroundColor: '#312e81', color: '#c7d2fe', fontWeight: 700 }}>TRAINING</span>}
              {s.isException && <span style={{ fontSize: 13, padding: '3px 8px', borderRadius: 4, backgroundColor: '#7f1d1d', color: '#fca5a5', fontWeight: 700 }}>EXCEPTION</span>}
              {s.isAiMatch && !s.isException && (
                <span style={{ fontSize: 13, padding: '3px 8px', borderRadius: 4, backgroundColor: '#1e3a8a', color: '#93C5FD', fontWeight: 700 }}>
                  AI{s.aiSeq ? ` #${s.aiSeq}` : ''}
                </span>
              )}
              {s.isManual && !s.isAiMatch && !s.isException && <span style={{ fontSize: 13, padding: '3px 8px', borderRadius: 4, backgroundColor: '#7c2d12', color: '#fdba74', fontWeight: 700 }}>MANUAL</span>}
              {s.capturedTitle && (s.isAiMatch || s.isException) && (
                <span title={s.capturedTitle}
                  style={{ fontSize: 13, color: '#999', fontStyle: 'italic', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  "{s.capturedTitle}"
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 13, color: '#777', fontWeight: 600 }}>{s.time.toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Manual ISBN Entry */}
      {showManualEntry && (
        <div style={{ backgroundColor: 'var(--bg-card, #1a1a1a)', border: '2px solid #EF4444', borderRadius: 10, padding: 16, marginBottom: 12, maxWidth: 640, alignSelf: 'center', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#fdba74', fontWeight: 800, fontSize: 17 }}>⌨️ {t('manualIsbnEntry')}</span>
            <button onClick={() => { setShowManualEntry(false); setManualIsbn(''); setTimeout(refocusInput, 100); }}
              style={{ background: 'none', border: '1px solid #555', borderRadius: 6, color: '#888', fontSize: 18, width: 36, height: 36, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
          </div>
          <p style={{ color: '#EF4444', fontSize: 14, margin: '0 0 4px', fontWeight: 700 }}>⚠️ {t('manualBilled')}</p>
          <p style={{ color: '#999', fontSize: 14, margin: '0 0 8px', lineHeight: 1.4 }}>{t('manualEntryHint')}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={manualInputRef}
              type="text"
              inputMode="numeric"
              value={manualIsbn}
              onChange={(e) => setManualIsbn(e.target.value.replace(/[^0-9Xx-]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manualIsbn.trim()) {
                  e.preventDefault();
                  const val = manualIsbn.trim();
                  setManualIsbn('');
                  setShowManualEntry(false);
                  handleScan(val, true);
                  setTimeout(refocusInput, 100);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setShowManualEntry(false);
                  setManualIsbn('');
                  setTimeout(refocusInput, 100);
                }
              }}
              placeholder="e.g. 978-0-13-468599-1"
              style={{ flex: 1, padding: '14px 16px', borderRadius: 8, border: '2px solid #EF4444', backgroundColor: 'var(--bg-input, #0a0a0a)', color: 'var(--text, #fff)', fontSize: 18, fontFamily: 'monospace', fontWeight: 600, outline: 'none' }}
              autoFocus
            />
            <button
              onClick={() => {
                if (manualIsbn.trim()) {
                  const val = manualIsbn.trim();
                  setManualIsbn('');
                  setShowManualEntry(false);
                  handleScan(val, true);
                  setTimeout(refocusInput, 100);
                }
              }}
              disabled={!manualIsbn.trim()}
              style={{ padding: '14px 20px', borderRadius: 8, border: 'none', backgroundColor: manualIsbn.trim() ? '#EF4444' : '#333', color: '#fff', fontSize: 17, fontWeight: 800, cursor: manualIsbn.trim() ? 'pointer' : 'not-allowed' }}
            >{t('scanArrow')}</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              onClick={() => setShowIsbnCamera(true)}
              style={{ flex: 1, padding: '12px 16px', borderRadius: 8, border: '2px solid #3B82F6', backgroundColor: 'transparent', color: '#93C5FD', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {t('useCamera')}
            </button>
          </div>
        </div>
      )}

      {/* AI camera is now rendered inline inside the pinned AI panel below
          (look for `<BookCamera embedded ...>`), so the rest of the screen
          stays interactive and the operator can keep scanning regular
          barcodes while the cover is being read. */}

      {/* Type-a-title search — manual fuzzy match against the manifest */}
      {showTitleSearch && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500, padding: 16 }}
          onClick={() => { if (!titleSearchBusy) { setShowTitleSearch(false); setTimeout(refocusInput, 100); } }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ backgroundColor: '#0f0f0f', border: '2px solid #8B5CF6', borderRadius: 14, padding: 22, width: '100%', maxWidth: 600, fontFamily: "'Inter', system-ui, sans-serif" }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ color: '#fff', margin: 0, fontSize: 20, fontWeight: 800 }}>⌨️ {t('searchByTitle')}</h2>
              <button onClick={() => { setShowTitleSearch(false); setTimeout(refocusInput, 100); }}
                disabled={titleSearchBusy}
                style={{ background: 'none', border: '1px solid #555', borderRadius: 6, color: '#888', fontSize: 18, width: 36, height: 36, cursor: titleSearchBusy ? 'not-allowed' : 'pointer' }}>✕</button>
            </div>
            <p style={{ color: '#aaa', fontSize: 14, margin: '0 0 12px', lineHeight: 1.5 }}>
              {t('searchByTitleHint')}
            </p>
            <input
              type="text"
              value={titleSearchQuery}
              onChange={(e) => setTitleSearchQuery(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && titleSearchQuery.trim() && !titleSearchBusy) {
                  e.preventDefault();
                  const q = titleSearchQuery.trim();
                  setTitleSearchBusy(true);
                  try {
                    await handleTypedTitleSearch(q);
                    setShowTitleSearch(false);
                    setTitleSearchQuery('');
                    setTimeout(refocusInput, 200);
                  } finally {
                    setTitleSearchBusy(false);
                  }
                }
                if (e.key === 'Escape' && !titleSearchBusy) {
                  e.preventDefault();
                  setShowTitleSearch(false);
                  setTimeout(refocusInput, 100);
                }
              }}
              placeholder={t('searchByTitlePlaceholder')}
              autoFocus
              disabled={titleSearchBusy}
              style={{ width: '100%', padding: '14px 16px', borderRadius: 8, border: '2px solid #8B5CF6', backgroundColor: '#0a0a0a', color: '#fff', fontSize: 17, fontWeight: 600, outline: 'none', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                onClick={async () => {
                  if (!titleSearchQuery.trim() || titleSearchBusy) return;
                  const q = titleSearchQuery.trim();
                  setTitleSearchBusy(true);
                  try {
                    await handleTypedTitleSearch(q);
                    setShowTitleSearch(false);
                    setTitleSearchQuery('');
                    setTimeout(refocusInput, 200);
                  } finally {
                    setTitleSearchBusy(false);
                  }
                }}
                disabled={!titleSearchQuery.trim() || titleSearchBusy}
                style={{ flex: 1, padding: '14px 18px', borderRadius: 8, border: 'none', backgroundColor: titleSearchQuery.trim() && !titleSearchBusy ? '#8B5CF6' : '#333', color: '#fff', fontSize: 16, fontWeight: 800, cursor: titleSearchQuery.trim() && !titleSearchBusy ? 'pointer' : 'not-allowed' }}>
                {titleSearchBusy ? t('searching') : t('searchManifest')}
              </button>
              <button onClick={() => { setShowTitleSearch(false); setTimeout(refocusInput, 100); }}
                disabled={titleSearchBusy}
                style={{ padding: '14px 18px', borderRadius: 8, border: '1px solid #444', backgroundColor: 'transparent', color: '#aaa', fontSize: 15, fontWeight: 700, cursor: titleSearchBusy ? 'not-allowed' : 'pointer' }}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Pinned AI panel ───
          Always visible to the right once an AI session has occurred this
          shift, OR while an AI workflow is active. Single visual lane for
          all AI state so operators know exactly where to look. States:
          - aiMatchCandidates: full picker
          - aiProcessing: pulsing "matching cover…" indicator
          - aiPulse: brief bin-color flash when a match resolves
          - aiHistory only (idle): condensed last-3-AI-matches list
          z-index < flash overlay (400) so regular scan center-flashes still
          briefly cover it, matching the rest of the app's UX. */}
      {aiPanelVisible && (
        <div
          style={{
            position: 'fixed', top: 70, right: 12, bottom: 12,
            width: 380, maxWidth: '94vw', zIndex: 350,
            backgroundColor: '#0f0f0f',
            border: `2px solid ${aiPulse ? aiPulse.color : aiMatchCandidates ? '#EAB308' : aiProcessing ? '#3B82F6' : '#333'}`,
            borderRadius: 14,
            padding: 16, overflowY: 'auto',
            boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
            transition: 'border-color 0.25s ease',
            // CSS variable feeds the @keyframes aipanelpulse ring color.
            '--pulse-color': aiPulse ? aiPulse.color : 'transparent',
            animation: aiPulse ? 'aipanelpulse 0.9s ease-out' : 'none',
          }}>

          {/* Panel header — always visible regardless of state */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ color: '#dbeafe', margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: 0.3 }}>
              📷 {t('aiWorkspace')}
            </h2>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#22C55E', padding: '2px 7px', borderRadius: 999, backgroundColor: '#14532d', border: '1px solid #22C55E' }}>
              {t('keepScanning')}
            </span>
          </div>

          {/* Pulse banner — bin-color confirmation when an AI match resolves.
              Shows for ~2s then disappears. Lives in its own lane so it never
              competes with the regular scan's center-screen flash. */}
          {aiPulse && (
            <div style={{
              marginBottom: 12, padding: '14px 16px', borderRadius: 10,
              backgroundColor: aiPulse.color,
              color: isLightColor(aiPulse.color) ? '#0a0a0a' : '#fff',
              border: `2px solid ${isLightColor(aiPulse.color) ? '#0a0a0a' : '#fff'}`,
              textAlign: 'center', fontWeight: 900,
            }}>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>
                AI #{aiPulse.seq} → goes to
              </div>
              <div style={{ fontSize: 22, lineHeight: 1.1 }}>
                {aiPulse.text}
              </div>
            </div>
          )}

          {/* PROCESSING state — pulsing dot */}
          {aiProcessing && !aiMatchCandidates && (
            <div style={{
              padding: '14px 16px', marginBottom: 12, borderRadius: 10,
              backgroundColor: '#1e3a8a', border: '1px solid #3B82F6',
              color: '#dbeafe', fontSize: 14, fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{
                display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
                backgroundColor: '#60a5fa', animation: 'aipulse 1s ease-in-out infinite',
                flexShrink: 0,
              }} />
              <div>
                <div>{t('matchingCover')} #{aiSeqRef.current + 1}…</div>
                <div style={{ fontSize: 11, fontWeight: 500, color: '#93c5fd', marginTop: 2 }}>
                  {t('keepScanningRegular')}
                </div>
              </div>
            </div>
          )}

          {/* CANDIDATE PICKER state */}
          {aiMatchCandidates && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <h3 style={{ color: '#EAB308', margin: 0, fontSize: 16, fontWeight: 800 }}>
                  {aiMatchCandidates.candidates.length ? t('pickAiMatch') : t('noMatch')}
                  {aiMatchCandidates.seq && (
                    <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 800, color: '#93C5FD', backgroundColor: '#1e3a8a', padding: '2px 8px', borderRadius: 6 }}>
                      AI #{aiMatchCandidates.seq}
                    </span>
                  )}
                </h3>
              </div>
              {aiMatchCandidates.photo && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                  <img src={aiMatchCandidates.photo} alt="captured cover"
                    style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 8, border: '2px solid #EAB308' }} />
                </div>
              )}
              <p style={{ color: '#bbb', margin: '0 0 12px', fontSize: 13 }}>
                {t('aiRead')} <strong style={{ color: '#fff' }}>"{aiMatchCandidates.capturedTitle || t('noText')}"</strong>
              </p>
              {aiMatchCandidates.candidates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {aiMatchCandidates.candidates.map((c, idx) => (
                    <button key={c.isbn}
                      onClick={() => pickAiCandidate(idx)}
                      title={c.alreadyScanned ? 'Already scanned for this job — picking will log a duplicate exception' : undefined}
                      style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, border: c.alreadyScanned ? '1px solid #EF4444' : '1px solid #444', backgroundColor: c.alreadyScanned ? '#2a1212' : '#1a1a1a', color: c.alreadyScanned ? '#888' : '#fff', cursor: 'pointer', opacity: c.alreadyScanned ? 0.7 : 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: '1px solid #555', backgroundColor: '#0a0a0a', color: '#EAB308', fontSize: 13, fontWeight: 800, fontFamily: 'monospace', flexShrink: 0 }}>{idx + 1}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: c.alreadyScanned ? 'line-through' : 'none' }}>{c.title || `(no title — ${c.isbn})`}</div>
                        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                          {c.po || '—'} · {c.isbn}
                          {c.alreadyScanned && <span style={{ marginLeft: 8, color: '#EF4444', fontWeight: 700 }}>· duplicate — will log exception</span>}
                        </div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: c.score >= MATCH_CONFIDENT ? '#22C55E' : c.score >= MATCH_AMBIGUOUS ? '#EAB308' : '#888' }}>
                        {Math.round(c.score * 100)}%
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
                <button onClick={() => {
                  setAiMatchCandidates(null);
                  setShowManualEntry(true);
                  setTimeout(() => manualInputRef.current?.focus(), 100);
                }}
                  style={{ padding: '10px', borderRadius: 8, border: '1px solid #3B82F6', backgroundColor: 'transparent', color: '#93c5fd', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                  {t('typeIsbnManually')} <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>M</kbd>
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => {
                    const sel = aiMatchCandidates;
                    setAiMatchCandidates(null);
                    openExceptionForCapture(sel.capturedTitle, sel.photo);
                  }}
                    style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid #EF4444', backgroundColor: 'transparent', color: '#fca5a5', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                    {aiMatchCandidates.candidates.length ? t('noneException') : t('logException')} <kbd style={{ ...kbdHintStyle, marginLeft: 4 }}>E</kbd>
                  </button>
                  <button onClick={() => setAiMatchCandidates(null)}
                    style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #555', backgroundColor: '#2a2a2a', color: '#ccc', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                    <kbd style={kbdHintStyle}>Esc</kbd>
                  </button>
                </div>
                {aiMatchCandidates.candidates.length > 0 && (
                  <div style={{ color: '#666', fontSize: 11, textAlign: 'center', marginTop: 2 }}>
                    {t('pressToPick')} <kbd style={kbdHintStyle}>1</kbd>–<kbd style={kbdHintStyle}>{Math.min(9, aiMatchCandidates.candidates.length)}</kbd> {t('toPick')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* EMBEDDED CAMERA — lives inside the panel so the operator can
              keep scanning regular barcodes while it's active. Mutually
              exclusive with the picker/processing states. */}
          {showIsbnCamera && !aiMatchCandidates && !aiProcessing && (
            <BookCamera
              embedded
              mode="title"
              podId={podId}
              jobId={job?.id}
              onResult={(data) => {
                setShowIsbnCamera(false);
                handleAiCoverResult(data);
                setTimeout(refocusInput, 200);
              }}
              onClose={() => { setShowIsbnCamera(false); setTimeout(refocusInput, 100); }}
            />
          )}

          {/* IDLE state — quick-snap button + recent AI history.
              Only visible when no picker / processing / camera is active. */}
          {!aiMatchCandidates && !aiProcessing && !showIsbnCamera && (
            <>
              <button
                onClick={() => setShowIsbnCamera(true)}
                style={{
                  width: '100%', padding: '14px', borderRadius: 10,
                  border: '2px solid #3B82F6', backgroundColor: '#1e3a8a',
                  color: '#dbeafe', fontSize: 15, fontWeight: 800, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  marginBottom: 14,
                }}>
                📷 {t('snapNextCover', { n: aiSeqRef.current + 1 })}
                <kbd style={{ ...kbdHintStyle, marginLeft: 4, backgroundColor: '#1e3a8a', borderColor: '#3B82F6' }}>NumPad 1</kbd>
              </button>
              {aiHistory.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                    {t('recentAiMatches')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {aiHistory.slice(0, 6).map((h) => (
                      <div key={`${h.seq}-${h.isbn}`} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 10px', borderRadius: 8,
                        backgroundColor: '#1a1a1a', border: '1px solid #222',
                      }}>
                        {h.photo
                          ? <img src={h.photo} alt="" style={{ width: 30, height: 40, objectFit: 'cover', borderRadius: 4, border: `1px solid ${h.color}`, flexShrink: 0 }} />
                          : <div style={{ width: 30, height: 40, borderRadius: 4, backgroundColor: '#222', flexShrink: 0 }} />
                        }
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: h.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            AI #{h.seq} · {h.poName}
                          </div>
                          <div style={{ fontSize: 11, color: '#777', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {h.isbn}
                          </div>
                        </div>
                        <span style={{ fontSize: 10, color: '#666', flexShrink: 0 }}>
                          {h.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* spacer to keep next block intact */}
      {false && (
        <div>
          <div />
        </div>
      )}

      {/* Action buttons — Camera is the primary path (auto-falls to exception when no match);
          Type ISBN for hand-keying barcodes; Log Exception only for severely damaged books. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16, maxWidth: 640, alignSelf: 'center', width: '100%' }}>
        <button
          onClick={() => {
            if (aiProcessing || aiMatchCandidates) {
              flash('#EAB308', t('resolveAiFirst'), 1500);
              return;
            }
            setShowIsbnCamera(true);
          }}
          disabled={aiProcessing || !!aiMatchCandidates}
          title={aiProcessing || aiMatchCandidates
            ? 'Resolve the current AI match before snapping another cover'
            : 'Press Ctrl+1 — reads the cover, matches to manifest, auto-logs exception if no match'}
          style={{
            ...styles.secondaryBtn, margin: 0,
            borderColor: '#3B82F6', backgroundColor: '#1e3a8a', color: '#dbeafe',
            fontSize: 18, padding: '20px 24px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            fontWeight: 800,
            opacity: (aiProcessing || aiMatchCandidates) ? 0.45 : 1,
            cursor: (aiProcessing || aiMatchCandidates) ? 'not-allowed' : 'pointer',
          }}>
          <span>📷 {t('scanCoverAi')}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: '#93c5fd' }}>
            {aiProcessing ? t('aiStillMatching') : aiMatchCandidates ? t('pickMatchFirst') : t('scanCoverHint')}
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <kbd style={{ ...kbdHintStyle, backgroundColor: '#1e3a8a', color: '#dbeafe', borderColor: '#3B82F6' }}>NumPad 1</kbd>
            <span style={{ fontSize: 10, color: '#64748b' }}>or</span>
            <kbd style={kbdHintStyle}>Ctrl + 1</kbd>
          </span>
        </button>
        <button onClick={() => { setShowTitleSearch(true); setTitleSearchQuery(''); }}
          title="Press Ctrl+4 — type the title, matches to manifest, picks ISBN"
          style={{ ...styles.secondaryBtn, margin: 0, borderColor: '#8B5CF6', backgroundColor: '#3b0764', color: '#ede9fe', fontSize: 16, padding: '14px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontWeight: 800 }}>
          <span>⌨️ {t('typeBookTitleAi')}</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: '#c4b5fd' }}>{t('typeBookTitleHint')}</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <kbd style={{ ...kbdHintStyle, backgroundColor: '#3b0764', color: '#ede9fe', borderColor: '#8B5CF6' }}>NumPad 4</kbd>
            <span style={{ fontSize: 10, color: '#64748b' }}>or</span>
            <kbd style={kbdHintStyle}>Ctrl + 4</kbd>
          </span>
        </button>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => { setShowManualEntry(true); setTimeout(() => manualInputRef.current?.focus(), 100); }}
            title="Press Ctrl+2"
            style={{ ...styles.secondaryBtn, flex: 1, margin: 0, borderColor: '#555', color: '#aaa', fontSize: 13, padding: '10px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span>⌨️ {t('typeIsbn')}</span>
            <kbd style={{ ...kbdHintStyle, backgroundColor: '#1e293b', color: '#cbd5e1' }}>NumPad 2</kbd>
          </button>
          <button onClick={() => setShowExceptionModal(true)}
            title="Press Ctrl+3 or Esc — only for severely damaged books"
            style={{ ...styles.exceptionBtn, margin: 0, flex: 1, padding: '10px 16px', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span>⚠️ {t('damagedException')}</span>
            <kbd style={{ ...kbdHintStyle, backgroundColor: '#7f1d1d', color: '#fecaca', borderColor: '#EF4444' }}>NumPad 3</kbd>
          </button>
        </div>
      </div>

      {/* Persistent shortcut hint — visible reminder so operators learn the keys */}
      {isScanning && (
        <button
          onClick={() => setShowShortcuts(true)}
          title="Show all keyboard shortcuts"
          style={{
            position: 'fixed', bottom: 12, left: 12, zIndex: 50,
            backgroundColor: 'rgba(30, 58, 138, 0.85)', color: '#dbeafe',
            border: '1px solid #3B82F6', borderRadius: 20, padding: '6px 12px',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          ⌨️ {t('numpadShortcuts')} <kbd style={{ ...kbdHintStyle, fontSize: 10 }}>?</kbd>
        </button>
      )}

      {!job && (
        <div style={styles.warning}>
          {jobLoading ? (
            <>Loading active job…</>
          ) : jobError ? (
            <>⚠️ Can't reach Firestore — {jobError}. Check internet, then reload.</>
          ) : (
            <>No active job. <Link to="/setup" style={{ color: '#93c5fd' }}>Go to Setup</Link></>
          )}
        </div>
      )}

      {showExceptionModal && (
        <ExceptionModal podId={podId} scannerId={operatorName}
          prefill={exceptionPrefill}
          onSubmit={handleException}
          onClose={() => { setShowExceptionModal(false); setExceptionPrefill(null); setTimeout(refocusInput, 100); }} />
      )}

      {/* Duplicate confirmation modal removed — multiple copies of the same ISBN are legitimate inventory. */}

      {/* Keyboard shortcuts overlay */}
      {showShortcuts && (
        <div style={styles.pauseOverlay} onClick={() => setShowShortcuts(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, maxWidth: 400, width: '90%' }}>
            <h2 style={{ color: '#fff', marginTop: 0, fontSize: 20, textAlign: 'center' }}>⌨️ Keyboard Shortcuts</h2>
            <p style={{ color: '#888', fontSize: 12, textAlign: 'center', margin: '0 0 12px', fontStyle: 'italic' }}>NumPad keys = fastest (no modifier needed). Ctrl+digit also works.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                ['— NumPad (fastest — no Ctrl) —', null],
                ['NumPad 1', '📷 Scan book cover (AI)'],
                ['NumPad 2', '⌨️ Type ISBN manually'],
                ['NumPad 3', '⚠️ Log exception'],
                ['NumPad 4', '⌨️ Type book title (AI)'],
                ['NumPad 0', '↩ Undo last scan'],
                ['NumPad .', '⏸ Pause shift'],
                ['NumPad +', '⚙️ Toggle settings'],
                ['NumPad −', '🔄 Switch operator'],
                ['NumPad ×', '? Toggle this help'],
                ['— Ctrl shortcuts —', null],
                ['Ctrl + 1', '📷 Scan book cover (AI)'],
                ['Ctrl + 4', '⌨️ Type book title (AI)'],
                ['Ctrl + 2', '⌨️ Type ISBN manually'],
                ['Ctrl + 3 / Esc', '⚠️ Log exception'],
                ['Ctrl + U', '↩ Undo last scan'],
                ['Ctrl + P', '⏸ Pause shift'],
                ['Ctrl + S', '🔄 Switch operator'],
                ['Ctrl + E', '🚪 End shift'],
                ['Ctrl + ,', '⚙️ Toggle settings'],
                ['?', 'Toggle this help'],
                ['— Pause Screen —', null],
                ['NumPad 1 / Space / R', '▶ Resume scanning'],
                ['NumPad 2', '☕ Take 15 min break'],
                ['NumPad 3', '☕ Take 30 min break'],
                ['NumPad −  /  S', '🔄 Switch operator'],
                ['NumPad ×  /  E', '🚪 End shift'],
                ['— AI Match Picker —', null],
                ['NumPad 1–9', 'Pick AI-match candidate'],
                ['M', 'Manual entry (from AI match)'],
                ['E', 'Log exception (from AI match)'],
                ['Esc', 'Close picker'],
                ['— Modals —', null],
                ['Enter / NumPad Enter', 'Submit / confirm'],
                ['Esc / NumPad 0', 'Cancel / close'],
                ['Y / NumPad 1', 'Confirm duplicate'],
                ['N / NumPad 0', 'Skip duplicate'],
              ].map(([key, desc], i) => (
                desc === null ? (
                  <div key={i} style={{ color: '#666', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, padding: '6px 0 2px', textAlign: 'center' }}>{key}</div>
                ) : (
                  <div key={key + i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #2a2a2a' }}>
                    <kbd style={{ backgroundColor: '#333', padding: '3px 10px', borderRadius: 4, fontFamily: 'monospace', fontSize: 13, color: '#fff', border: '1px solid #555', fontWeight: 600, whiteSpace: 'nowrap' }}>{key}</kbd>
                    <span style={{ color: '#bbb', fontSize: 13, fontWeight: 500, marginLeft: 12, textAlign: 'right' }}>{desc}</span>
                  </div>
                )
              ))}
            </div>
            <button onClick={() => setShowShortcuts(false)}
              style={{ ...styles.primaryBtn, marginTop: 16, width: '100%' }}>Close <kbd style={{ ...kbdHintStyle, marginLeft: 6 }}>Esc</kbd></button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════
const kbdHintStyle = {
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 700,
  padding: '2px 8px',
  borderRadius: 4,
  backgroundColor: 'rgba(255,255,255,0.12)',
  border: '1px solid rgba(255,255,255,0.25)',
  color: 'currentColor',
  letterSpacing: 0.5,
  lineHeight: 1.2,
};

const styles = {
  container: {
    minHeight: '100vh', color: 'var(--text, #fff)', fontFamily: "'Inter', 'SF Pro Display', system-ui, -apple-system, sans-serif",
    padding: 'clamp(8px, 2vw, 16px) clamp(12px, 3vw, 24px)', display: 'flex', flexDirection: 'column', position: 'relative',
    // No max-width cap — operators want big, glanceable numbers across the
    // full display whether the AI panel is open or not. The setup cards
    // (operator name / pair scanner / ready) cap themselves via setupCard.
    backgroundColor: 'var(--bg, #111)', margin: '0 auto', width: '100%', boxSizing: 'border-box',
  },
  backLink: { color: '#888', textDecoration: 'none', fontSize: 14, marginBottom: 12, display: 'inline-block', fontWeight: 600 },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: 14, flexWrap: 'wrap', gap: 10,
  },
  podTitle: { fontSize: 'clamp(26px, 5vw, 40px)', fontWeight: 800, margin: 0, letterSpacing: '-0.5px' },
  scannerBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 12px', borderRadius: 6,
    border: '1px solid #22C55E', backgroundColor: '#14532d',
    color: '#fff', fontSize: 13, fontWeight: 700,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  // Header action buttons sized to WCAG 44x44 minimum so gloved/wet hands
  // on a tablet hit them reliably.
  undoBtn: {
    padding: '10px 16px', borderRadius: 6, border: '1px solid var(--border, #666)',
    backgroundColor: 'var(--bg-input, #333)', color: 'var(--text-secondary, #ccc)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    minHeight: 44, minWidth: 44,
  },
  settingsBtn: {
    padding: '10px 14px', borderRadius: 6, border: '1px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)', color: 'var(--text-secondary, #ccc)', fontSize: 18, cursor: 'pointer',
    minHeight: 44, minWidth: 44,
  },
  pauseBtn: {
    padding: '10px 16px', borderRadius: 6,
    border: '1px solid #EAB308', backgroundColor: 'rgba(234,179,8,0.1)',
    color: '#EAB308', fontSize: 15, fontWeight: 700, cursor: 'pointer',
    minHeight: 44, minWidth: 44,
  },
  hiddenInput: { position: 'absolute', opacity: 0, height: 0, width: 0, top: -100, left: -100 },
  statsRow: {
    // CSS Grid so the primary count (total scans) gets 2x weight and the
    // three secondary stats share the remaining width evenly. Sizes scale
    // with the container, not the viewport, so they don't overflow when the
    // AI side panel narrows the main column. No max-width — we want
    // operators to see big, glanceable numbers across the full screen.
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)',
    gap: 'clamp(8px, 1.5vw, 18px)',
    marginTop: 'clamp(10px, 2vh, 20px)',
    width: '100%',
    alignItems: 'end',
  },
  stat: { textAlign: 'center', minWidth: 0, padding: '6px 4px' },
  statBig: { textAlign: 'center', minWidth: 0, padding: '6px 4px' },
  statValue: {
    // Cap by container width via cqi (with vw fallback) so digits never
    // overflow their tile when the AI panel is open. minmax keeps it
    // readable on small kiosks too.
    fontSize: 'clamp(34px, 5vw, 60px)', fontWeight: 800, lineHeight: 1,
    color: 'var(--text, #fff)', letterSpacing: '-1px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  statValueBig: {
    fontSize: 'clamp(48px, 8vw, 96px)', fontWeight: 900, lineHeight: 1,
    color: 'var(--text, #fff)', letterSpacing: '-2px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  statLabel: { fontSize: 'clamp(11px, 1.3vw, 14px)', color: 'var(--text-secondary, #999)', marginTop: 4, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  paceBarContainer: {
    marginTop: 'clamp(8px, 1.5vh, 14px)', height: 14, backgroundColor: 'var(--bg-input, #333)', borderRadius: 7,
    overflow: 'visible', width: '100%', position: 'relative',
  },
  exceptionBtn: {
    marginTop: 'clamp(10px, 2vh, 18px)', alignSelf: 'center', padding: 'clamp(10px, 2vh, 16px) clamp(20px, 4vw, 32px)', borderRadius: 10,
    border: '2px solid #EF4444', backgroundColor: 'rgba(239,68,68,0.15)',
    color: '#EF4444', fontSize: 'clamp(14px, 2vw, 16px)', fontWeight: 800, cursor: 'pointer', letterSpacing: 1,
  },
  flashOverlay: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, pointerEvents: 'none' },
  flashText: { fontSize: 'clamp(48px, 10vw, 72px)', fontWeight: 900, textAlign: 'center', color: '#fff', textShadow: '2px 2px 12px rgba(0,0,0,0.8)', padding: 20 },
  offlineBanner: { backgroundColor: '#7f1d1d', border: '1px solid #EF4444', borderRadius: 8, padding: '10px 16px', textAlign: 'center', color: '#fca5a5', fontSize: 14, fontWeight: 700, marginBottom: 10 },
  idleWarning: { backgroundColor: '#422006', border: '1px solid #F97316', borderRadius: 8, padding: '10px 16px', textAlign: 'center', color: '#fdba74', fontSize: 14, fontWeight: 700, marginBottom: 10 },
  lockWarning: { backgroundColor: '#422006', border: '1px solid #F97316', borderRadius: 8, padding: '12px 16px', color: '#fdba74', fontSize: 14, fontWeight: 700, marginBottom: 14, lineHeight: 1.5 },
  warning: { marginTop: 24, padding: 16, backgroundColor: '#7f1d1d', borderRadius: 8, textAlign: 'center', fontSize: 16, fontWeight: 600 },
  paceBar: { height: '100%', borderRadius: 7, transition: 'width 0.5s ease, background-color 0.5s ease' },
  recentScans: {
    marginTop: 'clamp(12px, 2vh, 20px)', backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 10,
    border: '1px solid var(--border, #333)', overflow: 'hidden', maxHeight: 'clamp(180px, 32vh, 320px)',
    overflowY: 'auto', width: '100%',
  },
  recentTitle: { padding: '10px 14px', borderBottom: '1px solid var(--border, #333)', color: '#999', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5 },
  // Most-recent row is highlighted (subtle accent border) so operators can
  // verify the latest scan at arm's length without leaning in.
  recentRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #222', flexWrap: 'nowrap', overflow: 'hidden', minHeight: 44 },
  pauseOverlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    zIndex: 900, gap: 14, padding: 20,
  },
  pauseBox: { textAlign: 'center' },
  setupCard: {
    backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 12, padding: 'clamp(16px, 3vw, 22px) clamp(14px, 3vw, 20px)',
    maxWidth: 480, margin: 'clamp(8px, 2vh, 16px) auto', width: '100%',
  },
  stepIndicator: { fontSize: 13, color: '#777', fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 },
  setupHeading: { color: 'var(--text, #fff)', fontSize: 'clamp(22px, 4vw, 28px)', fontWeight: 800, marginBottom: 8, marginTop: 0 },
  setupHint: { color: '#999', fontSize: 15, marginBottom: 16, lineHeight: 1.5, fontWeight: 500 },
  setupInput: {
    width: '100%', padding: '12px 14px', borderRadius: 8,
    border: '1px solid var(--border, #444)', backgroundColor: 'var(--bg-input, #222)', color: 'var(--text, #fff)',
    fontSize: 16, boxSizing: 'border-box', fontWeight: 600,
  },
  pairBox: {
    textAlign: 'center', padding: '22px 16px', border: '2px dashed var(--border, #444)',
    borderRadius: 10, backgroundColor: 'var(--bg-input, #0a0a0a)', marginBottom: 14,
  },
  pairPulse: { width: 14, height: 14, borderRadius: '50%', backgroundColor: '#EAB308', margin: '0 auto 10px', animation: 'pulse 2s infinite' },
  pairText: { color: '#EAB308', fontSize: 16, fontWeight: 700, marginBottom: 10 },
  pairInput: {
    width: '80%', padding: '10px 14px', borderRadius: 8,
    border: '1px solid var(--border, #555)', backgroundColor: 'var(--bg-card, #1a1a1a)', color: 'var(--text, #fff)',
    fontSize: 15, textAlign: 'center', boxSizing: 'border-box', fontWeight: 600,
  },
  scannerStatus: { marginTop: 10 },
  scannerStatusRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  scannerStatusText: { color: '#ccc', fontSize: 15, fontWeight: 600 },
  readySummary: { backgroundColor: 'var(--bg-input, #0a0a0a)', borderRadius: 8, padding: 14, marginBottom: 16 },
  readyRow: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border, #222)' },
  readyLabel: { color: 'var(--text-secondary, #888)', fontSize: 14, fontWeight: 500 },
  readyValue: { color: 'var(--text, #fff)', fontSize: 14, fontWeight: 700 },
  primaryBtn: {
    width: '100%', padding: '14px 22px', borderRadius: 10, border: 'none',
    backgroundColor: '#22C55E', color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '10px 18px', borderRadius: 8, border: '1px solid var(--border, #444)',
    backgroundColor: 'var(--bg-input, #222)', color: 'var(--text-secondary, #ccc)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
  },
  miniModal: { backgroundColor: 'var(--bg-card, #1a1a1a)', borderRadius: 12, padding: 24, minWidth: 320, maxWidth: '90vw' },
};
