import {
  collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDocs,
  query, where, serverTimestamp, writeBatch,
} from 'firebase/firestore';

// ─── Demo pod / operator names (avoid collision with real pods A-E) ───
export const DEMO_PODS = ['D1', 'D2', 'D3', 'D4', 'D5'];
const DEMO_OPERATORS = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];

// Realistic book ISBNs for simulation
const SAMPLE_ISBNS = [
  '9780143127550', '9780062316097', '9780307949486', '9780525478812', '9780399590528',
  '9780316769488', '9780061120084', '9780140283334', '9780743273565', '9780452284234',
  '9780060935467', '9780684801223', '9780142437230', '9780451524935', '9780679783268',
  '9780553213119', '9780141182803', '9780140449136', '9780199535569', '9780486280615',
  '9780061734267', '9780385472579', '9780060850524', '9780684830490', '9780375725784',
  '9780140243723', '9780812981605', '9780375760266', '9780312427580', '9780316015844',
  '9780143105428', '9780060838676', '9780307277671', '9780316066525', '9780060256654',
  '9780452295292', '9780374529260', '9780679720201', '9780393970128', '9780064410397',
];

const DEMO_JOB_NAME = 'DEMO — Sample Warehouse PO';

// ─── LocalStorage helpers ───
export function isDemoMode() {
  return localStorage.getItem('bookflow_demo') === 'true';
}
export function setDemoMode(on) {
  localStorage.setItem('bookflow_demo', on ? 'true' : 'false');
}
export function getDemoJobId() {
  return localStorage.getItem('bookflow_demo_jobId') || null;
}
function saveDemoJobId(id) {
  localStorage.setItem('bookflow_demo_jobId', id || '');
}

// ─── Pod claiming: when user manually opens a demo pod, exclude it from simulation ───
const claimedPods = new Set();
export function claimDemoPod(podId) { claimedPods.add(podId); }
export function releaseDemoPod(podId) { claimedPods.delete(podId); }

// ─── Pick the right active job from a snapshot ───
export function pickActiveJob(docs) {
  const demo = isDemoMode();
  for (const d of docs) {
    const data = d.data();
    if (demo && data.meta?.isDemo) return { id: d.id, ...data };
    if (!demo && !data.meta?.isDemo) return { id: d.id, ...data };
  }
  return null;
}

// ─── Create demo job ───
export async function createDemoJob(db) {
  const jobId = `demo_${Date.now()}`;
  await setDoc(doc(db, 'jobs', jobId), {
    meta: {
      name: DEMO_JOB_NAME,
      mode: 'single',
      dailyTarget: 22000,
      workingHours: 8,
      pods: DEMO_PODS,
      active: true,
      isDemo: true,
      location: 'Demo Warehouse',
      createdAt: serverTimestamp(),
    },
    poColors: {},
  });

  // Seed some initial scans so the dashboard isn't empty
  const seedCount = 80 + Math.floor(Math.random() * 40);
  const batch = writeBatch(db);
  for (let i = 0; i < Math.min(seedCount, 400); i++) {
    const podIdx = i % DEMO_PODS.length;
    const ref = doc(collection(db, 'scans'));
    batch.set(ref, {
      jobId,
      podId: DEMO_PODS[podIdx],
      scannerId: DEMO_OPERATORS[podIdx],
      isbn: SAMPLE_ISBNS[Math.floor(Math.random() * SAMPLE_ISBNS.length)],
      poName: DEMO_JOB_NAME,
      timestamp: serverTimestamp(),
      type: 'standard',
    });
  }
  await batch.commit();

  saveDemoJobId(jobId);
  setDemoMode(true);
  return jobId;
}

// ─── Live scan simulation ───
let simInterval = null;
let presenceInterval = null;

export function startSimulation(db, jobId) {
  stopSimulation(); // clear any existing

  const addScans = () => {
    const available = DEMO_PODS.filter((p) => !claimedPods.has(p));
    if (available.length === 0) return;
    const count = Math.floor(Math.random() * 3) + 1; // 1-3 scans per tick
    for (let i = 0; i < count; i++) {
      const pod = available[Math.floor(Math.random() * available.length)];
      const opIdx = DEMO_PODS.indexOf(pod);
      addDoc(collection(db, 'scans'), {
        jobId,
        podId: pod,
        scannerId: DEMO_OPERATORS[opIdx],
        isbn: SAMPLE_ISBNS[Math.floor(Math.random() * SAMPLE_ISBNS.length)],
        poName: DEMO_JOB_NAME,
        timestamp: serverTimestamp(),
        type: 'standard',
      }).catch(() => {}); // swallow errors silently
    }
  };

  const heartbeat = () => {
    for (let i = 0; i < DEMO_PODS.length; i++) {
      if (claimedPods.has(DEMO_PODS[i])) continue; // skip manually-opened pods
      setDoc(doc(db, 'presence', DEMO_PODS[i]), {
        podId: DEMO_PODS[i],
        scanners: [DEMO_OPERATORS[i]],
        operator: DEMO_OPERATORS[i],
        status: 'scanning',
        online: true,
        lastSeen: serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }
  };

  heartbeat(); // immediate
  addScans(); // immediate first batch
  simInterval = setInterval(addScans, 2500);
  presenceInterval = setInterval(heartbeat, 12000);
}

export function stopSimulation() {
  if (simInterval) { clearInterval(simInterval); simInterval = null; }
  if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
}

// ─── Full cleanup: stop sim, delete all demo data, reset state ───
export async function cleanupDemo(db) {
  stopSimulation();
  const jobId = getDemoJobId();
  if (!jobId) { setDemoMode(false); saveDemoJobId(null); return; }

  try {
    // Close job
    await updateDoc(doc(db, 'jobs', jobId), {
      'meta.active': false,
      'meta.closedAt': serverTimestamp(),
    }).catch(() => {});

    // Reset demo pod presence
    for (const podId of DEMO_PODS) {
      await setDoc(doc(db, 'presence', podId), {
        podId, scanners: [], operator: '', status: 'offline',
        online: false, lastSeen: serverTimestamp(),
      }).catch(() => {});
    }

    // Delete demo scans in batches
    const scanSnap = await getDocs(query(collection(db, 'scans'), where('jobId', '==', jobId)));
    const BATCH = 400;
    for (let i = 0; i < scanSnap.docs.length; i += BATCH) {
      const batch = writeBatch(db);
      scanSnap.docs.slice(i, i + BATCH).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Delete demo job doc
    await deleteDoc(doc(db, 'jobs', jobId)).catch(() => {});
  } catch (err) {
    console.warn('Demo cleanup error:', err);
  }

  setDemoMode(false);
  saveDemoJobId(null);
}
