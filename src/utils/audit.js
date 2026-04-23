/**
 * Audit logging — writes events to Firestore 'audit' collection.
 */
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

export async function logAudit(action, details = {}) {
  try {
    // Try to get current user from session
    let user = null;
    try {
      const stored = sessionStorage.getItem('bookflow-user');
      if (stored) user = JSON.parse(stored);
    } catch {}
    await addDoc(collection(db, 'audit'), {
      action,
      ...details,
      user: user ? { email: user.email, name: user.name, role: user.role } : null,
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.warn('Audit log failed:', e.message);
  }
}
