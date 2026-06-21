/**
 * Theme management — CSS custom properties approach.
 * Stores preference in localStorage, applies data-theme to <html>.
 */

// Palette notes (design sweep):
//  - Neutrals are tinted toward cool ink, never pure black/white/gray.
//  - One confident interactive accent (azure/cobalt) across all themes for
//    brand cohesion; warm amber "signal" for scan-positive energy. No AI
//    indigo→purple gradients.
//  - *-soft tokens are low-alpha fills for chips/hover/badges.
//  - --shadow-rgb feeds tinted, layered shadows defined in App.css.
const THEMES = {
  light: {
    '--bg': '#f7f8fb', '--bg-subtle': '#eef1f6', '--bg-card': '#ffffff',
    '--bg-elev': '#ffffff', '--bg-input': '#f1f3f8',
    '--text': '#141925', '--text-secondary': '#5a6376', '--text-tertiary': '#8a93a6',
    '--border': '#e3e7ef', '--border-strong': '#cdd3df',
    '--accent': '#2f5fe0', '--accent-hover': '#244fc4',
    '--accent-soft': 'rgba(47,95,224,0.10)', '--accent-contrast': '#ffffff',
    '--signal': '#d97706', '--signal-soft': 'rgba(217,119,6,0.12)',
    '--success': '#0f9d58', '--success-soft': 'rgba(15,157,88,0.12)',
    '--error': '#d83a52', '--error-soft': 'rgba(216,58,82,0.10)',
    '--warning': '#d97706', '--warning-soft': 'rgba(217,119,6,0.12)',
    '--info': '#2f5fe0', '--info-soft': 'rgba(47,95,224,0.10)',
    '--ring': '#2f5fe0', '--shadow-rgb': '30 41 59',
  },
  dark: {
    '--bg': '#0e1118', '--bg-subtle': '#12151d', '--bg-card': '#161a24',
    '--bg-elev': '#1b2030', '--bg-input': '#1b2030',
    '--text': '#eef1f7', '--text-secondary': '#9aa4b8', '--text-tertiary': '#69728a',
    '--border': '#252b3a', '--border-strong': '#333b4f',
    '--accent': '#4d7cff', '--accent-hover': '#6b93ff',
    '--accent-soft': 'rgba(77,124,255,0.16)', '--accent-contrast': '#ffffff',
    '--signal': '#f5a524', '--signal-soft': 'rgba(245,165,36,0.16)',
    '--success': '#2fbf71', '--success-soft': 'rgba(47,191,113,0.16)',
    '--error': '#f0506e', '--error-soft': 'rgba(240,80,110,0.16)',
    '--warning': '#f5a524', '--warning-soft': 'rgba(245,165,36,0.16)',
    '--info': '#4d7cff', '--info-soft': 'rgba(77,124,255,0.16)',
    '--ring': '#6b93ff', '--shadow-rgb': '4 6 12',
  },
  dim: {
    '--bg': '#141733', '--bg-subtle': '#181c3d', '--bg-card': '#1b1f44',
    '--bg-elev': '#222659', '--bg-input': '#232861',
    '--text': '#e6e9f7', '--text-secondary': '#9aa1c9', '--text-tertiary': '#6c739c',
    '--border': '#2c3164', '--border-strong': '#3a4079',
    '--accent': '#7aa2ff', '--accent-hover': '#9bb9ff',
    '--accent-soft': 'rgba(122,162,255,0.18)', '--accent-contrast': '#0c0f24',
    '--signal': '#fbbf45', '--signal-soft': 'rgba(251,191,69,0.18)',
    '--success': '#34d399', '--success-soft': 'rgba(52,211,153,0.18)',
    '--error': '#fb7185', '--error-soft': 'rgba(251,113,133,0.18)',
    '--warning': '#fbbf45', '--warning-soft': 'rgba(251,191,69,0.18)',
    '--info': '#7aa2ff', '--info-soft': 'rgba(122,162,255,0.18)',
    '--ring': '#9bb9ff', '--shadow-rgb': '6 8 28',
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
