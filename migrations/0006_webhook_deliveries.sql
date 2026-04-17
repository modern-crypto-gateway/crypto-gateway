-- Webhook dead-letter queue. Every composed merchant webhook is persisted here
-- BEFORE the dispatcher runs, so a process crash between compose and HTTP
-- response can be recovered by the retry sweeper. Rows transition:
--   pending  -> delivered  (dispatcher returned { delivered: true })
--   pending  -> dead       (too many sweep retries, permanent 4xx, or SSRF refusal)
--   pending  -> pending    (retryable failure; next_attempt_at bumped)
--
-- The dispatcher itself retries in-memory (exponential backoff, ~4 attempts).
-- The sweeper is the outer safety net: if the whole in-memory retry chain
-- fails, OR the worker is killed mid-dispatch, the next scheduled-jobs tick
-- picks the row back up past next_attempt_at.
--
-- idempotency_key is UNIQUE: composeWebhook produces stable keys of the shape
-- "<event>:<entity-id>:<status>", so the same domain event firing twice
-- (bus replay, poll re-detection) is deduped at insert time. The subscriber
-- treats a duplicate-insert error as "already queued" and moves on.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                   TEXT PRIMARY KEY,
  merchant_id          TEXT NOT NULL REFERENCES merchants(id),
  event_type           TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL UNIQUE,
  payload_json         TEXT NOT NULL,
  target_url           TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending','delivered','dead')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_status_code     INTEGER,
  last_error           TEXT,
  next_attempt_at      INTEGER NOT NULL,
  delivered_at         INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Sweeper query: WHERE status='pending' AND next_attempt_at <= now ORDER BY next_attempt_at.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next
  ON webhook_deliveries(status, next_attempt_at);

-- Admin list-by-merchant / list-by-status UI queries.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_merchant
  ON webhook_deliveries(merchant_id, created_at DESC);
