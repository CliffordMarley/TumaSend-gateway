-- ============================================================
-- Sender ID Whitelisting & API Key Management — Schema Migration
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. First-time whitelist agreement tracking on tenants
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS whitelist_agreement_signed_at    TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS whitelist_agreement_document_url TEXT        NULL;

-- 2. Internal admin review notes on sender_ids
--    Separate from rejection_reason (which is shown to the tenant)
ALTER TABLE sender_ids
  ADD COLUMN IF NOT EXISTS review_notes TEXT NULL;

-- 3. One active API key per tenant per sender ID
--    Prevents a tenant from generating multiple active keys for the same sender ID
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_one_active_per_sender
  ON api_keys (tenant_id, sender_id_id)
  WHERE status = 'active';

-- 4. Ensure updated_at auto-triggers exist on sender_ids and api_keys
--    fn_auto_updated_at() is already defined by the billing migration
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sender_ids_updated_at'
  ) THEN
    CREATE TRIGGER trg_sender_ids_updated_at
      BEFORE UPDATE ON sender_ids
      FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_api_keys_updated_at'
  ) THEN
    CREATE TRIGGER trg_api_keys_updated_at
      BEFORE UPDATE ON api_keys
      FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();
  END IF;
END $$;

-- 5. View: per-tenant usage of each global sender ID
--    Allows admins to track which merchants use which global sender
--    and how many messages each has sent through it
CREATE OR REPLACE VIEW v_global_sender_usage AS
SELECT
  si.id                                            AS sender_id_id,
  si.sender_id                                     AS sender_name,
  si.display_name,
  ak.tenant_id,
  t.name                                           AS tenant_name,
  ak.id                                            AS api_key_id,
  ak.name                                          AS api_key_name,
  ak.status                                        AS api_key_status,
  ak.last_used_at,
  ak.total_requests,
  COUNT(mb.id)                                     AS total_batches,
  COALESCE(SUM(mb.total_recipients), 0)::BIGINT    AS total_messages_sent
FROM sender_ids si
JOIN api_keys ak
  ON ak.sender_id_id = si.id
JOIN tenants t
  ON t.id = ak.tenant_id
LEFT JOIN message_batches mb
  ON mb.sender_id_id = si.id
  AND mb.tenant_id   = ak.tenant_id
WHERE si.is_global = true
GROUP BY
  si.id, si.sender_id, si.display_name,
  ak.tenant_id, t.name, ak.id, ak.name,
  ak.status, ak.last_used_at, ak.total_requests;

-- ============================================================
-- VERIFICATION
-- ============================================================

-- Check new tenant columns
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'tenants' AND column_name IN ('whitelist_agreement_signed_at','whitelist_agreement_document_url');

-- Check review_notes on sender_ids
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'sender_ids' AND column_name = 'review_notes';

-- Check unique index
-- SELECT indexname FROM pg_indexes WHERE tablename = 'api_keys' AND indexname = 'idx_api_keys_one_active_per_sender';

-- Check view
-- SELECT * FROM v_global_sender_usage LIMIT 5;
