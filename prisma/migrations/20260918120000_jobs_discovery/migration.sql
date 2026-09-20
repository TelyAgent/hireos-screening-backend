CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "employmentType" TEXT NOT NULL,
    "seniority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "jdText" TEXT,
    "criteriaStatus" TEXT NOT NULL DEFAULT 'draft',
    "criteriaVersion" INTEGER NOT NULL DEFAULT 0,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "openings" INTEGER NOT NULL DEFAULT 1,
    "applicantCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobCriteriaVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requirements" JSONB NOT NULL,
    "dimensions" JSONB NOT NULL,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobCriteriaVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobDiscoveryRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" JSONB,
    "jobsScanned" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "jobId" TEXT,
    CONSTRAINT "JobDiscoveryRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreLinkMatchEvaluation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "discoveryRunId" TEXT,
    "profileVersion" INTEGER,
    "criteriaVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION,
    "coverage" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "gaps" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreLinkMatchEvaluation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CandidateJobRecommendation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "prelinkEvaluationId" TEXT NOT NULL,
    "discoveryRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "gaps" JSONB NOT NULL,
    "proposalSource" TEXT NOT NULL DEFAULT 'manual',
    "applicationRef" TEXT,
    "staleReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateJobRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobCriteriaVersion_jobId_version_key"
ON "JobCriteriaVersion"("jobId", "version");
CREATE UNIQUE INDEX "CandidateJobRecommendation_candidateId_jobId_prelinkEvaluationId_key"
ON "CandidateJobRecommendation"("candidateId", "jobId", "prelinkEvaluationId");
CREATE INDEX "Job_workspaceId_status_createdAt_idx" ON "Job"("workspaceId", "status", "createdAt");
CREATE INDEX "Job_workspaceId_title_idx" ON "Job"("workspaceId", "title");
CREATE INDEX "JobCriteriaVersion_workspaceId_jobId_createdAt_idx" ON "JobCriteriaVersion"("workspaceId", "jobId", "createdAt");
CREATE INDEX "JobDiscoveryRun_workspaceId_candidateId_createdAt_idx" ON "JobDiscoveryRun"("workspaceId", "candidateId", "createdAt");
CREATE INDEX "JobDiscoveryRun_workspaceId_status_idx" ON "JobDiscoveryRun"("workspaceId", "status");
CREATE INDEX "PreLinkMatchEvaluation_workspaceId_candidateId_jobId_createdAt_idx" ON "PreLinkMatchEvaluation"("workspaceId", "candidateId", "jobId", "createdAt");
CREATE INDEX "PreLinkMatchEvaluation_workspaceId_jobId_criteriaVersion_idx" ON "PreLinkMatchEvaluation"("workspaceId", "jobId", "criteriaVersion");
CREATE INDEX "CandidateJobRecommendation_workspaceId_candidateId_status_createdAt_idx" ON "CandidateJobRecommendation"("workspaceId", "candidateId", "status", "createdAt");
CREATE INDEX "CandidateJobRecommendation_workspaceId_jobId_status_createdAt_idx" ON "CandidateJobRecommendation"("workspaceId", "jobId", "status", "createdAt");

ALTER TABLE "JobCriteriaVersion" ADD CONSTRAINT "JobCriteriaVersion_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobDiscoveryRun" ADD CONSTRAINT "JobDiscoveryRun_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobDiscoveryRun" ADD CONSTRAINT "JobDiscoveryRun_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PreLinkMatchEvaluation" ADD CONSTRAINT "PreLinkMatchEvaluation_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreLinkMatchEvaluation" ADD CONSTRAINT "PreLinkMatchEvaluation_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreLinkMatchEvaluation" ADD CONSTRAINT "PreLinkMatchEvaluation_discoveryRunId_fkey"
FOREIGN KEY ("discoveryRunId") REFERENCES "JobDiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CandidateJobRecommendation" ADD CONSTRAINT "CandidateJobRecommendation_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CandidateJobRecommendation" ADD CONSTRAINT "CandidateJobRecommendation_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CandidateJobRecommendation" ADD CONSTRAINT "CandidateJobRecommendation_prelinkEvaluationId_fkey"
FOREIGN KEY ("prelinkEvaluationId") REFERENCES "PreLinkMatchEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CandidateJobRecommendation" ADD CONSTRAINT "CandidateJobRecommendation_discoveryRunId_fkey"
FOREIGN KEY ("discoveryRunId") REFERENCES "JobDiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
