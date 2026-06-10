// Thin client for the prepfort-scan-engine /api/portal/* read API.
// The portal still writes directly to Firestore; this module is read-only.
// Falls back gracefully (returns null) if the env vars aren't set so the
// portal keeps booting in dev environments that haven't been wired yet.

const BASE = (import.meta.env.VITE_SCAN_ENGINE_URL || '').replace(/\/+$/, '');
const KEY = import.meta.env.VITE_SCAN_ENGINE_KEY || '';

export const isScanEngineConfigured = Boolean(BASE && KEY);

async function get(path, params) {
  if (!isScanEngineConfigured) {
    throw new Error('scan-engine not configured');
  }
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const res = await fetch(`${BASE}${path}${qs}`, {
    headers: { 'x-api-key': KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`scan-engine ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Endpoints (mirrors of /api/portal/*)
// ---------------------------------------------------------------------------

async function post(path, body) {
  if (!isScanEngineConfigured) {
    throw new Error('scan-engine not configured');
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`scan-engine ${path} ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

export const scanEngine = {
  listJobs: ({ active } = {}) => get('/api/portal/jobs', { active }),
  getJob: (jobId) => get(`/api/portal/jobs/${encodeURIComponent(jobId)}`),
  getAggregate: (jobId) => get(`/api/portal/jobs/${encodeURIComponent(jobId)}/aggregate`),
  listScans: (params) => get('/api/portal/scans', params),
  scanSummary: ({ jobId, start, end }) =>
    get('/api/portal/scans/summary', { jobId, start, end }),
  listExceptions: (params) => get('/api/portal/exceptions', params),
  dailySummaries: ({ jobId, start, end }) =>
    get('/api/portal/daily-summaries', { jobId, start, end }),
  presence: () => get('/api/portal/presence'),

  // Cross-pod dedup. `claim` is atomic — exactly one pod wins per (jobId,
  // barcode) until TTL expires (server default 24h). A claimed:false response
  // includes the winning pod's identity so the UI can show a useful message.
  claim: ({ jobId, barcode, podId, scannerId, scanId, ttlSeconds }) =>
    post('/api/dedup/claim', { jobId, barcode, podId, scannerId, scanId, ttlSeconds }),
  release: ({ jobId, barcode }) => post('/api/dedup/release', { jobId, barcode }),
  inspect: ({ jobId, barcode }) => get('/api/dedup/inspect', { jobId, barcode }),
  inspectMany: ({ jobId, barcodes }) => post('/api/dedup/inspect-many', { jobId, barcodes }),
};
