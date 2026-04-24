import {
  collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDocs,
  query, where, serverTimestamp, writeBatch, Timestamp,
} from 'firebase/firestore';
import * as XLSX from 'xlsx';

// ─── Demo pod / operator names (avoid collision with real pods A-E) ───
export const DEMO_PODS = ['D1', 'D2', 'D3', 'D4', 'D5'];
const DEMO_OPERATORS = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];
const EXCEPTION_REASONS = ['Damaged / Unsellable', 'No ISBN Barcode', 'Not a Book', 'Other'];

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
  // Seed some exceptions (~8-15)
  const excCount = 8 + Math.floor(Math.random() * 8);
  for (let i = 0; i < excCount; i++) {
    const podIdx = i % DEMO_PODS.length;
    const ref = doc(collection(db, 'exceptions'));
    batch.set(ref, {
      jobId,
      podId: DEMO_PODS[podIdx],
      scannerId: DEMO_OPERATORS[podIdx],
      isbn: SAMPLE_ISBNS[Math.floor(Math.random() * SAMPLE_ISBNS.length)],
      title: null,
      reason: EXCEPTION_REASONS[Math.floor(Math.random() * EXCEPTION_REASONS.length)],
      photo: null,
      timestamp: serverTimestamp(),
    });
  }
  await batch.commit();

  // Seed sample billing reports for past 3 weeks
  await seedBillingReports(db, jobId);

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
      // ~8% chance of an exception instead of a standard scan
      if (Math.random() < 0.08) {
        addDoc(collection(db, 'exceptions'), {
          jobId,
          podId: pod,
          scannerId: DEMO_OPERATORS[opIdx],
          isbn: SAMPLE_ISBNS[Math.floor(Math.random() * SAMPLE_ISBNS.length)],
          title: null,
          reason: EXCEPTION_REASONS[Math.floor(Math.random() * EXCEPTION_REASONS.length)],
          photo: null,
          timestamp: serverTimestamp(),
        }).catch(() => {});
      } else {
        addDoc(collection(db, 'scans'), {
          jobId,
          podId: pod,
          scannerId: DEMO_OPERATORS[opIdx],
          isbn: SAMPLE_ISBNS[Math.floor(Math.random() * SAMPLE_ISBNS.length)],
          poName: DEMO_JOB_NAME,
          timestamp: serverTimestamp(),
          type: 'standard',
        }).catch(() => {});
      }
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

// ─── Seed sample billing reports for the past 3 weeks ───
async function seedBillingReports(db, jobId) {
  const RATE_REGULAR = 0.40;
  const RATE_EXCEPTION = 0.60;
  const now = new Date();

  for (let w = 1; w <= 3; w++) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (weekStart.getDay() || 7) - (w * 7) + 1); // Monday of w weeks ago
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const standardCount = 2800 + Math.floor(Math.random() * 1200);
    const exceptionCount = 30 + Math.floor(Math.random() * 40);
    const totalAmount = standardCount * RATE_REGULAR + exceptionCount * RATE_EXCEPTION;

    // Build a small XLSX in-memory for the downloadable file
    const wb = XLSX.utils.book_new();
    const summaryRows = [
      { Item: 'Customer / Job', Detail: DEMO_JOB_NAME, Qty: '', Rate: '', Amount: '' },
      { Item: 'Billing Period', Detail: `${weekStart.toLocaleDateString()} – ${weekEnd.toLocaleDateString()}`, Qty: '', Rate: '', Amount: '' },
      { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
      { Item: 'Regular Scans', Detail: '', Qty: standardCount, Rate: `$${RATE_REGULAR.toFixed(2)}`, Amount: `$${(standardCount * RATE_REGULAR).toFixed(2)}` },
      { Item: 'Exceptions', Detail: '', Qty: exceptionCount, Rate: `$${RATE_EXCEPTION.toFixed(2)}`, Amount: `$${(exceptionCount * RATE_EXCEPTION).toFixed(2)}` },
      { Item: '', Detail: '', Qty: '', Rate: '', Amount: '' },
      { Item: 'TOTAL UNITS', Detail: '', Qty: standardCount + exceptionCount, Rate: '', Amount: `$${totalAmount.toFixed(2)}` },
    ];
    const ws1 = XLSX.utils.json_to_sheet(summaryRows);
    ws1['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Billing Summary');

    // Daily breakdown (7 days)
    const dailyRows = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + d);
      const dayStd = Math.round(standardCount / 7) + Math.floor(Math.random() * 80 - 40);
      const dayExc = Math.round(exceptionCount / 7) + Math.floor(Math.random() * 4);
      dailyRows.push({
        Date: day.toLocaleDateString(),
        'Regular Scans': dayStd,
        Exceptions: dayExc,
        'Day Total': dayStd + dayExc,
        Amount: `$${(dayStd * RATE_REGULAR + dayExc * RATE_EXCEPTION).toFixed(2)}`,
      });
    }
    const ws2 = XLSX.utils.json_to_sheet(dailyRows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Daily Breakdown');

    // By Pod
    const podRows = DEMO_PODS.map((p) => {
      const std = Math.round(standardCount / DEMO_PODS.length) + Math.floor(Math.random() * 60 - 30);
      const exc = Math.round(exceptionCount / DEMO_PODS.length) + Math.floor(Math.random() * 3);
      return { Pod: p, 'Regular Scans': std, Exceptions: exc, Total: std + exc };
    });
    const ws3 = XLSX.utils.json_to_sheet(podRows);
    XLSX.utils.book_append_sheet(wb, ws3, 'By Pod');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const tag = weekStart.toISOString().slice(0, 10);
    const fileName = `${DEMO_JOB_NAME}_billing_${tag}.xlsx`;

    await addDoc(collection(db, 'billing-reports'), {
      jobId,
      jobName: DEMO_JOB_NAME,
      weekStart: Timestamp.fromDate(weekStart),
      weekEnd: Timestamp.fromDate(weekEnd),
      standardCount,
      exceptionCount,
      totalUnits: standardCount + exceptionCount,
      totalAmount,
      fileName,
      fileData: base64,
      createdAt: serverTimestamp(),
    });
  }
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

    // Delete demo exceptions in batches
    const excSnap = await getDocs(query(collection(db, 'exceptions'), where('jobId', '==', jobId)));
    for (let i = 0; i < excSnap.docs.length; i += BATCH) {
      const batch = writeBatch(db);
      excSnap.docs.slice(i, i + BATCH).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Delete demo billing reports in batches
    const billingSnap = await getDocs(query(collection(db, 'billing-reports'), where('jobId', '==', jobId)));
    for (let i = 0; i < billingSnap.docs.length; i += BATCH) {
      const batch = writeBatch(db);
      billingSnap.docs.slice(i, i + BATCH).forEach((d) => batch.delete(d.ref));
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
