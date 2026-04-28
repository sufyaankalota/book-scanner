/**
 * Centralized app constants.
 * Avoid magic numbers scattered across pages.
 */

// ── Pod scanning ──
export const POD = {
  DEBOUNCE_MS: 5000,
  BARCODE_TIMEOUT_MS: 3000,
  IDLE_WARNING_MS: 120000, // 2 min
  AUTO_CLOSE_SHIFT_MS: 30 * 60 * 1000, // 30 min idle → auto-close
  BREAK_DURATIONS: [15 * 60, 30 * 60], // seconds
  PACE_WINDOW_MS: 5 * 60 * 1000, // 5-min rolling window for pace
  RECENT_SCANS_MAX: 20,
};

// ── Dashboard / pagination ──
export const PAGINATION = {
  EXCEPTION_PAGE_SIZE: 50,
  SCAN_PAGE_SIZE: 100,
};

// ── Notifications ──
export const ALERT = {
  PO_WARN_PCT: 95, // notify supervisor at this completion %
};

// ── Auth ──
export const AUTH = {
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_MS: 5 * 60 * 1000,
};
