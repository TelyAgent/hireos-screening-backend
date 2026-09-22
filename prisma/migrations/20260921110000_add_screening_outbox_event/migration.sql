-- CreateTable
CREATE TABLE "ScreeningOutboxEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    CONSTRAINT "ScreeningOutboxEvent_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ScreeningOutboxEvent_workspaceId_status_createdAt_idx" ON "ScreeningOutboxEvent"("workspaceId", "status", "createdAt");
