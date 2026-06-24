-- Phase 9 (P9-002): alert notification channels + delivery log.

-- CreateTable
CREATE TABLE "alert_channel_config" (
    "id" UUID NOT NULL,
    "channel_type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_channel_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_delivery_log" (
    "id" BIGSERIAL NOT NULL,
    "channel_type" TEXT NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,

    CONSTRAINT "alert_delivery_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_delivery_log_attempted_at_idx" ON "alert_delivery_log"("attempted_at" DESC);
