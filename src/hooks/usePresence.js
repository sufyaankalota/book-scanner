import { useState, useEffect, useRef } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Subscribes to /presence and re-evaluates online/stale status every 10s.
 * A pod is considered online only if it self-reported online AND its lastSeen
 * is within the threshold window.
 *
 * Single source of truth — replaces duplicated logic in Pod, PodSelect, Kiosk,
 * Home, Dashboard.
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
    const unsub = onSnapshot(collection(db, 'presence'), (snap) => {
      const data = {};
      snap.forEach((d) => { data[d.id] = d.data(); });
      rawRef.current = data;
      const evaluated = evaluate(data, thresholdMs);
      setPresence(evaluated);
      presenceRef.current = evaluated;
    });

    // Re-evaluate periodically so a pod that stopped heartbeating flips to
    // offline without waiting for a new snapshot.
    const interval = setInterval(() => {
      const evaluated = evaluate(rawRef.current, thresholdMs);
      setPresence(evaluated);
      presenceRef.current = evaluated;
    }, 10000);

    return () => { unsub(); clearInterval(interval); };
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
