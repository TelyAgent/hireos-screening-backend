ALTER TABLE "ProcessingJob"
ADD COLUMN "candidateId" TEXT,
ADD COLUMN "resumeVersionId" TEXT;

CREATE TABLE "CandidateProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "resumeVersionId" TEXT,
    "version" INTEGER NOT NULL,
    "parseStatus" TEXT NOT NULL DEFAULT 'pending',
    "dataStatus" TEXT NOT NULL DEFAULT 'partial',
    "parserVersion" TEXT,
    "displayName" TEXT NOT NULL,
    "sourceEntries" JSONB NOT NULL,
    "resumeVersionRefs" JSONB NOT NULL,
    "employmentHistory" JSONB NOT NULL,
    "skills" JSONB NOT NULL,
    "education" JSONB NOT NULL,
    "certifications" JSONB NOT NULL,
    "projects" JSONB NOT NULL,
    "location" JSONB NOT NULL,
    "workAuthorization" JSONB NOT NULL,
    "languages" JSONB NOT NULL,
    "compensationExpectation" JSONB,
    "missingFields" JSONB NOT NULL,
    "corrections" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CandidateProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CandidateProfile_candidateId_version_key"
ON "CandidateProfile"("candidateId", "version");
CREATE INDEX "CandidateProfile_workspaceId_candidateId_createdAt_idx"
ON "CandidateProfile"("workspaceId", "candidateId", "createdAt");
CREATE INDEX "CandidateProfile_workspaceId_parseStatus_idx"
ON "CandidateProfile"("workspaceId", "parseStatus");
CREATE INDEX "ProcessingJob_candidateId_idx" ON "ProcessingJob"("candidateId");
CREATE INDEX "ProcessingJob_resumeVersionId_idx" ON "ProcessingJob"("resumeVersionId");

ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_resumeVersionId_fkey"
FOREIGN KEY ("resumeVersionId") REFERENCES "ResumeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CandidateProfile" ADD CONSTRAINT "CandidateProfile_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CandidateProfile" ADD CONSTRAINT "CandidateProfile_resumeVersionId_fkey"
FOREIGN KEY ("resumeVersionId") REFERENCES "ResumeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
