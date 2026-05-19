-- ============================================================
-- Communications Gateway — WhatsApp Channel Migration
-- Run this entire file in the Supabase SQL Editor
-- ============================================================


-- ============================================================
-- STEP 1: Add whatsapp_credits column to tenants
-- ============================================================
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS whatsapp_credits INT NOT NULL DEFAULT 0
    CHECK (whatsapp_credits >= 0);

COMMENT ON COLUMN tenants.whatsapp_credits IS
  'Integer WhatsApp credit balance. Debited 1-per-message on send. Separate from sms_credits.';

CREATE OR REPLACE FUNCTION fn_validate_whatsapp_credits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.whatsapp_credits < 0 THEN
    RAISE EXCEPTION 'whatsapp_credits cannot be negative (tenant %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_validate_whatsapp_credits ON tenants;
CREATE TRIGGER trg_tenants_validate_whatsapp_credits
  BEFORE UPDATE OF whatsapp_credits ON tenants
  FOR EACH ROW EXECUTE FUNCTION fn_validate_whatsapp_credits();


-- ============================================================
-- STEP 2: Seed WhatsApp platform pricing (if not already set)
-- ============================================================
INSERT INTO platform_pricing (channel, unit_label, price_per_unit, currency)
VALUES ('whatsapp', 'message', 15.0000, 'MWK')
ON CONFLICT (channel, currency) DO NOTHING;


-- ============================================================
-- STEP 3: whatsapp_sessions table
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'initializing'
                      CHECK (status IN ('initializing','pending_qr','ready','disconnected','banned')),
  phone_number      TEXT        NULL,
  display_name      TEXT        NULL,
  last_connected_at TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_tenant_id ON whatsapp_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status    ON whatsapp_sessions(status);

DROP TRIGGER IF EXISTS trg_whatsapp_sessions_updated_at ON whatsapp_sessions;
CREATE TRIGGER trg_whatsapp_sessions_updated_at
  BEFORE UPDATE ON whatsapp_sessions
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;

-- Tenant members can read their own session row
CREATE POLICY whatsapp_sessions_tenant_read ON whatsapp_sessions
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

-- Only service role (admin) can insert/update/delete
CREATE POLICY whatsapp_sessions_service_write ON whatsapp_sessions
  FOR ALL USING (auth.role() = 'service_role');


-- ============================================================
-- STEP 4: Extend orders.order_type to support whatsapp_bundle
-- ============================================================
-- Drop and recreate the CHECK constraint with the new value
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_order_type_check
    CHECK (order_type IN ('bundle','topup','enterprise_assignment','whatsapp_bundle','whatsapp_topup'));

-- Add whatsapp_credits column to orders for WhatsApp-specific fulfillment
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS whatsapp_credits_amount INT NULL
    CHECK (whatsapp_credits_amount IS NULL OR whatsapp_credits_amount > 0);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS whatsapp_price_per_message DECIMAL(10,4) NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS whatsapp_amount_mwk DECIMAL(15,2) NULL;

COMMENT ON COLUMN orders.whatsapp_credits_amount IS
  'WhatsApp credits granted on whatsapp_bundle or whatsapp_topup orders.';


