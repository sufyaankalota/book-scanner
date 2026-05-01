/**
 * Web Audio API sounds for scan feedback.
 * Success chirp, error beep, and per-color tones for Multi-PO.
 * Volume control via localStorage.
 */

let audioCtx = null;

export function getVolume() {
  return parseInt(localStorage.getItem('app-volume') || '70', 10);
}

export function setVolume(v) {
  localStorage.setItem('app-volume', String(Math.max(0, Math.min(100, v))));
}

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Safari requires resume after user gesture
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(frequency, duration, volume = 0.3) {
  try {
    const vol = getVolume() / 100;
    if (vol === 0) return;
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(volume * vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Audio not available — fail silently
  }
}

export function playErrorBeep() {
  playTone(440, 0.3, 0.5);
}

export function playSuccessBeep() {
  playTone(880, 0.12, 0.2);
}

// Distinct "already scanned" tone — two short descending beeps
export function playDuplicateBeep() {
  try {
    const vol = getVolume() / 100;
    if (vol === 0) return;
    const ctx = getAudioContext();
    // First beep
    const osc1 = ctx.createOscillator(); const g1 = ctx.createGain();
    osc1.type = 'square'; osc1.frequency.setValueAtTime(600, ctx.currentTime);
    g1.gain.setValueAtTime(0.3 * vol, ctx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.start(ctx.currentTime); osc1.stop(ctx.currentTime + 0.1);
    // Second beep (lower)
    const osc2 = ctx.createOscillator(); const g2 = ctx.createGain();
    osc2.type = 'square'; osc2.frequency.setValueAtTime(400, ctx.currentTime + 0.15);
    g2.gain.setValueAtTime(0.3 * vol, ctx.currentTime + 0.15);
    g2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.start(ctx.currentTime + 0.15); osc2.stop(ctx.currentTime + 0.25);
  } catch {}
}

// Distinct "not in manifest" tone — long low buzz
export function playNotInManifestBeep() {
  try {
    const vol = getVolume() / 100;
    if (vol === 0) return;
    const ctx = getAudioContext();
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(220, ctx.currentTime);
    g.gain.setValueAtTime(0.4 * vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
  } catch {}
}

const COLOR_TONES = {
  '#EF4444': 523,
  '#3B82F6': 587,
  '#EAB308': 659,
  '#22C55E': 698,
  '#F97316': 784,
  '#A855F7': 880,
  '#EC4899': 988,
  '#14B8A6': 1047,
  '#6366F1': 1175,
  '#84CC16': 1319,
};

export function playColorBeep(hex) {
  playTone(COLOR_TONES[hex] || 880, 0.15, 0.25);
}

// ─── Scanner disconnect alarm ───
// Loud, repeating siren-style tone meant to grab attention from across the warehouse.
// Returns a stop() function so the caller can cancel when scanning resumes.
export function playDisconnectAlarm() {
  let cancelled = false;
  let timer = null;

  const burst = () => {
    if (cancelled) return;
    try {
      const vol = getVolume() / 100;
      if (vol === 0) { timer = setTimeout(burst, 1500); return; }
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      // Two-tone siren: 800Hz → 1200Hz → 800Hz, ~1s total
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.linearRampToValueAtTime(1200, now + 0.3);
      osc.frequency.linearRampToValueAtTime(800, now + 0.6);
      gain.gain.setValueAtTime(0.6 * vol, now);
      gain.gain.setValueAtTime(0.6 * vol, now + 0.55);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.6);
    } catch {}
    timer = setTimeout(burst, 1500);
  };
  burst();

  return () => { cancelled = true; if (timer) clearTimeout(timer); };
}

// ─── Speech synthesis ───
// Used for Multi-PO color callouts so operators don't need to look at the screen.
// Browser TTS support varies — fail silently if unavailable.
let lastSpoken = { text: '', time: 0 };
export function speak(text, { rate = 1.1, pitch = 1, dedupMs = 800 } = {}) {
  try {
    if (!('speechSynthesis' in window)) return;
    const vol = getVolume() / 100;
    if (vol === 0) return;
    const t = String(text || '').trim();
    if (!t) return;
    // Avoid stutter when the same callout fires twice in quick succession
    if (t === lastSpoken.text && Date.now() - lastSpoken.time < dedupMs) return;
    lastSpoken = { text: t, time: Date.now() };
    // Cancel queued utterances so callouts stay current
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.rate = rate; u.pitch = pitch; u.volume = vol;
    window.speechSynthesis.speak(u);
  } catch {}
}

