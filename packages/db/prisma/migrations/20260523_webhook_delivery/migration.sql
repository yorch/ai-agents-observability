CREATE TABLE "webhook_deliveries" (
    "id"            BIGSERIAL PRIMARY KEY,
    "delivery_id"   TEXT NOT NULL UNIQUE,
    "event_type"    TEXT NOT NULL,
    "action"        TEXT,
    "repo"          TEXT,
    "received_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "processed_at"  TIMESTAMPTZ(6),
    "status"        TEXT NOT NULL,
    "error_text"    TEXT
);
CREATE INDEX "webhook_deliveries_event_type_received_at_idx" ON "webhook_deliveries"("event_type", "received_at" DESC);
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries"("received_at" DESC);
