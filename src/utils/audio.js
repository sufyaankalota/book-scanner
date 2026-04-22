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
