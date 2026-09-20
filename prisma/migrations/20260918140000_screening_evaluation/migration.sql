CREATE TABLE "ScreeningSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'initial',
    "status" TEXT NOT NULL DEFAULT 'open',
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "ScreeningSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScreeningEvaluation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "evaluationMode" TEXT NOT NULL DEFAULT 'manual',
    "aiStatus" TEXT NOT NULL DEFAULT 'not_requested',
    "inputManifest" JSONB NOT NULL,
    "eligibilityStatus" TEXT,
    "eligibilityResults" JSONB NOT NULL,
    "overallScore" DOUBLE PRECISION,
    "coverage" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "evaluationStatus" TEXT NOT NULL,
    "strengths" JSONB NOT NULL,
    "missingInformation" JSONB NOT NULL,
    "recommendation" JSONB,
    "modelVersion" TEXT,
    "freshness" TEXT NOT NULL DEFAULT 'current',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningEvaluation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DimensionScore" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "supportingRefs" JSONB NOT NULL,
    "counterRefs" JSONB NOT NULL,
    CONSTRAINT "DimensionScore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "materialId" TEXT,
    "kind" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "locator" JSONB NOT NULL,
    "verification" TEXT NOT NULL DEFAULT 'unverified',
    "confidence" DOUBLE PRECISION,
    "availability" TEXT NOT NULL DEFAULT 'available',
    "restrictedReason" TEXT,
    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScreeningConcern" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "basis" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "requirementIds" JSONB NOT NULL,
    "verificationItemIds" JSONB NOT NULL,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    CONSTRAINT "ScreeningConcern_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VerificationItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "targetStage" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "acceptance" TEXT NOT NULL,
    "ownerId" TEXT,
    "outcome" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "VerificationItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HumanAssessment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "dimensionName" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "byActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HumanAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScreeningEvaluation_applicationId_version_key" ON "ScreeningEvaluation"("applicationId", "version");
CREATE UNIQUE INDEX "DimensionScore_evaluationId_dimensionId_key" ON "DimensionScore"("evaluationId", "dimensionId");
CREATE UNIQUE INDEX "HumanAssessment_evaluationId_dimensionId_key" ON "HumanAssessment"("evaluationId", "dimensionId");
CREATE INDEX "ScreeningSession_workspaceId_applicationId_createdAt_idx" ON "ScreeningSession"("workspaceId", "applicationId", "createdAt");
CREATE INDEX "ScreeningEvaluation_workspaceId_applicationId_createdAt_idx" ON "ScreeningEvaluation"("workspaceId", "applicationId", "createdAt");
CREATE INDEX "ScreeningEvaluation_workspaceId_freshness_idx" ON "ScreeningEvaluation"("workspaceId", "freshness");
CREATE INDEX "DimensionScore_workspaceId_evaluationId_idx" ON "DimensionScore"("workspaceId", "evaluationId");
CREATE INDEX "EvidenceItem_workspaceId_evaluationId_idx" ON "EvidenceItem"("workspaceId", "evaluationId");
CREATE INDEX "EvidenceItem_workspaceId_candidateId_idx" ON "EvidenceItem"("workspaceId", "candidateId");
CREATE INDEX "ScreeningConcern_workspaceId_applicationId_status_idx" ON "ScreeningConcern"("workspaceId", "applicationId", "status");
CREATE INDEX "ScreeningConcern_workspaceId_evaluationId_idx" ON "ScreeningConcern"("workspaceId", "evaluationId");
CREATE INDEX "VerificationItem_workspaceId_applicationId_status_idx" ON "VerificationItem"("workspaceId", "applicationId", "status");
CREATE INDEX "HumanAssessment_workspaceId_applicationId_idx" ON "HumanAssessment"("workspaceId", "applicationId");

ALTER TABLE "ScreeningSession" ADD CONSTRAINT "ScreeningSession_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreeningEvaluation" ADD CONSTRAINT "ScreeningEvaluation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreeningEvaluation" ADD CONSTRAINT "ScreeningEvaluation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ScreeningSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DimensionScore" ADD CONSTRAINT "DimensionScore_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ScreeningEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ScreeningEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreeningConcern" ADD CONSTRAINT "ScreeningConcern_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreeningConcern" ADD CONSTRAINT "ScreeningConcern_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ScreeningEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationItem" ADD CONSTRAINT "VerificationItem_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationItem" ADD CONSTRAINT "VerificationItem_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ScreeningEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HumanAssessment" ADD CONSTRAINT "HumanAssessment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HumanAssessment" ADD CONSTRAINT "HumanAssessment_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ScreeningEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
