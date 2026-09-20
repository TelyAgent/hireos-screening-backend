ALTER TABLE "Material"
  ADD COLUMN "securityStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "extractionStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'manual_upload',
  ADD COLUMN "sourceRef" TEXT,
  ADD COLUMN "sourceVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ImportBatch"
  ADD COLUMN "operationId" TEXT;

ALTER TABLE "ImportItem"
  ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'processing',
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "errorMessage" TEXT,
  ADD COLUMN "retryable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "duplicateOfMaterialId" TEXT,
  ADD COLUMN "businessConsumeStatus" TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE "HumanTask"
  ADD COLUMN "materialId" TEXT,
  ADD COLUMN "duplicateReviewId" TEXT;

CREATE TABLE "IngestionOperation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "idempotencyKey" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "IngestionOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IngestionAttempt" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "importItemId" TEXT,
  "workspaceId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "IngestionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "operationId" TEXT,
  "importBatchId" TEXT,
  "importItemId" TEXT,
  "materialId" TEXT,
  "candidateId" TEXT,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "stage" TEXT,
  "status" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestionOperation_workspaceId_idempotencyKey_key"
  ON "IngestionOperation"("workspaceId", "idempotencyKey");
CREATE INDEX "IngestionOperation_workspaceId_createdAt_idx"
  ON "IngestionOperation"("workspaceId", "createdAt");
CREATE INDEX "IngestionOperation_workspaceId_status_createdAt_idx"
  ON "IngestionOperation"("workspaceId", "status", "createdAt");
CREATE INDEX "IngestionAttempt_workspaceId_operationId_startedAt_idx"
  ON "IngestionAttempt"("workspaceId", "operationId", "startedAt");
CREATE INDEX "IngestionAttempt_workspaceId_importItemId_startedAt_idx"
  ON "IngestionAttempt"("workspaceId", "importItemId", "startedAt");
CREATE INDEX "ActivityEvent_workspaceId_createdAt_idx"
  ON "ActivityEvent"("workspaceId", "createdAt");
CREATE INDEX "ActivityEvent_workspaceId_importBatchId_createdAt_idx"
  ON "ActivityEvent"("workspaceId", "importBatchId", "createdAt");
CREATE INDEX "ActivityEvent_workspaceId_importItemId_createdAt_idx"
  ON "ActivityEvent"("workspaceId", "importItemId", "createdAt");
CREATE INDEX "ActivityEvent_workspaceId_materialId_createdAt_idx"
  ON "ActivityEvent"("workspaceId", "materialId", "createdAt");
CREATE UNIQUE INDEX "ImportBatch_operationId_key"
  ON "ImportBatch"("operationId");
CREATE INDEX "ImportItem_workspaceId_status_createdAt_idx"
  ON "ImportItem"("workspaceId", "status", "createdAt");

CREATE UNIQUE INDEX "Material_workspaceId_hash_key"
  ON "Material"("workspaceId", "hash");

ALTER TABLE "ImportBatch"
  ADD CONSTRAINT "ImportBatch_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "IngestionOperation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IngestionAttempt"
  ADD CONSTRAINT "IngestionAttempt_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "IngestionOperation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityEvent"
  ADD CONSTRAINT "ActivityEvent_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "IngestionOperation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
