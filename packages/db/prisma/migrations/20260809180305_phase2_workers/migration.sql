-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "bidsCount" INTEGER,
ADD COLUMN     "endsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DECIMAL(12,2) NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerCheckpoint" (
    "id" TEXT NOT NULL,
    "sourceKey" "SourceKey" NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedSearch_sourceId_enabled_idx" ON "SavedSearch"("sourceId", "enabled");

-- CreateIndex
CREATE INDEX "PriceSnapshot_itemId_capturedAt_idx" ON "PriceSnapshot"("itemId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerCheckpoint_sourceKey_key_key" ON "WorkerCheckpoint"("sourceKey", "key");

-- CreateIndex
CREATE INDEX "Item_endsAt_idx" ON "Item"("endsAt");

-- AddForeignKey
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
