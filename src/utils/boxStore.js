/**
 * Box store — Firestore CRUD + live listeners for the packing workflow.
 *
 * Boxes are single-PO. The box document id is its license-plate (the value
 * encoded in the 4x6 QR box label); contents live in a `items` subcollection
 * keyed by ISBN-13 (idempotent — a re-scan can't double-add).
 *
 * Collections:
 *   boxes/{boxId}                      one doc per box
 *   boxes/{boxId}/items/{isbn13}       box-content ledger
 *   jobs/{jobId}/counters/{key}        atomic sequence counters
 */
import { db } from '../firebase';
import {
  collection, doc, setDoc, updateDoc, getDoc, deleteDoc, getDocs,
  runTransaction, serverTimestamp, query, where, onSnapshot, orderBy,
} from 'firebase/firestore';

function slug(s) {
  return String(s || '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase() || 'NA';
}

/** Atomically allocate the next sequence number for a (job, key). */
export async function nextSeq(jobId, key) {
  const ref = doc(db, 'jobs', jobId, 'counters', key);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const n = (snap.exists() ? (snap.data().n || 0) : 0) + 1;
    tx.set(ref, { n }, { merge: true });
    return n;
  });
}

/** Open a new single-PO box. Returns the created box (id = license plate). */
export async function openBox({ jobId, poName, packedBy, station, test = false }) {
  const seq = await nextSeq(jobId, 'boxSeq');
  const id = `BOX-${slug(poName)}-${String(seq).padStart(5, '0')}`;
  const data = {
    id, jobId, poName: poName || '', status: 'open',
    packedBy: packedBy || '', station: station || '',
    itemCount: 0, palletId: null, test: !!test,
    createdAt: serverTimestamp(), closedAt: null,
  };
  await setDoc(doc(db, 'boxes', id), data);
  return { ...data };
}

/**
 * Add a book to a box. Idempotent on isbn13 (re-scan is a no-op). Bumps the
 * box itemCount in the same transaction so the count never drifts.
 */
export async function addBoxItem(boxId, { isbn13, title, source }) {
  return runTransaction(db, async (tx) => {
    const bref = doc(db, 'boxes', boxId);
    const iref = doc(db, 'boxes', boxId, 'items', isbn13);
    const [bsnap, isnap] = await Promise.all([tx.get(bref), tx.get(iref)]);
    if (!bsnap.exists()) throw new Error('Box not found');
    if (bsnap.data().status !== 'open') throw new Error('Box is already closed');
    if (isnap.exists()) return { added: false, itemCount: bsnap.data().itemCount || 0 };
    tx.set(iref, { isbn13, title: title || '', source: source || 'scan', addedAt: serverTimestamp() });
    const n = (bsnap.data().itemCount || 0) + 1;
    tx.update(bref, { itemCount: n });
    return { added: true, itemCount: n };
  });
}

export async function closeBox(boxId) {
  await updateDoc(doc(db, 'boxes', boxId), { status: 'closed', closedAt: serverTimestamp() });
}

export async function getBox(boxId) {
  const snap = await getDoc(doc(db, 'boxes', boxId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Live list of OPEN boxes for a job (used by the pack station to route). */
export function watchOpenBoxes(jobId, cb) {
  const q = query(collection(db, 'boxes'), where('jobId', '==', jobId), where('status', '==', 'open'));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

/** Live list of a box's items (newest first). */
export function watchBoxItems(boxId, cb) {
  const q = query(collection(db, 'boxes', boxId, 'items'), orderBy('addedAt', 'desc'));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

/** Delete a box + its items (used to clean up TEST-job data). */
export async function deleteBox(boxId) {
  const items = await getDocs(collection(db, 'boxes', boxId, 'items'));
  await Promise.all(items.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, 'boxes', boxId));
}
