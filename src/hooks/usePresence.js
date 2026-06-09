import { useState, useEffect, useRef } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { isScanEngineConfigured, scanEngine } from '../lib/scanEngine';

/**
 * Subscribes to /presence and re-evaluates online/stale status every 10s.
 * A pod is considered online only if it self-reported online AND its lastSeen
 * is within the threshold window.
 *
 * Single source of truth — replaces duplicated logic in Pod, PodSelect, Kiosk,
 * Home, Dashboard.
 *
 * Source of truth: scan-engine `/api/portal/presence` when VITE_SCAN_ENGINE_URL
 * is configured. Falls back to a direct Firestore listener so unwired environments
 * keep working.
 *
 * @param {number} thresholdMs - how recent lastSeen must be to count as online
 *   (default 60s). Lower values catch crashes/disconnects faster but can flap
 *   on slow networks.
 */
export function usePresence(thresholdMs = 60000) {
  const [presence, setPresence] = useState({});
  const presenceRef = useRef({});
  const rawRef = useRef({});

  useEffect(() => {
    let cancelled = false;
    let interval;
    let unsub;

    function applyRaw(raw) {
      rawRef.current = raw;
      const evaluated = evaluate(raw, thresholdMs);
      if (!cancelled) {
        setPresence(evaluated);
        presenceRef.current = evaluated;
      }
    }

    if (isScanEngineConfigured) {
      // Poll the scan-engine every 10s. Same effective cadence as the
      // Firestore listener but the network egress is paid by Railway, not
      // by per-client Firestore reads.
      const fetchOnce = async () => {
        try {
          const { pods } = await scanEngine.presence();
          const raw = {};
          for (const p of pods) {
            raw[p.podId] = {
              ...p,
              // mirror lastSeen as a Date so existing consumers that call
              // `.toDate()` still work.
              lastSeen: p.lastSeen ? { toDate: () => new Date(p.lastSeen) } : null,
            };
          }
          applyRaw(raw);
        } catch (err) {
          // Soft-fail — keep last known state. Console only; don't render an
          // error banner because the portal has many other paths still working.
          // eslint-disable-next-line no-console
          console.warn('[usePresence] scan-engine fetch failed', err);
        }
      };
      fetchOnce();
      interval = setInterval(fetchOnce, 10000);
    } else {
      unsub = onSnapshot(collection(db, 'presence'), (snap) => {
        const data = {};
        snap.forEach((d) => { data[d.id] = d.data(); });
        applyRaw(data);
      });
      // Re-evaluate periodically so a pod that stopped heartbeating flips to
      // offline without waiting for a new snapshot.
      interval = setInterval(() => applyRaw(rawRef.current), 10000);
    }

    return () => {
      cancelled = true;
      if (unsub) unsub();
      if (interval) clearInterval(interval);
    };
  }, [thresholdMs]);

  return { presence, presenceRef };
}

function evaluate(raw, thresholdMs) {
  const now = Date.now();
  const out = {};
  for (const [id, p] of Object.entries(raw)) {
    const lastSeen = p.lastSeen?.toDate?.();
    const isRecent = lastSeen && now - lastSeen.getTime() < thresholdMs;
    out[id] = { ...p, online: !!(p.online && isRecent) };
  }
  return out;
}
