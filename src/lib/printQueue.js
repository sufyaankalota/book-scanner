// Central print queue + printer registry for the packing workflow.
//
// Web apps (and iOS Safari especially) can't silently route a print to a
// specific OS printer. So instead of each station printing locally, stations
// ENQUEUE a label job targeting a NAMED printer, and a Print Station agent
// window — one per physical printer, running Chrome with kiosk-printing whose
// default printer IS that device — prints it silently. This gives true
// multi-printer routing with no dialogs, and lets the iPod tell a palletizer
// exactly which printer to walk to.
//
// Collections:
//   printers/{id}     { name, kind: 'barcode'|'box'|'pallet'|'any', createdAt }
//   printJobs/{id}    { printerId, printerName, type, doc:{html,w,h,copies},
//                       meta, status: 'queued'|'printed'|'error', createdBy,
//                       createdAt, printedAt, error }
import { db } from '../firebase';
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs,
  query, where, onSnapshot, serverTimestamp,
} from 'firebase/firestore';

// ─── Printer registry (shared via Firestore so every station sees the same
//     list of printers to target) ───
export function watchPrinters(cb) {
  return onSnapshot(collection(db, 'printers'), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))));
  }, () => cb([])); // fail-safe (e.g. rules not yet deployed) → no printers, local print
}

export async function addPrinter({ name, kind = 'any' }) {
  const ref = await addDoc(collection(db, 'printers'), {
    name: String(name || '').trim(), kind, createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function removePrinter(id) {
  await deleteDoc(doc(db, 'printers', id));
}

// ─── Print jobs ───
export async function enqueuePrintJob({ printerId, printerName, type, labelDoc, meta = {}, createdBy = '' }) {
  if (!printerId) throw new Error('No printer selected');
  const ref = await addDoc(collection(db, 'printJobs'), {
    printerId, printerName: printerName || '', type: type || 'label',
    doc: { html: labelDoc.html, w: labelDoc.w, h: labelDoc.h, copies: labelDoc.copies || 1 },
    meta, status: 'queued', createdBy, createdAt: serverTimestamp(), printedAt: null, error: null,
  });
  return ref.id;
}

// Single-equality query (no composite index needed); caller filters/sorts.
export function watchPrinterJobs(printerId, cb) {
  const q = query(collection(db, 'printJobs'), where('printerId', '==', printerId));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
  }, () => cb([]));
}

export async function markJobPrinted(id) {
  await updateDoc(doc(db, 'printJobs', id), { status: 'printed', printedAt: serverTimestamp() });
}

export async function markJobError(id, message) {
  await updateDoc(doc(db, 'printJobs', id), { status: 'error', error: String(message || 'print failed') });
}

export async function clearPrintedJobs(printerId) {
  const q = query(collection(db, 'printJobs'), where('printerId', '==', printerId));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.filter((d) => d.data().status !== 'queued').map((d) => deleteDoc(d.ref)));
}

// ─── Per-station printer assignments (local to each station device) ───
const ASSIGN_PREFIX = 'printer_assign_';
export function getAssignment(key) {
  try { return JSON.parse(localStorage.getItem(ASSIGN_PREFIX + key) || 'null'); } catch { return null; }
}
export function setAssignment(key, value) {
  if (value) localStorage.setItem(ASSIGN_PREFIX + key, JSON.stringify(value));
  else localStorage.removeItem(ASSIGN_PREFIX + key);
}
