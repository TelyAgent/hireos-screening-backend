-- AlterTable
ALTER TABLE "Material" DROP COLUMN "storageKey",
ADD COLUMN     "coreMaterialId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Material_coreMaterialId_key" ON "Material"("coreMaterialId");
