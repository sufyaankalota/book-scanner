import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { config } from '../config';
import { logger } from './logger';

let app: App | null = null;
let firestore: Firestore | null = null;

function buildApp(): App | null {
  if (!config.FIREBASE_SERVICE_ACCOUNT) {
    logger.warn('FIREBASE_SERVICE_ACCOUNT not set — Firestore mirror disabled');
    return null;
  }

  let json: string;
  try {
    json = Buffer.from(config.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8');
  } catch (err) {
    logger.error({ err }, 'Failed to base64-decode FIREBASE_SERVICE_ACCOUNT');
    return null;
  }

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(json);
  } catch (err) {
    logger.error({ err }, 'FIREBASE_SERVICE_ACCOUNT is not valid JSON after decode');
    return null;
  }

  const projectId =
    config.FIREBASE_PROJECT_ID ?? (typeof creds.project_id === 'string' ? creds.project_id : undefined);

  return initializeApp({
    credential: cert(creds as Parameters<typeof cert>[0]),
    projectId,
  });
}

export function getFirebaseApp(): App | null {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0]!;
    return app;
  }
  app = buildApp();
  return app;
}

export function getDb(): Firestore | null {
  if (firestore) return firestore;
  const a = getFirebaseApp();
  if (!a) return null;
  firestore = getFirestore(a);
  // Ignore undefined fields so mirror docs missing optional keys don't blow up writes back.
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}
