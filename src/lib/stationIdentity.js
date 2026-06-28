// One worker identity per device, shared across Scan (pod), Pack, and Pallet so
// a person enters their name ONCE and can move between work areas without
// retyping it. The physical "station" field (PACK-1, pod id, etc.) stays
// per-area; only the operator name is shared here.
const KEY = 'station_operator';

export function getOperator() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setOperator(name) {
  const v = String(name || '').trim();
  if (v) localStorage.setItem(KEY, v);
}

export function clearOperator() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}
