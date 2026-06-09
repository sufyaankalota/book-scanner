import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { logger } from '../lib/logger';
import { config } from '../config';
import type { DedupClaim } from './store';
import * as store from './store';

// Pods connect to /ws/dedup?jobId=...&apiKey=... and subscribe to one job at
// a time. The server pushes a `claimed` event for every successful claim so
// every pod can update its local UI without polling.
//
// Wire protocol (JSON over text frames):
//   client -> server:
//     { type: 'subscribe', jobId }                 (in addition to query param)
//     { type: 'claim',   jobId, barcode, podId, scannerId, scanId? }
//     { type: 'release', jobId, barcode }
//     { type: 'inspect', jobId, barcode }
//     { type: 'ping' }
//   server -> client:
//     { type: 'hello',   ts }
//     { type: 'claimed', jobId, barcode, claim }            (broadcast)
//     { type: 'released',jobId, barcode }                   (broadcast)
//     { type: 'claim_result', jobId, barcode, result }      (reply to caller)
//     { type: 'inspect_result', jobId, barcode, claim }     (reply to caller)
//     { type: 'pong', ts }
//     { type: 'error', message }

type ClientState = {
  ws: WebSocket;
  jobId: string;
  alive: boolean;
};

const clients = new Map<WebSocket, ClientState>();
const byJob = new Map<string, Set<WebSocket>>();

function subscribe(ws: WebSocket, jobId: string): void {
  const state = clients.get(ws);
  if (!state) return;
  if (state.jobId === jobId) return;
  if (state.jobId) {
    byJob.get(state.jobId)?.delete(ws);
  }
  state.jobId = jobId;
  let set = byJob.get(jobId);
  if (!set) {
    set = new Set();
    byJob.set(jobId, set);
  }
  set.add(ws);
}

function unregister(ws: WebSocket): void {
  const state = clients.get(ws);
  if (!state) return;
  if (state.jobId) {
    const set = byJob.get(state.jobId);
    set?.delete(ws);
    if (set && set.size === 0) byJob.delete(state.jobId);
  }
  clients.delete(ws);
}

function broadcast(jobId: string, payload: unknown, exclude?: WebSocket): void {
  const set = byJob.get(jobId);
  if (!set) return;
  const json = JSON.stringify(payload);
  for (const ws of set) {
    if (ws === exclude) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function authorize(req: IncomingMessage): { ok: boolean; jobId?: string } {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const apiKey = url.searchParams.get('apiKey') ?? req.headers['x-api-key'];
  const required = config.dedupApiKey;
  if (required) {
    if (apiKey !== required) return { ok: false };
  } else if (config.isProd) {
    return { ok: false };
  }
  const jobId = url.searchParams.get('jobId') ?? undefined;
  return { ok: true, jobId };
}

async function handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    send(ws, { type: 'error', message: 'invalid_json' });
    return;
  }
  const type = String(msg.type ?? '');

  if (type === 'ping') {
    send(ws, { type: 'pong', ts: Date.now() });
    return;
  }

  if (type === 'subscribe') {
    const jobId = String(msg.jobId ?? '');
    if (!jobId) {
      send(ws, { type: 'error', message: 'jobId_required' });
      return;
    }
    subscribe(ws, jobId);
    send(ws, { type: 'subscribed', jobId });
    return;
  }

  if (type === 'claim') {
    const jobId = String(msg.jobId ?? '');
    const barcode = String(msg.barcode ?? '');
    const podId = String(msg.podId ?? '');
    const scannerId = String(msg.scannerId ?? '');
    const scanId = msg.scanId ? String(msg.scanId) : undefined;
    if (!jobId || !barcode || !podId || !scannerId) {
      send(ws, { type: 'error', message: 'missing_fields' });
      return;
    }
    const claimPayload: DedupClaim = { podId, scannerId, scanId, timestamp: new Date().toISOString() };
    try {
      const result = await store.claim(jobId, barcode, claimPayload);
      send(ws, { type: 'claim_result', jobId, barcode, result });
      if (result.claimed) {
        broadcast(jobId, { type: 'claimed', jobId, barcode, claim: claimPayload }, ws);
      }
    } catch (err) {
      logger.error({ err }, 'ws claim failed');
      send(ws, { type: 'error', message: 'claim_failed' });
    }
    return;
  }

  if (type === 'release') {
    const jobId = String(msg.jobId ?? '');
    const barcode = String(msg.barcode ?? '');
    if (!jobId || !barcode) {
      send(ws, { type: 'error', message: 'missing_fields' });
      return;
    }
    try {
      const removed = await store.release(jobId, barcode);
      send(ws, { type: 'release_result', jobId, barcode, removed });
      if (removed) broadcast(jobId, { type: 'released', jobId, barcode }, ws);
    } catch (err) {
      logger.error({ err }, 'ws release failed');
      send(ws, { type: 'error', message: 'release_failed' });
    }
    return;
  }

  if (type === 'inspect') {
    const jobId = String(msg.jobId ?? '');
    const barcode = String(msg.barcode ?? '');
    if (!jobId || !barcode) {
      send(ws, { type: 'error', message: 'missing_fields' });
      return;
    }
    try {
      const claim = await store.inspect(jobId, barcode);
      send(ws, { type: 'inspect_result', jobId, barcode, claim });
    } catch (err) {
      logger.error({ err }, 'ws inspect failed');
      send(ws, { type: 'error', message: 'inspect_failed' });
    }
    return;
  }

  send(ws, { type: 'error', message: 'unknown_type' });
}

export type HubHandle = {
  wss: WebSocketServer;
  broadcastClaimed: (jobId: string, barcode: string, claim: DedupClaim) => void;
  broadcastReleased: (jobId: string, barcode: string) => void;
  stop: () => Promise<void>;
};

export function attachDedupHub(server: HttpServer): HubHandle {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/dedup') return;
    const auth = authorize(req);
    if (!auth.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const state: ClientState = { ws, jobId: '', alive: true };
      clients.set(ws, state);
      if (auth.jobId) subscribe(ws, auth.jobId);

      ws.on('pong', () => {
        const s = clients.get(ws);
        if (s) s.alive = true;
      });
      ws.on('message', (data) => {
        handleMessage(ws, data as Buffer).catch((err) =>
          logger.error({ err }, 'ws message handler crashed'),
        );
      });
      ws.on('close', () => unregister(ws));
      ws.on('error', (err) => logger.warn({ err }, 'ws error'));

      send(ws, { type: 'hello', ts: Date.now(), jobId: state.jobId || null });
    });
  });

  // Heartbeat: drop pods whose socket went away without a close frame.
  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients.entries()) {
      if (!state.alive) {
        ws.terminate();
        unregister(ws);
        continue;
      }
      state.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
        unregister(ws);
      }
    }
  }, 30_000).unref();

  return {
    wss,
    broadcastClaimed: (jobId, barcode, claim) =>
      broadcast(jobId, { type: 'claimed', jobId, barcode, claim }),
    broadcastReleased: (jobId, barcode) =>
      broadcast(jobId, { type: 'released', jobId, barcode }),
    stop: async () => {
      clearInterval(heartbeat);
      for (const ws of clients.keys()) ws.close();
      clients.clear();
      byJob.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
