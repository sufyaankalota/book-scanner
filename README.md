# Book Scanner — Warehouse ISBN Scanning System

Real-time book scanning web app for warehouse operations. Pods scan ISBNs via barcode scanners, sorted by PO in Multi-PO mode, with a live supervisor dashboard.

## Tech Stack

- **Frontend**: React 18 + Vite
- **Database**: Firebase Firestore (real-time, offline persistence)
- **Hosting**: Vercel
- **Export**: XLSX (SheetJS)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Firebase

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Firestore Database** (start in test mode for dev)
3. Copy your web app config
4. Create a `.env` file from the example:

```bash
cp .env.example .env
```

Fill in your Firebase config values:

```
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

### 3. Set Up Firestore Indexes

Create these composite indexes in the Firebase Console (Firestore > Indexes):

| Collection | Fields | Order |
|---|---|---|
| `scans` | `jobId`, `podId`, `timestamp` | Asc, Asc, Desc |
| `scans` | `jobId`, `timestamp` | Asc, Desc |
| `exceptions` | `jobId`, `podId`, `timestamp` | Asc, Asc, Desc |
| `exceptions` | `jobId`, `timestamp` | Asc, Desc |
| `jobs` | `meta.active` | Asc |

### 4. Run Locally

```bash
npm run dev
```

Open `http://localhost:5173`

## Routes

| Route | Purpose |
|---|---|
| `/setup` | Create/manage jobs, upload manifests, configure pods |
| `/pod?id=A` | Scanning page for Pod A (change `id` for each pod) |
| `/dashboard` | Supervisor live dashboard with all pods |

## Deploy to Vercel

### Option A: Vercel CLI

```bash
npm i -g vercel
vercel
```

When prompted, set environment variables for all `VITE_FIREBASE_*` keys.

### Option B: Vercel Web UI

1. Push repo to GitHub
2. Import project at [vercel.com/new](https://vercel.com/new)
3. Framework: **Vite**
4. Add all `VITE_FIREBASE_*` environment variables in project settings
5. Deploy

The `vercel.json` file handles SPA routing automatically.

## How It Works

### Job Setup (`/setup`)
1. Enter a Job Name / PO label
2. Choose **Single PO** or **Multi-PO** mode
3. In Multi-PO mode: upload a CSV/XLSX manifest with `ISBN` and `PO` columns
4. Assign colors to each PO (up to 6)
5. Set daily target and configure pod IDs
6. Click **Activate Job**

### Scanning (`/pod?id=X`)
1. Enter a Scanner ID / operator name
2. Start scanning — the barcode scanner types into a hidden input
3. **Single PO**: green flash on valid scan
4. **Multi-PO**: full-screen PO color flash (e.g., "RED GAYLORD")
5. **Not in manifest**: orange flash → exceptions pallet
6. **Invalid barcode**: red flash + error beep → rescan
7. Use the **LOG EXCEPTION** button for damaged items, no barcode, etc.
8. Register a second scanner with the "Register Scanner 2" button

### Dashboard (`/dashboard`)
- Live view of all pods: scan counts, pace, exceptions
- Green/Yellow/Red pace indicators (configurable target)
- **Export Today**: download today's scans as XLSX
- **Export All**: download all scans for the entire job
- In Multi-PO mode: also generates per-PO XLSX files

## Firestore Structure

```
/jobs/{jobId}/
  { meta: { name, mode, dailyTarget, workingHours, pods[], active, createdAt } }
  { poColors: { [poName]: hex } }
  /manifest/{isbn} → { poName }

/scans/{scanId}/
  { jobId, podId, scannerId, isbn, poName, timestamp, type: "standard"|"exception" }

/exceptions/{exceptionId}/
  { jobId, podId, scannerId, isbn (nullable), reason, timestamp }
```

## Firestore Security Rules (Development)

For development/testing only — open access:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

> **⚠️ For production**: restrict access by IP or deploy behind a VPN. This app has no authentication — Firestore rules should be locked down at the network level.

## Manifest File Format

CSV or XLSX with two columns:

| ISBN | PO |
|---|---|
| 9780134685991 | PO-001 |
| 9780596517748 | PO-002 |
| 9780134685991 | PO-003 |

- First row must be a header containing "ISBN" and "PO" (case-insensitive)
- Duplicate ISBNs: first occurrence wins (assigned to first PO uploaded)
- Supports `.csv`, `.xlsx`, `.xls`
