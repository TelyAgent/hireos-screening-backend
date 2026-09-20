-- AlterTable
ALTER TABLE "DuplicateCheck" ADD COLUMN     "confidence" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "normalizedTextHash" TEXT,
ALTER COLUMN "text" DROP DEFAULT,
ALTER COLUMN "segments" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Material_workspaceId_normalizedTextHash_idx" ON "Material"("workspaceId", "normalizedTextHash");

-- AddForeignKey
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateJobRecommendation" ADD CONSTRAINT "CandidateJobRecommendation_applicationRef_fkey" FOREIGN KEY ("applicationRef") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CandidateJobRecommendation_candidateId_jobId_prelinkEvaluationI" RENAME TO "CandidateJobRecommendation_candidateId_jobId_prelinkEvaluat_key";

-- RenameIndex
ALTER INDEX "CandidateJobRecommendation_workspaceId_candidateId_status_creat" RENAME TO "CandidateJobRecommendation_workspaceId_candidateId_status_c_idx";

-- RenameIndex
ALTER INDEX "CandidateJobRecommendation_workspaceId_jobId_status_createdAt_i" RENAME TO "CandidateJobRecommendation_workspaceId_jobId_status_created_idx";

-- RenameIndex
ALTER INDEX "PreLinkMatchEvaluation_workspaceId_candidateId_jobId_createdAt_" RENAME TO "PreLinkMatchEvaluation_workspaceId_candidateId_jobId_create_idx";
