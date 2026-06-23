import { useEffect, useRef, useCallback } from 'react';

/**
 * Input-source-agnostic scan capture for the packing stations.
 *
 * Feeds a single onScan(code) from ANY of:
 *   (a) keyboard-wedge keystrokes (USB gun, or a Linea in keyboard-emulation
 *       mode) captured at the document level — ignored while a form field is
 *       focused so manual typing still works;
 *   (b) a native bridge `window.bookflowInjectScan(code)` for a WKWebView
 *       shell that reads a Linea Pro via the IPC SDK;
 *   (c) the returned submit() for on-screen manual entry.
 *
 * This is what lets /pack and /pallet work with a wedge today and a native
 * Linea shell later with zero UI changes.
 */
function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function useScanInput(onScan, { enabled = true } = {}) {
  const bufRef = useRef('');
  const lastRef = useRef(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const fire = useCallback((code) => {
    const c = String(code || '').trim();
    if (c) onScanRef.current?.(c);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      // Never hijack manual typing in a focused form field.
      if (isEditable(document.activeElement)) return;
      const now = Date.now();
      if (now - lastRef.current > 1000) bufRef.current = '';
      lastRef.current = now;
      if (e.key === 'Enter') {
        const code = bufRef.current;
        bufRef.current = '';
        if (code) { e.preventDefault(); fire(code); }
        return;
      }
      if (e.key && e.key.length === 1) bufRef.current += e.key;
    };
    document.addEventListener('keydown', onKey);
    // Native shell bridge — a WKWebView host pushes Linea scans here.
    window.bookflowInjectScan = (code) => fire(code);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (window.bookflowInjectScan) delete window.bookflowInjectScan;
    };
  }, [enabled, fire]);

  // On-screen manual entry.
  return useCallback((code) => fire(code), [fire]);
}
