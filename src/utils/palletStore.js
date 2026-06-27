/**
 * Pallet store — Firestore CRUD + live listeners for the packing workflow.
 *
 * Pallets are single-PO. The pallet document id is its license-plate (the
 * value encoded in the 4x6 QR pallet label). Boxes are attached by id; the
 * pallet locks to the PO of its first box and rejects boxes from another PO.
 * Weight (lb) and height (in) are entered manually and validated on close
 * against the 2500 lb / 72 in limits.
 *
 * Collections:
 *   pallets/{palletId}                 one doc per pallet
 *   jobs/{jobId}/counters/{key}        atomic sequence counters (shared w/ boxStore)
 */
import { db } from '../firebase';
import {
  collection, doc, setDoc, updateDoc, getDoc, getDocs,
  runTransaction, writeBatch, serverTimestamp, query, where, onSnapshot,
} from 'firebase/firestore';
import { nextSeq } from './boxStore';

export const MAX_PALLET_WEIGHT_LB = 2500;
export const MAX_PALLET_HEIGHT_IN = 72;

function slug(s) {
  return String(s || '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase() || 'NA';
}

/** Open a new single-PO pallet (per-PO sequence). */
export async function openPallet({ jobId, poName, assignedBy, test = false }) {
  // `number` is a job-wide human label (Pallet 1, 2, 3 …) so every physical
  // pallet has ONE unmistakable name; `id` stays the QR license-plate.
  const [seq, number] = await Promise.all([
    nextSeq(jobId, `palletSeq_${slug(poName)}`),
    nextSeq(jobId, 'palletNumber'),
  ]);
  const id = `PLT-${slug(poName)}-${String(seq).padStart(3, '0')}`;
  const data = {
    id, number, jobId, poName: poName || '', status: 'open',
    boxIds: [], boxCount: 0, totalWeightLb: null, totalHeightIn: null,
    assignedBy: assignedBy || '', test: !!test,
    createdAt: serverTimestamp(), closedAt: null,
  };
  await setDoc(doc(db, 'pallets', id), data);
  return { ...data };
}

/**
 * Attach a box to a pallet. Enforces single-PO (pallet PO must equal box PO),
 * that the box isn't already on a pallet, and that both are open. Atomic.
 * Returns { boxCount }.
 */
export async function addBoxToPallet(palletId, boxId) {
  return runTransaction(db, async (tx) => {
    const pref = doc(db, 'pallets', palletId);
    const bref = doc(db, 'boxes', boxId);
    const [psnap, bsnap] = await Promise.all([tx.get(pref), tx.get(bref)]);
    if (!psnap.exists()) throw new Error('Pallet not found');
    if (!bsnap.exists()) throw new Error(`Unknown box: ${boxId}`);
    const p = psnap.data();
    const b = bsnap.data();
    if (p.status !== 'open') throw new Error('Pallet is closed');
    if (b.status !== 'closed') throw new Error('Box must be closed before palletizing');
    if (b.palletId) throw new Error(`Box already on ${b.palletId}`);
    if (p.poName !== b.poName) throw new Error(`Wrong pallet \u2014 box is PO ${b.poName}, pallet is PO ${p.poName}`);
    const boxIds = [...(p.boxIds || []), boxId];
    tx.update(pref, { boxIds, boxCount: boxIds.length });
    tx.update(bref, { palletId });
    return { boxCount: boxIds.length, poName: p.poName };
  });
}

/** Save in-progress weight/height without closing. */
export async function setPalletMeasurements(palletId, { weightLb, heightIn }) {
  await updateDoc(doc(db, 'pallets', palletId), {
    totalWeightLb: weightLb ?? null,
    totalHeightIn: heightIn ?? null,
  });
}

/** Validate the manual weight/height against the limits. Returns {ok, error}. */
export function checkPalletLimits({ weightLb, heightIn }) {
  if (weightLb == null || Number.isNaN(weightLb)) return { ok: false, error: 'Enter the pallet weight (lb).' };
  if (heightIn == null || Number.isNaN(heightIn)) return { ok: false, error: 'Enter the pallet height (in).' };
  if (weightLb > MAX_PALLET_WEIGHT_LB) return { ok: false, error: `Over ${MAX_PALLET_WEIGHT_LB} lb \u2014 remove a box.` };
  if (heightIn > MAX_PALLET_HEIGHT_IN) return { ok: false, error: `Over ${MAX_PALLET_HEIGHT_IN} in \u2014 remove a box.` };
  return { ok: true };
}

/** Close a pallet. Throws if the entered weight/height exceed the limits. */
export async function closePallet(palletId, { weightLb, heightIn, finalizedBy }) {
  const chk = checkPalletLimits({ weightLb, heightIn });
  if (!chk.ok) throw new Error(chk.error);
  await updateDoc(doc(db, 'pallets', palletId), {
    status: 'closed', totalWeightLb: weightLb, totalHeightIn: heightIn,
    finalizedBy: finalizedBy || null, closedAt: serverTimestamp(),
  });
}

export async function getPallet(palletId) {
  const snap = await getDoc(doc(db, 'pallets', palletId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Live list of OPEN pallets for a job (optionally filtered to a PO). */
export function watchOpenPallets(jobId, cb) {
  const q = query(collection(db, 'pallets'), where('jobId', '==', jobId), where('status', '==', 'open'));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

/**
 * Delete a pallet and FREE any boxes attached to it (clears box.palletId) so
 * they can be scanned onto another pallet. Lets a palletizer undo an extra or
 * mistaken pallet without orphaning its boxes.
 */
export async function deletePallet(palletId) {
  const pref = doc(db, 'pallets', palletId);
  const snap = await getDoc(pref);
  if (!snap.exists()) return;
  const boxIds = snap.data().boxIds || [];
  const batch = writeBatch(db);
  for (const bId of boxIds) batch.update(doc(db, 'boxes', bId), { palletId: null });
  batch.delete(pref);
  await batch.commit();
}

/** One-shot list of every pallet for a job (any status) — for the EOD export. */
export async function listPalletsForJob(jobId) {
  const snap = await getDocs(query(collection(db, 'pallets'), where('jobId', '==', jobId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
