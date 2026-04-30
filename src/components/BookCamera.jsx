import React, { useEffect, useRef, useState, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

/**
 * BookCamera — opens the laptop's webcam, watches for a stable book in frame,
 * auto-captures, and asks the Cloud Function to extract either an ISBN
 * (from a copyright page) or a Title (from a cover).
 *
 * Props:
 *   mode: 'isbn' | 'title'
 *   podId, jobId: forwarded to the function for telemetry
 *   onResult({ isbn?, title?, author?, confidence, image? }): called on success.
 *     For 'title' mode, image is a JPEG data URL the caller can persist for
 *     customer verification.
 *   onClose(): user cancelled
 */
export default function BookCamera({ mode, podId, jobId, onResult, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const sampleRef = useRef(null); // tiny canvas for stability sampling
  const lastFrameRef = useRef(null);
  const stableSinceRef = useRef(null);
  const detectionLoopRef = useRef(null);
  const streamRef = useRef(null);

  const [devices, setDevices] = useState([]);
  // Persisted preferences (per pod): preferred deviceId AND preferred label,
  // since deviceIds can rotate when devices are unplugged/replugged.
  const prefKey = `bookCamera_pref_${podId || ''}`;
  const [pref, setPref] = useState(() => {
    try { return JSON.parse(localStorage.getItem(prefKey) || 'null') || {}; } catch { return {}; }
  });
  const [deviceId, setDeviceId] = useState(pref.deviceId || '');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('starting'); // starting | watching | captured | sending | done | error
  const [statusMsg, setStatusMsg] = useState('Starting camera...');
  const [pausedDetection, setPausedDetection] = useState(false);

  // ─── Camera lifecycle ───
  const startStream = useCallback(async (id) => {
    // Halt detection during the swap so we don't auto-capture a stale frame.
    setPhase('starting');
    setStatusMsg('Switching camera...');
    lastFrameRef.current = null;
    stableSinceRef.current = null;
    try {
      // Stop any existing stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        try { videoRef.current.srcObject = null; } catch {}
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: id ? { exact: id } : undefined,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            facingMode: id ? undefined : 'environment',
          },
          audio: false,
        });
      } catch (e) {
        // Fall back to no exact deviceId if the requested one is gone
        if (id) {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
          });
        } else { throw e; }
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Wait for video to actually have frames before resuming detection
        await new Promise((resolve) => {
          const v = videoRef.current;
          if (!v) return resolve();
          if (v.readyState >= 2) return resolve();
          const onReady = () => { v.removeEventListener('loadeddata', onReady); resolve(); };
          v.addEventListener('loadeddata', onReady);
          setTimeout(resolve, 1500); // safety timeout
        });
        await videoRef.current.play().catch(() => {});
      }
      // Enumerate devices (labels populate after permission grant)
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      setDevices(list);
      const active = stream.getVideoTracks()[0]?.getSettings()?.deviceId;
      if (active) setDeviceId(active);
      setPhase('watching');
      setStatusMsg(mode === 'isbn'
        ? 'Hold the copyright page steady under the camera'
        : 'Hold the book cover steady under the camera');
    } catch (err) {
      setError(err.message || 'Could not access camera');
      setPhase('error');
    }
  }, [mode]);

  useEffect(() => {
    // On open, pick a starting device:
    //  1) saved deviceId from prefs
    //  2) device whose label matches saved label (handles deviceId rotation)
    //  3) system default
    let startId = pref.deviceId || '';
    (async () => {
      try {
        // We need a temporary permission grant before labels populate
        if (!startId && pref.label) {
          const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
          tmp.getTracks().forEach((t) => t.stop());
          const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          const match = list.find((d) => d.label === pref.label);
          if (match) startId = match.deviceId;
        }
      } catch {}
      startStream(startId);
    })();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (detectionLoopRef.current) {
        cancelAnimationFrame(detectionLoopRef.current);
        detectionLoopRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeviceChange = (e) => {
    const id = e.target.value;
    setDeviceId(id);
    startStream(id);
  };

  const isDefault = pref.deviceId && pref.deviceId === deviceId;
  const setAsDefault = () => {
    const dev = devices.find((d) => d.deviceId === deviceId);
    const next = { deviceId, label: dev?.label || '' };
    try { localStorage.setItem(prefKey, JSON.stringify(next)); } catch {}
    setPref(next);
  };
  const clearDefault = () => {
    try { localStorage.removeItem(prefKey); } catch {}
    setPref({});
  };

  // ─── Stability detection ───
  // Sample a small grayscale grid every ~120ms. If consecutive frames are
  // very similar AND the frame contains "stuff" (variance high enough that
  // it isn't an empty bench), trigger auto-capture after 800ms of stability.
  useEffect(() => {
    if (phase !== 'watching' || pausedDetection) return;
    let cancelled = false;

    const SAMPLE_W = 64;
    const SAMPLE_H = 48;
    const SIMILARITY_THRESHOLD = 6;     // mean absolute pixel diff to count as "same"
    const MIN_VARIANCE = 250;           // require some content in frame
    const STABLE_MS = 800;
    const tickEvery = 120;
    let lastTick = 0;

    if (!sampleRef.current) {
      const c = document.createElement('canvas');
      c.width = SAMPLE_W; c.height = SAMPLE_H;
      sampleRef.current = c;
    }
    const sampleCtx = sampleRef.current.getContext('2d', { willReadFrequently: true });

    const sampleFrame = () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) return null;
      sampleCtx.drawImage(v, 0, 0, SAMPLE_W, SAMPLE_H);
      const data = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      // grayscale array + variance
      const gray = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H);
      let sum = 0;
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
        gray[j] = g;
        sum += g;
      }
      const mean = sum / gray.length;
      let varSum = 0;
      for (let j = 0; j < gray.length; j++) varSum += (gray[j] - mean) * (gray[j] - mean);
      const variance = varSum / gray.length;
      return { gray, variance };
    };

    const diff = (a, b) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
      return d / a.length;
    };

    const loop = (ts) => {
      if (cancelled) return;
      detectionLoopRef.current = requestAnimationFrame(loop);
      if (ts - lastTick < tickEvery) return;
      lastTick = ts;

      const sample = sampleFrame();
      if (!sample) return;

      if (sample.variance < MIN_VARIANCE) {
        // Empty / uniform frame — reset
        stableSinceRef.current = null;
        lastFrameRef.current = sample.gray;
        setStatusMsg(mode === 'isbn'
          ? 'Place the copyright page in view'
          : 'Place the book cover in view');
        return;
      }

      if (lastFrameRef.current) {
        const d = diff(sample.gray, lastFrameRef.current);
        if (d < SIMILARITY_THRESHOLD) {
          if (!stableSinceRef.current) {
            stableSinceRef.current = ts;
            setStatusMsg('Hold steady...');
          } else if (ts - stableSinceRef.current >= STABLE_MS) {
            // Lock in
            stableSinceRef.current = null;
            captureAndExtract();
            return;
          }
        } else {
          stableSinceRef.current = null;
          setStatusMsg(mode === 'isbn'
            ? 'Position the ISBN/copyright page'
            : 'Position the book cover');
        }
      }
      lastFrameRef.current = sample.gray;
    };
    detectionLoopRef.current = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      if (detectionLoopRef.current) cancelAnimationFrame(detectionLoopRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pausedDetection]);

  // ─── Capture full-resolution frame & call function ───
  const captureAndExtract = useCallback(async () => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) return;
    setPhase('captured');
    setPausedDetection(true);
    setStatusMsg('Captured — analyzing...');

    // Full-res capture
    const cw = v.videoWidth, ch = v.videoHeight;
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    const canvas = canvasRef.current;

    // ISBN text on copyright pages is tiny, so keep more resolution for ISBN mode.
    // Title covers are large and readable, 1024 is plenty.
    const TARGET = mode === 'isbn' ? 1800 : 1024;
    const QUALITY = mode === 'isbn' ? 0.92 : 0.85;
    const scale = Math.min(TARGET / Math.max(cw, ch), 1);
    canvas.width = Math.round(cw * scale);
    canvas.height = Math.round(ch * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
    const base64 = dataUrl.split(',')[1];

    // Also keep a small thumbnail for storage when needed (title mode)
    let thumb = null;
    if (mode === 'title') {
      const tCanvas = document.createElement('canvas');
      const T = 480;
      const ts = Math.min(T / Math.max(canvas.width, canvas.height), 1);
      tCanvas.width = Math.round(canvas.width * ts);
      tCanvas.height = Math.round(canvas.height * ts);
      tCanvas.getContext('2d').drawImage(canvas, 0, 0, tCanvas.width, tCanvas.height);
      thumb = tCanvas.toDataURL('image/jpeg', 0.7);
    }

    setPhase('sending');
    const t0 = performance.now();
    console.log('[BookCamera] sending image to extractFromImage', { mode, podId, jobId, base64Length: base64.length });
    try {
      const call = httpsCallable(functions, 'extractFromImage');
      const resp = await call({ imageBase64: base64, mode, podId, jobId });
      const data = resp.data || {};
      const ms = Math.round(performance.now() - t0);
      console.log('[BookCamera] extractFromImage response', { ms, data });
      const ok = mode === 'isbn' ? !!data.isbn : !!data.title;
      if (!ok) {
        // Persist a clear no-result message and pause auto-capture so the user can read it
        setStatusMsg(mode === 'isbn'
          ? `No ISBN detected (⋅${ms}ms). Adjust the page — click “Try Again” below.`
          : `Couldn’t read the title (⋅${ms}ms). Adjust the cover — click “Try Again” below.`);
        setPhase('failed');
        return;
      }
      setPhase('done');
      onResult({ ...data, image: thumb });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      console.error('[BookCamera] extractFromImage error', err);
      const detail = err?.details ? JSON.stringify(err.details) : '';
      setStatusMsg(`AI request failed (${ms}ms): ${err.code || ''} ${err.message || 'unknown'} ${detail}`.trim());
      setPhase('failed');
    }
  }, [mode, podId, jobId, onResult]);

  return (
    <div style={st.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={st.modal} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <h2 style={st.title}>
            {mode === 'isbn' ? '🔢 Auto-Read ISBN' : '📖 Auto-Read Title'}
          </h2>
          <button style={st.closeX} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={st.videoWrap}>
          <video ref={videoRef} style={st.video} playsInline muted />
          {phase === 'sending' && (
            <div style={st.overlay2}>
              <div style={st.spinner} />
              <div style={st.overlayText}>Reading with GPT-4o...</div>
            </div>
          )}
          {phase === 'captured' && (
            <div style={st.flashBox} />
          )}
          {phase === 'watching' && (
            <div style={st.cornerHint}>
              {stableSinceRef.current ? '⏱ Hold steady...' : '🎯 Auto-capture'}
            </div>
          )}
        </div>

        <div style={st.statusBar}>{error || statusMsg}</div>

        {phase === 'failed' && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <button
              onClick={() => {
                lastFrameRef.current = null;
                stableSinceRef.current = null;
                setPausedDetection(false);
                setPhase('watching');
                setStatusMsg(mode === 'isbn'
                  ? 'Hold the copyright page steady under the camera'
                  : 'Hold the book cover steady under the camera');
              }}
              style={{ ...st.captureBtn, flex: 1, backgroundColor: '#22C55E' }}>
              🔄 Try Again
            </button>
            <button onClick={onClose} style={st.cancelBtn}>Cancel</button>
          </div>
        )}

        <div style={st.controls}>
          {devices.length > 1 && (
            <select
              value={deviceId}
              onChange={handleDeviceChange}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              style={st.select}
            >
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 6)}`}</option>
              ))}
            </select>
          )}
          {devices.length > 1 && deviceId && (
            isDefault ? (
              <button onClick={clearDefault} title="This camera is the default for this pod" style={st.pinBtnActive}>★ Default</button>
            ) : (
              <button onClick={setAsDefault} title="Pin this camera as the default for this pod" style={st.pinBtn}>☆ Set default</button>
            )
          )}
          <button
            onClick={() => {
              lastFrameRef.current = null;
              stableSinceRef.current = null;
              captureAndExtract();
            }}
            disabled={phase !== 'watching'}
            style={{ ...st.captureBtn, opacity: phase === 'watching' ? 1 : 0.5, cursor: phase === 'watching' ? 'pointer' : 'not-allowed' }}>
            📸 Capture Now
          </button>
          <button onClick={onClose} style={st.cancelBtn}>Cancel</button>
        </div>

        <p style={st.helpText}>
          {mode === 'isbn'
            ? 'Tip: open the book to the copyright page (often page 4) and hold it flat under the camera. Brighter light = faster reads.'
            : 'Tip: lay the cover flat under the camera. Auto-capture fires when the image is steady for ~1s.'}
        </p>
      </div>
    </div>
  );
}

const st = {
  overlay: { position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 12 },
  modal: { backgroundColor: '#0f0f0f', border: '2px solid #3B82F6', borderRadius: 14, padding: 20, width: '100%', maxWidth: 720, maxHeight: '94vh', overflowY: 'auto', fontFamily: "'Inter', system-ui, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { color: '#fff', fontSize: 22, fontWeight: 800, margin: 0 },
  closeX: { background: 'none', border: '1px solid #555', borderRadius: 6, color: '#888', fontSize: 18, width: 36, height: 36, cursor: 'pointer' },
  videoWrap: { position: 'relative', width: '100%', aspectRatio: '4/3', backgroundColor: '#000', borderRadius: 10, overflow: 'hidden', border: '1px solid #2a2a2a' },
  video: { width: '100%', height: '100%', objectFit: 'cover' },
  overlay2: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)', gap: 12 },
  overlayText: { color: '#93C5FD', fontWeight: 700, fontSize: 16 },
  spinner: { width: 44, height: 44, border: '4px solid rgba(147,197,253,0.25)', borderTopColor: '#93C5FD', borderRadius: '50%', animation: 'bcs 1s linear infinite' },
  flashBox: { position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.4)', animation: 'bcfade 0.4s ease-out forwards' },
  cornerHint: { position: 'absolute', top: 10, right: 12, padding: '4px 10px', borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.6)', color: '#93C5FD', fontSize: 12, fontWeight: 700 },
  statusBar: { color: '#93C5FD', fontSize: 14, fontWeight: 700, padding: '10px 0', textAlign: 'center', minHeight: 18 },
  controls: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 },
  select: { padding: '10px 12px', borderRadius: 8, border: '1px solid #333', backgroundColor: '#1a1a1a', color: '#ddd', fontSize: 13, flex: 1, minWidth: 120 },
  pinBtn: { padding: '10px 12px', borderRadius: 8, border: '1px solid #555', backgroundColor: '#1a1a1a', color: '#aaa', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  pinBtnActive: { padding: '10px 12px', borderRadius: 8, border: '1px solid #EAB308', backgroundColor: '#3a2e08', color: '#EAB308', fontSize: 12, fontWeight: 800, cursor: 'pointer' },
  captureBtn: { padding: '12px 20px', borderRadius: 10, border: 'none', backgroundColor: '#3B82F6', color: '#fff', fontSize: 15, fontWeight: 800 },
  cancelBtn: { padding: '12px 20px', borderRadius: 10, border: '1px solid #555', backgroundColor: '#2a2a2a', color: '#ccc', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  helpText: { color: '#666', fontSize: 12, marginTop: 12, lineHeight: 1.5 },
};

// Inject keyframes once
if (typeof document !== 'undefined' && !document.getElementById('book-camera-keyframes')) {
  const s = document.createElement('style');
  s.id = 'book-camera-keyframes';
  s.textContent = `@keyframes bcs { to { transform: rotate(360deg); } } @keyframes bcfade { from { opacity: 1 } to { opacity: 0 } }`;
  document.head.appendChild(s);
}
