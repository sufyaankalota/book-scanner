import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

const trim = (v) => (v || '').trim();

const firebaseConfig = {
  apiKey: trim(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: trim(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: trim(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: trim(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: trim(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: trim(import.meta.env.VITE_FIREBASE_APP_ID),
};

const app = initializeApp(firebaseConfig);

// Use modern persistent cache with multi-tab support
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

export { db };
