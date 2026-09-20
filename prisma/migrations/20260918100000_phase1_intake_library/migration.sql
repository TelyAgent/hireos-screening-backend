ALTER TABLE "Material"
ADD COLUMN "text" TEXT NOT NULL DEFAULT '',
ADD COLUMN "segments" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "identityStatus" TEXT NOT NULL DEFAULT 'provisional',
    "ownerId" TEXT NOT NULL,
    "retention" TEXT NOT NULL DEFAULT 'standard-24mo',
    "libraryStatus" TEXT NOT NULL DEFAULT 'available',
    "lastMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResumeVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual_upload',
    "parseStatus" TEXT NOT NULL,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeNote" TEXT,
    CONSTRAINT "ResumeVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CandidateSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT,
    "materialId" TEXT,
    "channel" TEXT NOT NULL,
    "sourceRecordId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "authorizationRef" TEXT,
    CONSTRAINT "CandidateSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LibraryEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LibraryEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "materialId" TEXT,
    "fileName" TEXT NOT NULL,
    "sizeKB" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "candidateId" TEXT,
    "duplicateReviewId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DuplicateCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "existingCandidateId" TEXT,
    "basis" JSONB NOT NULL,
    "resolutionOutcome" TEXT,
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DuplicateCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResumeVersion_materialId_key" ON "ResumeVersion"("materialId");
CREATE UNIQUE INDEX "ResumeVersion_candidateId_version_key" ON "ResumeVersion"("candidateId", "version");
CREATE UNIQUE INDEX "LibraryEntry_candidateId_key" ON "LibraryEntry"("candidateId");
CREATE INDEX "Candidate_workspaceId_createdAt_idx" ON "Candidate"("workspaceId", "createdAt");
CREATE INDEX "Candidate_workspaceId_displayName_idx" ON "Candidate"("workspaceId", "displayName");
CREATE INDEX "ResumeVersion_workspaceId_candidateId_uploadedAt_idx" ON "ResumeVersion"("workspaceId", "candidateId", "uploadedAt");
CREATE INDEX "CandidateSource_workspaceId_receivedAt_idx" ON "CandidateSource"("workspaceId", "receivedAt");
CREATE INDEX "CandidateSource_workspaceId_candidateId_idx" ON "CandidateSource"("workspaceId", "candidateId");
CREATE INDEX "LibraryEntry_workspaceId_createdAt_idx" ON "LibraryEntry"("workspaceId", "createdAt");
CREATE INDEX "ImportBatch_workspaceId_createdAt_idx" ON "ImportBatch"("workspaceId", "createdAt");
CREATE INDEX "ImportItem_workspaceId_createdAt_idx" ON "ImportItem"("workspaceId", "createdAt");
CREATE INDEX "ImportItem_batchId_idx" ON "ImportItem"("batchId");
CREATE INDEX "DuplicateCheck_workspaceId_status_createdAt_idx" ON "DuplicateCheck"("workspaceId", "status", "createdAt");
CREATE INDEX "DuplicateCheck_workspaceId_materialId_idx" ON "DuplicateCheck"("workspaceId", "materialId");

ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CandidateSource" ADD CONSTRAINT "CandidateSource_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CandidateSource" ADD CONSTRAINT "CandidateSource_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LibraryEntry" ADD CONSTRAINT "LibraryEntry_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DuplicateCheck" ADD CONSTRAINT "DuplicateCheck_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DuplicateCheck" ADD CONSTRAINT "DuplicateCheck_existingCandidateId_fkey"
FOREIGN KEY ("existingCandidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
