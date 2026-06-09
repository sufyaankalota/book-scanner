-- CreateTable
CREATE TABLE "Presence" (
    "podId" TEXT NOT NULL,
    "scanners" TEXT[],
    "operator" TEXT,
    "status" TEXT,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "onBreak" BOOLEAN NOT NULL DEFAULT false,
    "breakSecondsRemaining" INTEGER,
    "lastSeen" TIMESTAMP(3),
    "message" TEXT,
    "notes" TEXT,
    "firestoreUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Presence_pkey" PRIMARY KEY ("podId")
);

-- CreateIndex
CREATE INDEX "Presence_lastSeen_idx" ON "Presence"("lastSeen");

-- CreateIndex
CREATE INDEX "Presence_online_idx" ON "Presence"("online");
