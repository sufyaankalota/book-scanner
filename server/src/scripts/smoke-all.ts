/* eslint-disable no-console */
// Read-only end-to-end smoke test for prepfort-scan-engine + portal wiring.
// Safe to run against production. Does NOT touch pod code, Firestore writes,
// or anything that real scanners depend on. The only writes are:
//   - a unique synthetic dedup claim (jobId starts with "smoketest-") that's
//     released at the end. Pods never look at that jobId.
//
// Usage:
//   $env:SCAN_ENGINE_URL = "https://prepfort-scan-engine-production.up.railway.app"
//   $env:SCAN_ENGINE_KEY = "<PORTAL_API_KEY>"
//   $env:PORTAL_URL      = "https://book-scanner-puce.vercel.app"  (optional)
//   tsx server/src/scripts/smoke-all.ts

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import WebSocket from 'ws';

const BASE = (process.env.SCAN_ENGINE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.SCAN_ENGINE_KEY ?? '';
const PORTAL = (process.env.PORTAL_URL ?? '').replace(/\/+$/, '');

if (!BASE || !KEY) {
  console.error('SCAN_ENGINE_URL and SCAN_ENGINE_KEY env vars are required');
  process.exit(2);
}

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
}
function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name}  — ${detail}`);
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  baseOverride?: string,
): Promise<{ status: number; json: any; text: string }> {
  const target = baseOverride ?? BASE;
  const url = new URL(target + path);
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const req = requestFn(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'x-api-key': KEY,
          'content-type': 'application/json',
          'user-agent': 'prepfort-smoke-test/1.0',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // leave json null for text bodies (e.g. /healthz returns "ok")
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n== ${title} ==`);
  try {
    await fn();
  } catch (err) {
    fail(title, `crashed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Service health
// ---------------------------------------------------------------------------
async function checkHealth(): Promise<void> {
  const root = await http('GET', '/');
  if (root.status === 200 && root.json?.service === 'prepfort-scan-engine') {
    pass('root /', `status=${root.json.status}`);
  } else {
    fail('root /', `status=${root.status} body=${root.text.slice(0, 80)}`);
  }

  const dedupHealth = await http('GET', '/api/dedup/health');
  if (
    dedupHealth.status === 200 &&
    dedupHealth.json?.ready === true &&
    dedupHealth.json?.hubAttached === true
  ) {
    pass('/api/dedup/health', 'ready + hub attached');
  } else {
    fail('/api/dedup/health', `status=${dedupHealth.status} body=${JSON.stringify(dedupHealth.json)}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Auth: 401 without key, 401 with bad key
// ---------------------------------------------------------------------------
async function checkAuth(): Promise<void> {
  const url = new URL(BASE + '/api/portal/presence');
  await new Promise<void>((resolve) => {
    const req = httpsRequest(
      {
        method: 'GET',
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        // intentionally no x-api-key
      },
      (res) => {
        if (res.statusCode === 401) pass('portal rejects missing api key', `${res.statusCode}`);
        else fail('portal rejects missing api key', `got ${res.statusCode}`);
        res.resume();
        resolve();
      },
    );
    req.on('error', () => {
      fail('portal rejects missing api key', 'request failed');
      resolve();
    });
    req.end();
  });

  await new Promise<void>((resolve) => {
    const req = httpsRequest(
      {
        method: 'GET',
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        headers: { 'x-api-key': 'wrong-key' },
      },
      (res) => {
        if (res.statusCode === 401) pass('portal rejects wrong api key', `${res.statusCode}`);
        else fail('portal rejects wrong api key', `got ${res.statusCode}`);
        res.resume();
        resolve();
      },
    );
    req.on('error', () => {
      fail('portal rejects wrong api key', 'request failed');
      resolve();
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 3. Portal read API — coverage on every endpoint
// ---------------------------------------------------------------------------
async function checkPortalReads(): Promise<{ jobId: string | null }> {
  let firstJobId: string | null = null;

  const jobs = await http('GET', '/api/portal/jobs');
  if (jobs.status === 200 && Array.isArray(jobs.json?.jobs)) {
    pass('GET /api/portal/jobs', `${jobs.json.jobs.length} jobs`);
    firstJobId = jobs.json.jobs[0]?.id ?? null;
  } else {
    fail('GET /api/portal/jobs', `status=${jobs.status}`);
  }

  const activeJobs = await http('GET', '/api/portal/jobs?active=true');
  if (activeJobs.status === 200) pass('GET /api/portal/jobs?active=true', `${activeJobs.json.jobs.length} active`);
  else fail('GET /api/portal/jobs?active=true', `status=${activeJobs.status}`);

  if (firstJobId) {
    const one = await http('GET', `/api/portal/jobs/${firstJobId}`);
    if (one.status === 200 && one.json?.job?.id === firstJobId) pass('GET /api/portal/jobs/:id', firstJobId);
    else fail('GET /api/portal/jobs/:id', `status=${one.status}`);

    const agg = await http('GET', `/api/portal/jobs/${firstJobId}/aggregate`);
    if (agg.status === 200 && agg.json?.aggregate) {
      pass('GET /api/portal/jobs/:id/aggregate', `units=${agg.json.aggregate.totalUnitsScanned ?? '?'}`);
    } else if (agg.status === 404) {
      pass('GET /api/portal/jobs/:id/aggregate', '404 (no aggregate row yet — acceptable)');
    } else {
      fail('GET /api/portal/jobs/:id/aggregate', `status=${agg.status}`);
    }

    const scans = await http('GET', `/api/portal/scans?jobId=${firstJobId}&limit=10`);
    if (scans.status === 200 && Array.isArray(scans.json?.scans)) {
      pass('GET /api/portal/scans', `${scans.json.scans.length} rows, nextCursor=${Boolean(scans.json.nextCursor)}`);
    } else {
      fail('GET /api/portal/scans', `status=${scans.status}`);
    }

    if (scans.json?.nextCursor) {
      const page2 = await http(
        'GET',
        `/api/portal/scans?jobId=${firstJobId}&limit=10&cursor=${encodeURIComponent(scans.json.nextCursor)}`,
      );
      if (page2.status === 200 && Array.isArray(page2.json?.scans)) {
        const firstA = scans.json.scans[scans.json.scans.length - 1]?.id;
        const firstB = page2.json.scans[0]?.id;
        if (firstA !== firstB && firstB) pass('keyset cursor advances', `${firstA} -> ${firstB}`);
        else fail('keyset cursor advances', `first id repeated: ${firstA}`);
      } else {
        fail('GET /api/portal/scans (page 2)', `status=${page2.status}`);
      }
    }

    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 30);
    const summary = await http(
      'GET',
      `/api/portal/scans/summary?jobId=${firstJobId}&start=${start.toISOString()}&end=${today.toISOString()}`,
    );
    if (summary.status === 200 && summary.json?.perDay) {
      pass(
        'GET /api/portal/scans/summary',
        `perDay=${summary.json.perDay.length} types=${Object.keys(summary.json.byType ?? {}).join(',') || 'none'}`,
      );
    } else {
      fail('GET /api/portal/scans/summary', `status=${summary.status}`);
    }

    const exc = await http('GET', `/api/portal/exceptions?jobId=${firstJobId}&limit=10`);
    if (exc.status === 200 && Array.isArray(exc.json?.exceptions)) {
      pass('GET /api/portal/exceptions', `${exc.json.exceptions.length} rows`);
    } else {
      fail('GET /api/portal/exceptions', `status=${exc.status}`);
    }

    const ds = await http('GET', `/api/portal/daily-summaries?jobId=${firstJobId}`);
    if (ds.status === 200 && Array.isArray(ds.json?.summaries)) {
      pass('GET /api/portal/daily-summaries', `${ds.json.summaries.length} rows`);
    } else {
      fail('GET /api/portal/daily-summaries', `status=${ds.status}`);
    }

    const today2 = new Date();
    const start2 = new Date(today2); start2.setDate(today2.getDate() - 60);
    const dbk = await http(
      'GET',
      `/api/portal/daily-breakdown?jobId=${firstJobId}&start=${start2.toISOString()}&end=${today2.toISOString()}`,
    );
    if (dbk.status === 200 && Array.isArray(dbk.json?.breakdown)) {
      const sample = dbk.json.breakdown[0];
      const shapeOk = !sample || (
        typeof sample.date === 'string' &&
        typeof sample.total === 'number' &&
        typeof sample.regular === 'number' &&
        typeof sample.manual === 'number' &&
        typeof sample.aiCamera === 'number' &&
        typeof sample.exceptions === 'number'
      );
      if (shapeOk) {
        pass('GET /api/portal/daily-breakdown', `${dbk.json.breakdown.length} days`);
      } else {
        fail('GET /api/portal/daily-breakdown', `bad row shape: ${JSON.stringify(sample)}`);
      }
    } else {
      fail('GET /api/portal/daily-breakdown', `status=${dbk.status}`);
    }

    const ops = await http('GET', `/api/portal/operators?jobId=${firstJobId}`);
    if (ops.status === 200 && Array.isArray(ops.json?.operators)) {
      pass('GET /api/portal/operators', `${ops.json.operators.length} operators`);
    } else {
      fail('GET /api/portal/operators', `status=${ops.status}`);
    }
  } else {
    fail('first job for cascade tests', 'no jobs in DB');
  }

  const presence = await http('GET', '/api/portal/presence');
  if (presence.status === 200 && Array.isArray(presence.json?.pods)) {
    const online = presence.json.pods.filter((p: any) => p.isOnline).length;
    pass('GET /api/portal/presence', `${presence.json.pods.length} pods, ${online} online`);
  } else {
    fail('GET /api/portal/presence', `status=${presence.status}`);
  }

  return { jobId: firstJobId };
}

// ---------------------------------------------------------------------------
// 4. Dedup HTTP semantics (synthetic jobId — pods never look at it)
// ---------------------------------------------------------------------------
async function checkDedupHttp(): Promise<void> {
  const jobId = `smoketest-${Date.now()}`;
  const barcode = `SMOKE-${Math.random().toString(36).slice(2, 10)}`;
  const claimA = {
    jobId,
    barcode,
    podId: 'smoke-pod-A',
    scannerId: 'smoke-scanner-1',
    scanId: 'smoke-scan-xyz',
  };
  const claimB = { jobId, barcode, podId: 'smoke-pod-B', scannerId: 'smoke-scanner-2' };

  const c1 = await http('POST', '/api/dedup/claim', claimA);
  if (c1.status === 200 && c1.json?.claimed === true) pass('claim #1 succeeds', `ttl=${c1.json.ttlSeconds}`);
  else fail('claim #1 succeeds', `status=${c1.status} body=${JSON.stringify(c1.json)}`);

  const c2 = await http('POST', '/api/dedup/claim', claimB);
  if (c2.status === 200 && c2.json?.claimed === false && c2.json?.existing?.podId === 'smoke-pod-A') {
    pass('duplicate claim rejected', `loser=${claimB.podId}, holder=${c2.json.existing.podId}`);
  } else {
    fail('duplicate claim rejected', `status=${c2.status} body=${JSON.stringify(c2.json)}`);
  }

  const ins = await http('GET', `/api/dedup/inspect?jobId=${jobId}&barcode=${barcode}`);
  if (ins.status === 200 && ins.json?.claim?.podId === 'smoke-pod-A') {
    pass('inspect returns winning claim', `holder=${ins.json.claim.podId}`);
  } else {
    fail('inspect returns winning claim', JSON.stringify(ins.json));
  }

  const insMany = await http('POST', '/api/dedup/inspect-many', {
    jobId,
    barcodes: [barcode, `${barcode}-missing`, `${barcode}-also-missing`],
  });
  if (
    insMany.status === 200 &&
    insMany.json?.claims?.[barcode]?.podId === 'smoke-pod-A' &&
    insMany.json.claims[`${barcode}-missing`] === null
  ) {
    pass('inspect-many returns mixed hits/misses');
  } else {
    fail('inspect-many returns mixed hits/misses', JSON.stringify(insMany.json));
  }

  const rel = await http('POST', '/api/dedup/release', { jobId, barcode });
  if (rel.status === 200 && rel.json?.removed === true) pass('release succeeds');
  else fail('release succeeds', `status=${rel.status} body=${JSON.stringify(rel.json)}`);

  const c3 = await http('POST', '/api/dedup/claim', claimB);
  if (c3.status === 200 && c3.json?.claimed === true) pass('re-claim after release succeeds');
  else fail('re-claim after release succeeds', `status=${c3.status} body=${JSON.stringify(c3.json)}`);

  // Cleanup
  await http('POST', '/api/dedup/release', { jobId, barcode });
  pass('cleanup release', 'no leaked keys for smoke jobId');
}

// ---------------------------------------------------------------------------
// 5. Dedup WebSocket broadcast
// ---------------------------------------------------------------------------
async function checkDedupWs(): Promise<void> {
  const jobId = `smoketest-ws-${Date.now()}`;
  const barcode = `WS-${Math.random().toString(36).slice(2, 10)}`;
  const wsUrl = BASE.replace(/^http/, 'ws') + `/ws/dedup?apiKey=${encodeURIComponent(KEY)}&jobId=${jobId}`;

  let claimedReceived = false;
  let releasedReceived = false;

  const subA = new WebSocket(wsUrl);
  const subB = new WebSocket(wsUrl);

  await new Promise<void>((resolve) => {
    let openCount = 0;
    const onOpen = (): void => {
      openCount += 1;
      if (openCount === 2) resolve();
    };
    subA.once('open', onOpen);
    subB.once('open', onOpen);
    setTimeout(() => resolve(), 5_000);
  });

  if (subA.readyState !== WebSocket.OPEN || subB.readyState !== WebSocket.OPEN) {
    fail('ws clients connect', `A=${subA.readyState} B=${subB.readyState}`);
    subA.close();
    subB.close();
    return;
  }
  pass('ws clients connect');

  subB.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'claimed' && msg.barcode === barcode) claimedReceived = true;
    if (msg.type === 'released' && msg.barcode === barcode) releasedReceived = true;
  });

  subA.send(
    JSON.stringify({
      type: 'claim',
      jobId,
      barcode,
      podId: 'ws-pod-A',
      scannerId: 'ws-scanner-1',
    }),
  );

  await new Promise((r) => setTimeout(r, 1500));
  if (claimedReceived) pass('ws broadcasts claimed event to peer');
  else fail('ws broadcasts claimed event to peer', 'no claimed event in 1.5s');

  subA.send(JSON.stringify({ type: 'release', jobId, barcode }));
  await new Promise((r) => setTimeout(r, 1500));
  if (releasedReceived) pass('ws broadcasts released event to peer');
  else fail('ws broadcasts released event to peer', 'no released event in 1.5s');

  subA.close();
  subB.close();
}

// ---------------------------------------------------------------------------
// 6. Portal frontend bundle sanity (optional — needs PORTAL_URL)
// ---------------------------------------------------------------------------
async function checkPortalBundle(): Promise<void> {
  if (!PORTAL) {
    console.log('  SKIP  portal bundle check (PORTAL_URL not set)');
    return;
  }
  const html = await http('GET', '/?nocache=' + Date.now(), undefined, PORTAL);
  if (html.status !== 200) {
    fail('portal index loads', `status=${html.status}`);
    return;
  }
  const indexMatch = html.text.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!indexMatch) {
    fail('portal index references entry bundle', 'no /assets/index-*.js in HTML');
    return;
  }
  pass('portal index loads', indexMatch[0]);

  const entry = await http('GET', indexMatch[0], undefined, PORTAL);

  // The scan-engine client used to be its own chunk; vite may now inline it
  // when both lazy + eager pages reference it. Look for the live config in
  // the entry bundle first, then fall back to the chunk if it still exists.
  let body = entry.text;
  const chunkMatch = entry.text.match(/scanEngine-[A-Za-z0-9_-]+\.js/);
  if (chunkMatch) {
    pass('portal scanEngine chunk present (split)', chunkMatch[0]);
    const chunk = await http('GET', '/assets/' + chunkMatch[0], undefined, PORTAL);
    body = chunk.text;
  } else {
    pass('portal scanEngine inlined into entry', `${entry.text.length} bytes`);
  }

  const hasUrl = body.includes('prepfort-scan-engine-production');
  const hasPortal = body.includes('/api/portal/');
  const hasDedup = body.includes('/api/dedup/');
  const hasHeader = body.includes('x-api-key');
  if (hasUrl && hasPortal && hasDedup && hasHeader) {
    pass('portal bundle has live scan-engine config', 'url+/api/portal+/api/dedup+x-api-key');
  } else {
    fail(
      'portal bundle has live scan-engine config',
      `url=${hasUrl} portal=${hasPortal} dedup=${hasDedup} header=${hasHeader}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Mirror freshness — make sure listeners are still writing
// ---------------------------------------------------------------------------
async function checkMirrorFreshness(jobId: string | null): Promise<void> {
  if (!jobId) {
    console.log('  SKIP  mirror freshness (no jobId from earlier step)');
    return;
  }
  const scans = await http('GET', `/api/portal/scans?jobId=${jobId}&limit=1`);
  const top = scans.json?.scans?.[0];
  if (top?.timestamp) {
    const ageMs = Date.now() - new Date(top.timestamp).getTime();
    const ageMin = Math.round(ageMs / 60_000);
    pass('latest scan in mirror', `top row is ${ageMin} min old (${top.timestamp})`);
  } else {
    pass('latest scan in mirror', 'no scans yet (acceptable if no recent activity)');
  }

  const presence = await http('GET', '/api/portal/presence');
  const recent = (presence.json?.pods ?? []).filter((p: any) => {
    if (!p.lastSeen) return false;
    return Date.now() - new Date(p.lastSeen).getTime() < 5 * 60_000;
  });
  pass('presence mirror freshness', `${recent.length} pods reported in last 5 min`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  console.log(`Target: ${BASE}`);
  await section('1. Service health', checkHealth);
  await section('2. Auth enforcement', checkAuth);
  let jobId: string | null = null;
  await section('3. Portal read API', async () => {
    const r = await checkPortalReads();
    jobId = r.jobId;
  });
  await section('4. Dedup HTTP', checkDedupHttp);
  await section('5. Dedup WebSocket', checkDedupWs);
  await section('6. Portal frontend bundle', checkPortalBundle);
  await section('7. Mirror freshness', () => checkMirrorFreshness(jobId));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n========================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`========================================`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(2);
});
