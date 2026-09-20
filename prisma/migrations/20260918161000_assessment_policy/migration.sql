ALTER TABLE "Job" ADD COLUMN "assessmentRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "assessmentStatus" TEXT NOT NULL DEFAULT 'not_administered';
