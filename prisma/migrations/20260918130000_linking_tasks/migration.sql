CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL DEFAULT 'cycle-1',
    "status" TEXT NOT NULL DEFAULT 'active',
    "screeningStatus" TEXT NOT NULL DEFAULT 'not_started',
    "origin" TEXT NOT NULL DEFAULT 'sourced',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedBy" TEXT NOT NULL,
    "linkReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LinkDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "recommendationId" TEXT,
    "applicationId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "inputManifest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LinkDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HumanTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceModule" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subjectLabel" TEXT NOT NULL,
    "requiredAction" TEXT NOT NULL,
    "completionRule" JSONB NOT NULL,
    "candidateId" TEXT,
    "jobId" TEXT,
    "applicationId" TEXT,
    "recommendationId" TEXT,
    "assigneeId" TEXT,
    "queue" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "needsRefresh" BOOLEAN NOT NULL DEFAULT false,
    "linkRoute" TEXT NOT NULL,
    "waitingReason" TEXT,
    "resumeAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "completionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "HumanTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Application_workspaceId_candidateId_jobId_cycleId_key"
ON "Application"("workspaceId", "candidateId", "jobId", "cycleId");
CREATE INDEX "Application_workspaceId_jobId_status_idx" ON "Application"("workspaceId", "jobId", "status");
CREATE INDEX "Application_workspaceId_candidateId_status_idx" ON "Application"("workspaceId", "candidateId", "status");
CREATE INDEX "LinkDecision_workspaceId_candidateId_jobId_createdAt_idx" ON "LinkDecision"("workspaceId", "candidateId", "jobId", "createdAt");
CREATE INDEX "LinkDecision_workspaceId_recommendationId_idx" ON "LinkDecision"("workspaceId", "recommendationId");
CREATE INDEX "HumanTask_workspaceId_status_createdAt_idx" ON "HumanTask"("workspaceId", "status", "createdAt");
CREATE INDEX "HumanTask_workspaceId_assigneeId_status_idx" ON "HumanTask"("workspaceId", "assigneeId", "status");
CREATE INDEX "HumanTask_workspaceId_applicationId_idx" ON "HumanTask"("workspaceId", "applicationId");

ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkDecision" ADD CONSTRAINT "LinkDecision_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkDecision" ADD CONSTRAINT "LinkDecision_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkDecision" ADD CONSTRAINT "LinkDecision_recommendationId_fkey"
FOREIGN KEY ("recommendationId") REFERENCES "CandidateJobRecommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LinkDecision" ADD CONSTRAINT "LinkDecision_applicationId_fkey"
FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HumanTask" ADD CONSTRAINT "HumanTask_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HumanTask" ADD CONSTRAINT "HumanTask_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HumanTask" ADD CONSTRAINT "HumanTask_applicationId_fkey"
FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
