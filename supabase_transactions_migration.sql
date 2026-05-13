-- =============================================================
-- PayChangu Transaction Enrichment Migration
-- Adds full request/response payload capture and authorization
-- detail columns to the transactions table.
-- =============================================================

-- Full body sent to PayChangu /payment/checkout on order creation
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS checkout_request_body  JSONB NULL;

-- Complete raw webhook payload received from PayChangu
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS webhook_payload         JSONB NULL;

-- Payment channel extracted from authorization (e.g. 'mobile_money', 'card', 'bank_transfer')
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS payment_channel         TEXT  NULL;

-- Full authorization object from webhook (channel-specific details)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS authorization_details   JSONB NULL;

-- PayChangu's charge_id from the webhook payload
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS paychangu_charge_id     TEXT  NULL;

-- Full PayChangu hosted checkout URL (stored for reuse if payment needs to be retried)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS checkout_url            TEXT  NULL;

-- Index for fast idempotency check by charge_id (webhook deduplication)
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_paychangu_charge_id
  ON transactions(paychangu_charge_id)
  WHERE paychangu_charge_id IS NOT NULL;
