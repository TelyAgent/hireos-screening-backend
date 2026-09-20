CREATE TABLE "ComparisonSet" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "collaborators" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComparisonSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComparisonMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "comparisonSetId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComparisonMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComparisonSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "comparisonSetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "freshness" TEXT NOT NULL DEFAULT 'current',
    "note" TEXT NOT NULL,
    "changesSinceLast" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComparisonSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RankingSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "comparisonSetId" TEXT,
    "comparisonSnapshotId" TEXT NOT NULL,
    "criteriaVersion" INTEGER NOT NULL,
    "baselineKey" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RankingSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComparisonAnnotation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "comparisonSetId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComparisonAnnotation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComparisonMember_comparisonSetId_applicationId_key" ON "ComparisonMember"("comparisonSetId", "applicationId");
CREATE UNIQUE INDEX "ComparisonSnapshot_comparisonSetId_version_key" ON "ComparisonSnapshot"("comparisonSetId", "version");
CREATE UNIQUE INDEX "RankingSnapshot_comparisonSnapshotId_key" ON "RankingSnapshot"("comparisonSnapshotId");
CREATE INDEX "ComparisonSet_workspaceId_jobId_updatedAt_idx" ON "ComparisonSet"("workspaceId", "jobId", "updatedAt");
CREATE INDEX "ComparisonMember_workspaceId_applicationId_idx" ON "ComparisonMember"("workspaceId", "applicationId");
CREATE INDEX "ComparisonSnapshot_workspaceId_comparisonSetId_generatedAt_idx" ON "ComparisonSnapshot"("workspaceId", "comparisonSetId", "generatedAt");
CREATE INDEX "RankingSnapshot_workspaceId_jobId_criteriaVersion_createdAt_idx" ON "RankingSnapshot"("workspaceId", "jobId", "criteriaVersion", "createdAt");
CREATE INDEX "ComparisonAnnotation_workspaceId_comparisonSetId_createdAt_idx" ON "ComparisonAnnotation"("workspaceId", "comparisonSetId", "createdAt");

ALTER TABLE "ComparisonSet" ADD CONSTRAINT "ComparisonSet_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComparisonMember" ADD CONSTRAINT "ComparisonMember_comparisonSetId_fkey" FOREIGN KEY ("comparisonSetId") REFERENCES "ComparisonSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComparisonMember" ADD CONSTRAINT "ComparisonMember_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComparisonSnapshot" ADD CONSTRAINT "ComparisonSnapshot_comparisonSetId_fkey" FOREIGN KEY ("comparisonSetId") REFERENCES "ComparisonSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RankingSnapshot" ADD CONSTRAINT "RankingSnapshot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RankingSnapshot" ADD CONSTRAINT "RankingSnapshot_comparisonSetId_fkey" FOREIGN KEY ("comparisonSetId") REFERENCES "ComparisonSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RankingSnapshot" ADD CONSTRAINT "RankingSnapshot_comparisonSnapshotId_fkey" FOREIGN KEY ("comparisonSnapshotId") REFERENCES "ComparisonSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComparisonAnnotation" ADD CONSTRAINT "ComparisonAnnotation_comparisonSetId_fkey" FOREIGN KEY ("comparisonSetId") REFERENCES "ComparisonSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
