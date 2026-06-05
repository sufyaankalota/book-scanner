import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
} from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const trim = (v) => (v || '').trim();

const firebaseConfig = {
  apiKey: trim(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: trim(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: trim(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: trim(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: trim(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: trim(import.meta.env.VITE_FIREBASE_APP_ID),
};

// Validate required env vars early — fail loud at boot rather than fail silently in queries
const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];
const missing = REQUIRED_KEYS.filter((k) => !firebaseConfig[k]);
if (missing.length) {
  const msg = `Missing Firebase config: ${missing.map((k) => `VITE_FIREBASE_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`).join(', ')}`;
  // Show in DOM so it's visible on the kiosk even if console is closed
  if (typeof document !== 'undefined') {
    document.body.innerHTML = `<div style="font-family:system-ui;padding:40px;color:#fff;background:#7f1d1d;min-height:100vh;"><h1>Configuration Error</h1><p>${msg}</p><p style="opacity:0.8;font-size:14px">Set these in your hosting environment and redeploy.</p></div>`;
  }
  throw new Error(msg);
}

const app = initializeApp(firebaseConfig);

// Try modern persistent cache (multi-tab) first. If IndexedDB is broken on
// the kiosk (wedged on Chromebooks after long uptime) the SDK will throw
// here — fall back to in-memory cache so the pod can still talk to
// Firestore. We do the persistent->memory fallback synchronously by
// catching the constructor; the SDK validates IDB lazily but persistentMultipleTabManager
// throws immediately if document/window globals aren't usable.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('Persistent Firestore cache unavailable, falling back to memory cache:', err?.message);
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
}

const functions = getFunctions(app, 'us-east1');

export { db, functions };
