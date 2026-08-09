-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "SourceKey" AS ENUM ('ebay', 'keepa_amazon', 'shopgoodwill', 'walmart_clearance', 'target_clearance', 'estatesales');

-- CreateEnum
CREATE TYPE "CompSource" AS ENUM ('ebay_sold', 'keepa');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('new', 'alerted', 'claimed', 'dismissed', 'purchased', 'sold');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('websocket', 'discord', 'pushover');

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "key" "SourceKey" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "upc" TEXT,
    "isbn" TEXT,
    "asin" TEXT,
    "category" TEXT,
    "condition" TEXT,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceUrl" TEXT NOT NULL,
    "currentPrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "location" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Valuation" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "estimatedResale" DECIMAL(12,2) NOT NULL,
    "resaleLow" DECIMAL(12,2) NOT NULL,
    "resaleHigh" DECIMAL(12,2) NOT NULL,
    "soldCompsCount" INTEGER NOT NULL DEFAULT 0,
    "sellThroughRate" DOUBLE PRECISION,
    "compSource" "CompSource" NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Valuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "valuationId" TEXT NOT NULL,
    "buyPrice" DECIMAL(12,2) NOT NULL,
    "estFees" DECIMAL(12,2) NOT NULL,
    "estShipping" DECIMAL(12,2) NOT NULL,
    "netProfit" DECIMAL(12,2) NOT NULL,
    "roiPct" DOUBLE PRECISION NOT NULL,
    "score" INTEGER NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'new',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled rule',
    "minProfit" DECIMAL(12,2),
    "minRoi" DOUBLE PRECISION,
    "maxBuyPrice" DECIMAL(12,2),
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "localOnly" BOOLEAN NOT NULL DEFAULT false,
    "channels" "AlertChannel"[] DEFAULT ARRAY['websocket']::"AlertChannel"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "channel" "AlertChannel" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlipLedger" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purchasePrice" DECIMAL(12,2) NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "salePrice" DECIMAL(12,2),
    "fees" DECIMAL(12,2),
    "shipping" DECIMAL(12,2),
    "soldAt" TIMESTAMP(3),
    "realizedProfit" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlipLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_key_key" ON "Source"("key");

-- CreateIndex
CREATE INDEX "Item_category_idx" ON "Item"("category");

-- CreateIndex
CREATE INDEX "Item_lastCheckedAt_idx" ON "Item"("lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Item_sourceId_externalId_key" ON "Item"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "Valuation_itemId_computedAt_idx" ON "Valuation"("itemId", "computedAt");

-- CreateIndex
CREATE INDEX "Deal_status_score_idx" ON "Deal"("status", "score");

-- CreateIndex
CREATE INDEX "Deal_createdAt_id_idx" ON "Deal"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Deal_userId_idx" ON "Deal"("userId");

-- CreateIndex
CREATE INDEX "AlertRule_userId_idx" ON "AlertRule"("userId");

-- CreateIndex
CREATE INDEX "AlertEvent_ruleId_idx" ON "AlertEvent"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertEvent_dealId_ruleId_channel_key" ON "AlertEvent"("dealId", "ruleId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "FlipLedger_dealId_key" ON "FlipLedger"("dealId");

-- CreateIndex
CREATE INDEX "FlipLedger_userId_soldAt_idx" ON "FlipLedger"("userId", "soldAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Valuation" ADD CONSTRAINT "Valuation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "Valuation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlipLedger" ADD CONSTRAINT "FlipLedger_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlipLedger" ADD CONSTRAINT "FlipLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
