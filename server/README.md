# book-scanner / server (prepfort-scan-engine)

Real-time backend for the Prepfort book-scanner system. Lives in the same repo as the pod + portal frontend so the WebSocket protocol types in `../shared/` can be imported by both client and server with a single source of truth. Deploys independently to its own Railway project (`prepfort-scan-engine`) with `rootDirectory=server`. Frontend (Vercel) and Firebase Functions are unaffected by changes here.

Owns:

- **Cross-pod dedup** — Redis-backed set of scanned ISBNs per job, fanned out over WebSocket so every pod's local scan handler can reject duplicates against the cluster-wide view in zero-network microseconds.
- **Firestore → Postgres mirror** — single server-side listener that copies scan + exception writes from Firestore into Postgres in near-real-time, so reads come from a query-shaped database instead of the live transactional store.
- **Customer portal read API** — thin REST/SSE layer over the Postgres mirror. The customer portal frontend stops talking to Firestore directly and reads from here, eliminating the cache-wedge class of bugs and ~1 MB of JS bundle weight.

## Why a separate service (but same repo)

`book-scanner` (Firestore-backed React app + Cloud Functions) handles the live scan path and stays as-is — Firestore is the right tool for the per-pod single-doc-write workload. `prepfort-sales-os` handles internal sales/CRM/finance and stays as-is. This service is the missing read+coordination layer. Independent Railway deploy + independent rollback + isolated runtime blast radius. Pods scan even if this service is down (local Set still works; dedup just degrades to per-pod until reconnect).

Same monorepo because the pod client and the dedup server share a wire protocol — keeping types in `../shared/` and atomic deploys for client+server changes outweighs the operational separation argument.

## Stack

TypeScript · Express · Prisma · Postgres · Redis · ws (native WebSocket).
Deploy: Railway, auto on push to `main`.

## Layout

```
src/
  server.ts          # Express bootstrap + WebSocket upgrade
  config.ts          # Env vars (single source of truth)
  api/
    health.ts        # Liveness + readiness
    (more later)
  lib/
    prisma.ts
    redis.ts
    logger.ts
prisma/
  schema.prisma
```

## Local dev

```powershell
cd server
npm install
cp .env.example .env   # fill in DATABASE_URL + REDIS_URL
npm run prisma:generate
npm run dev
```

## Deploy

Railway service `prepfort-scan-engine` is configured with **Root Directory = `server`** and auto-deploys from `main`. Migrations run as a release step (`npm run prisma:migrate` before `npm start`).

Frontend (Vercel) and Firebase Functions ignore this directory entirely:
- Vercel root is the repo root → builds `src/` only.
- Firebase deploys from `functions/` only.
- This service builds from `server/` only.