-- ============================================================
-- STEP 5: RPC deduct_whatsapp_credits
-- ============================================================
CREATE OR REPLACE FUNCTION deduct_whatsapp_credits(
  p_tenant_id      UUID,
  p_count          INT,
  p_reference_type TEXT,
  p_reference_id   UUID,
  p_description    TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_current INT;
  v_price   DECIMAL(10,4);
  v_new_bal INT;
BEGIN
  SELECT whatsapp_credits INTO v_current
  FROM tenants WHERE id = p_tenant_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant % not found', p_tenant_id;
  END IF;

  IF v_current < p_count THEN
    RETURN FALSE;
  END IF;

  SELECT price_per_unit INTO v_price
  FROM platform_pricing
  WHERE channel = 'whatsapp' AND currency = 'MWK' AND is_active = true
  LIMIT 1;

  v_new_bal := v_current - p_count;

  UPDATE tenants
  SET whatsapp_credits = v_new_bal, updated_at = NOW()
  WHERE id = p_tenant_id;

  INSERT INTO balance_ledger
    (tenant_id, entry_type, channel, credits_amount,
     amount_mwk, balance_after_mwk,
     reference_type, reference_id, description,
     message_count, cost_per_message_mwk)
  VALUES
    (p_tenant_id, 'debit', 'whatsapp', p_count,
     p_count * COALESCE(v_price, 0),
     v_new_bal,
     p_reference_type, p_reference_id, p_description,
     p_count, v_price);

  RETURN TRUE;
END;
$$;


-- ============================================================
-- STEP 6: RPC fulfill_whatsapp_bundle_order
-- ============================================================
CREATE OR REPLACE FUNCTION fulfill_whatsapp_bundle_order(p_order_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_order   orders%ROWTYPE;
  v_credits INT;
  v_new_bal INT;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  -- Idempotency guard
  IF v_order.status = 'fulfilled' THEN
    RETURN TRUE;
  END IF;

  IF v_order.status NOT IN ('pending','processing') THEN
    RAISE EXCEPTION 'Cannot fulfil order % in status %', p_order_id, v_order.status;
  END IF;

  IF v_order.order_type NOT IN ('whatsapp_bundle','whatsapp_topup') THEN
    RAISE EXCEPTION 'Order % is not a WhatsApp order (type: %)', p_order_id, v_order.order_type;
  END IF;

  v_credits := v_order.whatsapp_credits_amount;

  IF v_credits IS NULL OR v_credits <= 0 THEN
    RAISE EXCEPTION 'Order % has no whatsapp_credits_amount set', p_order_id;
  END IF;

  UPDATE tenants
  SET whatsapp_credits = whatsapp_credits + v_credits, updated_at = NOW()
  WHERE id = v_order.tenant_id;

  SELECT whatsapp_credits INTO v_new_bal FROM tenants WHERE id = v_order.tenant_id;

  INSERT INTO balance_ledger
    (tenant_id, entry_type, channel, credits_amount,
     amount_mwk, balance_after_mwk,
     reference_type, reference_id, description, created_by)
  VALUES
    (v_order.tenant_id, 'credit', 'whatsapp', v_credits,
     COALESCE(v_order.whatsapp_amount_mwk, 0), v_new_bal,
     'order', p_order_id,
     CASE v_order.order_type
       WHEN 'whatsapp_bundle' THEN 'WhatsApp bundle: ' || v_credits || ' credits'
       ELSE 'WhatsApp top-up: ' || v_credits || ' credits @ MWK ' || v_order.whatsapp_price_per_message || '/message'
     END,
     v_order.created_by);

  UPDATE orders
  SET status = 'fulfilled', fulfilled_at = NOW(), updated_at = NOW()
  WHERE id = p_order_id;

  RETURN TRUE;
END;
$$;


-- ============================================================
-- STEP 7: fn_verify_whatsapp_balance_consistency (audit)
-- ============================================================
CREATE OR REPLACE FUNCTION fn_verify_whatsapp_balance_consistency(p_tenant_id UUID)
RETURNS TABLE(
  tenant_id              UUID,
  ledger_net_credits     BIGINT,
  stored_whatsapp_credits INT,
  discrepancy            BIGINT,
  is_consistent          BOOLEAN
) LANGUAGE sql STABLE AS $$
  SELECT
    p_tenant_id,
    SUM(CASE WHEN entry_type IN ('credit','reversal') THEN credits_amount
             ELSE -credits_amount END)::BIGINT AS ledger_net_credits,
    t.whatsapp_credits,
    SUM(CASE WHEN entry_type IN ('credit','reversal') THEN credits_amount
             ELSE -credits_amount END)::BIGINT - t.whatsapp_credits AS discrepancy,
    SUM(CASE WHEN entry_type IN ('credit','reversal') THEN credits_amount
             ELSE -credits_amount END)::BIGINT = t.whatsapp_credits AS is_consistent
  FROM balance_ledger bl
  CROSS JOIN tenants t
  WHERE bl.tenant_id = p_tenant_id
    AND t.id = p_tenant_id
    AND bl.channel = 'whatsapp'
  GROUP BY t.whatsapp_credits;
$$;
