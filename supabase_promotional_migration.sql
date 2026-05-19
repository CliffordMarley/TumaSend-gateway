-- ============================================================
-- Promotional Migration — Signup Bonus Credits
-- Run this in the Supabase SQL Editor ONCE.
-- Safe to re-run: CREATE OR REPLACE on the function.
-- ============================================================

-- ============================================================
-- grant_signup_bonus(p_tenant_id)
--
-- Grants a new tenant 10 free SMS credits and 10 free WhatsApp
-- credits as a welcome incentive. Both increments are logged in
-- balance_ledger as 'credit' entries at MWK 0 so the audit
-- trail is complete.
--
-- Called from the application layer immediately after a tenant
-- is created (POST /api/v1/auth/business).
--
-- Returns the post-bonus balances so the API can surface them
-- in the signup response without an extra DB round-trip.
-- ============================================================
CREATE OR REPLACE FUNCTION grant_signup_bonus(p_tenant_id UUID)
RETURNS TABLE(sms_credits INT, whatsapp_credits INT)
LANGUAGE plpgsql AS $$
DECLARE
  v_sms_bal INT;
  v_wa_bal  INT;
BEGIN
  -- ── SMS credits ────────────────────────────────────────────
  UPDATE tenants
  SET sms_credits = sms_credits + 10,
      updated_at  = NOW()
  WHERE id = p_tenant_id;

  SELECT t.sms_credits INTO v_sms_bal
  FROM tenants t WHERE t.id = p_tenant_id;

  INSERT INTO balance_ledger
    (tenant_id, entry_type, channel, credits_amount,
     amount_mwk, balance_after_mwk,
     reference_type, reference_id, description,
     message_count, cost_per_message_mwk)
  VALUES
    (p_tenant_id, 'credit', 'sms', 10,
     0, v_sms_bal,
     'signup_bonus', p_tenant_id,
     'Welcome bonus — 10 free SMS credits',
     10, 0);

  -- ── WhatsApp credits ───────────────────────────────────────
  UPDATE tenants
  SET whatsapp_credits = whatsapp_credits + 10,
      updated_at       = NOW()
  WHERE id = p_tenant_id;

  SELECT t.whatsapp_credits INTO v_wa_bal
  FROM tenants t WHERE t.id = p_tenant_id;

  INSERT INTO balance_ledger
    (tenant_id, entry_type, channel, credits_amount,
     amount_mwk, balance_after_mwk,
     reference_type, reference_id, description,
     message_count, cost_per_message_mwk)
  VALUES
    (p_tenant_id, 'credit', 'whatsapp', 10,
     0, v_wa_bal,
     'signup_bonus', p_tenant_id,
     'Welcome bonus — 10 free WhatsApp credits',
     10, 0);

  RETURN QUERY SELECT v_sms_bal, v_wa_bal;
END;
$$;
