/**
 * Theme management — CSS custom properties approach.
 * Stores preference in localStorage, applies data-theme to <html>.
 */

const THEMES = {
  light: {
    '--bg': '#ffffff', '--bg-card': '#f9fafb', '--bg-input': '#f3f4f6',
    '--text': '#111827', '--text-secondary': '#6b7280', '--border': '#d1d5db',
    '--accent': '#2563eb', '--accent-hover': '#1d4ed8',
    '--success': '#16a34a', '--error': '#dc2626', '--warning': '#d97706',
  },
  dark: {
    '--bg': '#111827', '--bg-card': '#1f2937', '--bg-input': '#374151',
    '--text': '#f9fafb', '--text-secondary': '#9ca3af', '--border': '#4b5563',
    '--accent': '#3b82f6', '--accent-hover': '#60a5fa',
    '--success': '#22c55e', '--error': '#ef4444', '--warning': '#eab308',
  },
  dim: {
    '--bg': '#1a1a2e', '--bg-card': '#16213e', '--bg-input': '#0f3460',
    '--text': '#e2e8f0', '--text-secondary': '#94a3b8', '--border': '#334155',
    '--accent': '#818cf8', '--accent-hover': '#a5b4fc',
    '--success': '#34d399', '--error': '#f87171', '--warning': '#fbbf24',
  },
};

export function getTheme() {
  return localStorage.getItem('app-theme') || 'dark';
}

export function setTheme(name) {
  if (!THEMES[name]) return;
  localStorage.setItem('app-theme', name);
  applyTheme(name);
}

export function applyTheme(name) {
  const vars = THEMES[name || getTheme()];
  if (!vars) return;
  const root = document.documentElement;
  root.setAttribute('data-theme', name || getTheme());
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
}

export function cycleTheme() {
  const order = ['light', 'dark', 'dim'];
  const cur = getTheme();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setTheme(next);
  return next;
}

// Apply saved theme on import
applyTheme(getTheme());
