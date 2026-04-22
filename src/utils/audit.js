/**
 * Audit logging — writes events to Firestore 'audit' collection.
 */
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export async function logAudit(action, details = {}) {
  try {
    await addDoc(collection(db, 'audit'), {
      action,
      ...details,
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Audit log failed:', e.message);
  }
}
