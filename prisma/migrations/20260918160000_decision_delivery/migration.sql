CREATE TABLE "ScreeningDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "evaluationId" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "overrideAi" BOOLEAN NOT NULL DEFAULT false,
    "nextStepTarget" TEXT NOT NULL DEFAULT 'record_only',
    "exceptionRef" TEXT,
    "policyRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DecisionExceptionApproval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionExceptionApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HandoffPackage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "decisionId" TEXT,
    "kind" TEXT NOT NULL,
    "transport" TEXT,
    "targetLabel" TEXT NOT NULL,
    "reviewStatus" TEXT,
    "status" TEXT NOT NULL DEFAULT 'package_ready',
    "manifest" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandoffPackage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "transport" TEXT,
    "targetLabel" TEXT NOT NULL,
    "history" JSONB NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalRef" TEXT,
    "receivedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "detail" JSONB,
    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryAttempt_packageId_attemptNo_key" ON "DeliveryAttempt"("packageId", "attemptNo");
CREATE UNIQUE INDEX "Receipt_deliveryAttemptId_key" ON "Receipt"("deliveryAttemptId");
CREATE INDEX "ScreeningDecision_workspaceId_applicationId_createdAt_idx" ON "ScreeningDecision"("workspaceId", "applicationId", "createdAt");
CREATE INDEX "ScreeningDecision_workspaceId_jobId_status_idx" ON "ScreeningDecision"("workspaceId", "jobId", "status");
CREATE INDEX "DecisionExceptionApproval_workspaceId_decisionId_idx" ON "DecisionExceptionApproval"("workspaceId", "decisionId");
CREATE INDEX "HandoffPackage_workspaceId_applicationId_createdAt_idx" ON "HandoffPackage"("workspaceId", "applicationId", "createdAt");
CREATE INDEX "HandoffPackage_workspaceId_status_createdAt_idx" ON "HandoffPackage"("workspaceId", "status", "createdAt");
CREATE INDEX "DeliveryAttempt_workspaceId_status_createdAt_idx" ON "DeliveryAttempt"("workspaceId", "status", "createdAt");

ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreeningDecision" ADD CONSTRAINT "ScreeningDecision_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "ScreeningEvaluation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DecisionExceptionApproval" ADD CONSTRAINT "DecisionExceptionApproval_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ScreeningDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoffPackage" ADD CONSTRAINT "HandoffPackage_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoffPackage" ADD CONSTRAINT "HandoffPackage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoffPackage" ADD CONSTRAINT "HandoffPackage_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "ScreeningDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "HandoffPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_deliveryAttemptId_fkey" FOREIGN KEY ("deliveryAttemptId") REFERENCES "DeliveryAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
