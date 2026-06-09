-- CreateTable
CREATE TABLE "SyncState" (
    "collection" TEXT NOT NULL,
    "cursor" TEXT,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "rowsTotal" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("collection")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "mode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "queued" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "dailyTarget" INTEGER,
    "workingHours" DOUBLE PRECISION,
    "pods" TEXT[],
    "floaters" INTEGER,
    "runners" INTEGER,
    "supervisors" INTEGER,
    "poColors" JSONB,
    "poNumbers" JSONB,
    "exceptionColor" TEXT,
    "exceptionNumber" INTEGER,
    "manifestChunked" BOOLEAN NOT NULL DEFAULT false,
    "manifestNumChunks" INTEGER,
    "manifestHasTitles" BOOLEAN,
    "sourceUploadId" TEXT,
    "createdAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "firestoreUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "scannerId" TEXT NOT NULL,
    "isbn" TEXT NOT NULL,
    "poName" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT,
    "capturedTitle" TEXT,
    "matchScore" DOUBLE PRECISION,
    "duplicateOverride" BOOLEAN,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "firestoreUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exception" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "podId" TEXT NOT NULL,
    "scannerId" TEXT,
    "isbn" TEXT,
    "title" TEXT,
    "reason" TEXT NOT NULL,
    "hasPhoto" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "firestoreUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAggregate" (
    "jobId" TEXT NOT NULL,
    "totalScanned" INTEGER NOT NULL DEFAULT 0,
    "totalExceptions" INTEGER NOT NULL DEFAULT 0,
    "totalManual" INTEGER NOT NULL DEFAULT 0,
    "totalAiMatch" INTEGER NOT NULL DEFAULT 0,
    "totalManualExceptions" INTEGER NOT NULL DEFAULT 0,
    "byPO" JSONB,
    "updatedAt" TIMESTAMP(3),
    "recomputedAt" TIMESTAMP(3),
    "firestoreUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAggregate_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "DailySummary" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "totalScans" INTEGER NOT NULL DEFAULT 0,
    "totalExceptions" INTEGER NOT NULL DEFAULT 0,
    "totalManual" INTEGER NOT NULL DEFAULT 0,
    "totalAiMatch" INTEGER NOT NULL DEFAULT 0,
    "byPO" JSONB,
    "firestoreUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_active_idx" ON "Job"("active");

-- CreateIndex
CREATE INDEX "Job_closedAt_idx" ON "Job"("closedAt");

-- CreateIndex
CREATE INDEX "Scan_jobId_timestamp_idx" ON "Scan"("jobId", "timestamp");

-- CreateIndex
CREATE INDEX "Scan_jobId_poName_timestamp_idx" ON "Scan"("jobId", "poName", "timestamp");

-- CreateIndex
CREATE INDEX "Scan_jobId_type_timestamp_idx" ON "Scan"("jobId", "type", "timestamp");

-- CreateIndex
CREATE INDEX "Scan_jobId_source_timestamp_idx" ON "Scan"("jobId", "source", "timestamp");

-- CreateIndex
CREATE INDEX "Scan_jobId_scannerId_timestamp_idx" ON "Scan"("jobId", "scannerId", "timestamp");

-- CreateIndex
CREATE INDEX "Scan_isbn_idx" ON "Scan"("isbn");

-- CreateIndex
CREATE INDEX "Exception_jobId_timestamp_idx" ON "Exception"("jobId", "timestamp");

-- CreateIndex
CREATE INDEX "DailySummary_jobId_date_idx" ON "DailySummary"("jobId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailySummary_jobId_date_key" ON "DailySummary"("jobId", "date");

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAggregate" ADD CONSTRAINT "JobAggregate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
