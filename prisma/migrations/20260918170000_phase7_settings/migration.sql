CREATE TABLE "SourceConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastReadAt" TIMESTAMP(3),
    "scope" TEXT NOT NULL,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SourceConnection_workspaceId_kind_status_idx"
ON "SourceConnection"("workspaceId", "kind", "status");

CREATE INDEX "SourceConnection_workspaceId_updatedAt_idx"
ON "SourceConnection"("workspaceId", "updatedAt");

CREATE TABLE "WorkspaceSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceSetting_workspaceId_kind_key_key"
ON "WorkspaceSetting"("workspaceId", "kind", "key");

CREATE INDEX "WorkspaceSetting_workspaceId_kind_updatedAt_idx"
ON "WorkspaceSetting"("workspaceId", "kind", "updatedAt");
