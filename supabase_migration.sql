-- ============================================================
-- Communications Gateway — Billing & Subscription Overhaul
-- Run this entire file in the Supabase SQL Editor
-- Steps 1a → 1m (execute in order, all in one shot)
-- ============================================================


-- ============================================================
-- STEP 1a: Shared updated_at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION fn_auto_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


-- ============================================================
-- STEP 1b: platform_pricing table
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_pricing (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel         TEXT          NOT NULL CHECK (channel IN ('sms','whatsapp','email','ussd')),
  unit_label      TEXT          NOT NULL DEFAULT 'message',
  price_per_unit  DECIMAL(10,4) NOT NULL CHECK (price_per_unit > 0),
  currency        TEXT          NOT NULL DEFAULT 'MWK',
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  updated_by      UUID          NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (channel, currency)
);

DROP TRIGGER IF EXISTS trg_platform_pricing_updated_at ON platform_pricing;
CREATE TRIGGER trg_platform_pricing_updated_at
  BEFORE UPDATE ON platform_pricing
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

INSERT INTO platform_pricing (channel, unit_label, price_per_unit, currency)
VALUES ('sms', 'SMS', 18.0000, 'MWK')
ON CONFLICT (channel, currency) DO NOTHING;


-- ============================================================
-- STEP 1c: Alter subscription_tiers
-- ============================================================
ALTER TABLE subscription_tiers
  DROP COLUMN IF EXISTS sms_price_mwk,
  DROP COLUMN IF EXISTS whatsapp_price_mwk,
  DROP COLUMN IF EXISTS ussd_price_mwk,
  DROP COLUMN IF EXISTS email_price_mwk,
  DROP COLUMN IF EXISTS min_monthly_volume,
  DROP COLUMN IF EXISTS max_monthly_volume;

ALTER TABLE subscription_tiers
  ADD COLUMN IF NOT EXISTS tier_type               TEXT          NOT NULL DEFAULT 'bundle'
    CHECK (tier_type IN ('bundle','enterprise')),
  ADD COLUMN IF NOT EXISTS sms_credits_included    INT           NULL
    CHECK (sms_credits_included IS NULL OR sms_credits_included > 0),
  ADD COLUMN IF NOT EXISTS bundle_discount_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0.00
    CHECK (bundle_discount_pct >= 0 AND bundle_discount_pct < 100),
  ADD COLUMN IF NOT EXISTS is_postpaid             BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cached_bundle_price_mwk INT           NULL;

COMMENT ON COLUMN subscription_tiers.sms_credits_included IS
  'SMS credits granted on purchase. NULL for Enterprise.';
COMMENT ON COLUMN subscription_tiers.bundle_discount_pct IS
  'Discount % off (credits x global_price). Admin-adjustable.';
COMMENT ON COLUMN subscription_tiers.cached_bundle_price_mwk IS
  'Denormalized computed price in MWK. Kept in sync by trigger. Read-only for application code.';

DROP TRIGGER IF EXISTS trg_subscription_tiers_updated_at ON subscription_tiers;
CREATE TRIGGER trg_subscription_tiers_updated_at
  BEFORE UPDATE ON subscription_tiers
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();


-- ============================================================
-- STEP 1d: fn_recalculate_bundle_prices + triggers
-- ============================================================
CREATE OR REPLACE FUNCTION fn_recalculate_bundle_prices()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE subscription_tiers st
  SET cached_bundle_price_mwk = (
    SELECT CEIL(
      st2.sms_credits_included
      * pp.price_per_unit
      * (1.0 - st2.bundle_discount_pct / 100.0)
    )::INT
    FROM subscription_tiers st2
    CROSS JOIN platform_pricing pp
    WHERE st2.id = st.id
      AND pp.channel = 'sms'
      AND pp.is_active = true
  ),
  updated_at = NOW()
  WHERE tier_type = 'bundle'
    AND sms_credits_included IS NOT NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pricing_recalc_on_price_change ON platform_pricing;
CREATE TRIGGER trg_pricing_recalc_on_price_change
  AFTER UPDATE OF price_per_unit ON platform_pricing
  FOR EACH ROW
  WHEN (NEW.channel = 'sms')
  EXECUTE FUNCTION fn_recalculate_bundle_prices();

DROP TRIGGER IF EXISTS trg_tier_recalc_on_tier_change ON subscription_tiers;
CREATE TRIGGER trg_tier_recalc_on_tier_change
  AFTER UPDATE OF bundle_discount_pct, sms_credits_included ON subscription_tiers
  FOR EACH ROW
  WHEN (NEW.tier_type = 'bundle')
  EXECUTE FUNCTION fn_recalculate_bundle_prices();


-- ============================================================
-- STEP 1e: Seed subscription tiers + backfill cached prices
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'subscription_tiers_name_key'
      AND table_name = 'subscription_tiers'
  ) THEN
    ALTER TABLE subscription_tiers ADD CONSTRAINT subscription_tiers_name_key UNIQUE (name);
  END IF;
END;
$$;

INSERT INTO subscription_tiers
  (name, description, tier_type, sms_credits_included, bundle_discount_pct,
   is_postpaid, is_active, is_default, sort_order)
VALUES
  ('Basic Bundle',
   'Receive 1,200 SMS credits. Best for small campaigns.',
   'bundle', 1200, 7.41, false, true, true, 10),

  ('Business Bundle',
   'Receive 5,560 SMS credits. Best for growing businesses.',
   'bundle', 5560, 0.08, false, true, false, 20),

  ('Enterprise',
   'Postpaid plan for high-volume clients. Assigned by platform admins only.',
   'enterprise', NULL, 0.00, true, true, false, 30)
ON CONFLICT (name) DO UPDATE SET
  description           = EXCLUDED.description,
  tier_type             = EXCLUDED.tier_type,
  sms_credits_included  = EXCLUDED.sms_credits_included,
  bundle_discount_pct   = EXCLUDED.bundle_discount_pct,
  is_postpaid           = EXCLUDED.is_postpaid,
  sort_order            = EXCLUDED.sort_order,
  updated_at            = NOW();

-- Backfill cached_bundle_price_mwk (INSERT does not fire the AFTER UPDATE trigger)
UPDATE subscription_tiers st
SET cached_bundle_price_mwk = (
  SELECT CEIL(
    st2.sms_credits_included * pp.price_per_unit * (1.0 - st2.bundle_discount_pct / 100.0)
  )::INT
  FROM subscription_tiers st2
  CROSS JOIN platform_pricing pp
  WHERE st2.id = st.id
    AND pp.channel = 'sms'
    AND pp.is_active = true
)
WHERE tier_type = 'bundle'
  AND sms_credits_included IS NOT NULL;


-- ============================================================
-- STEP 1f: Add sms_credits to tenants + guard trigger
-- ============================================================
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sms_credits INT NOT NULL DEFAULT 0
    CHECK (sms_credits >= 0);

COMMENT ON COLUMN tenants.sms_credits IS
  'Integer SMS credit balance. Debited 1-per-SMS on send (non-Enterprise). Never decimals.';

CREATE OR REPLACE FUNCTION fn_validate_sms_credits()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sms_credits < 0 THEN
    RAISE EXCEPTION 'sms_credits cannot be negative (tenant %)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_validate_sms_credits ON tenants;
CREATE TRIGGER trg_tenants_validate_sms_credits
  BEFORE UPDATE OF sms_credits ON tenants
  FOR EACH ROW EXECUTE FUNCTION fn_validate_sms_credits();

DROP TRIGGER IF EXISTS trg_tenants_updated_at ON tenants;
CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();


-- ============================================================
-- STEP 1g: Create orders table
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  created_by            UUID          NOT NULL REFERENCES users(id),
  order_type            TEXT          NOT NULL
    CHECK (order_type IN ('bundle','topup','enterprise_assignment')),
  channel               TEXT          NOT NULL DEFAULT 'sms'
    CHECK (channel IN ('sms','whatsapp','email','ussd')),
  -- Bundle fields (snapshotted at order creation time)
  tier_id               UUID          NULL REFERENCES subscription_tiers(id),
  bundle_sms_credits    INT           NULL CHECK (bundle_sms_credits IS NULL OR bundle_sms_credits > 0),
  bundle_price_mwk      DECIMAL(12,2) NULL,
  bundle_discount_pct   DECIMAL(5,2)  NULL,
  -- Top-up fields
  topup_sms_count       INT           NULL CHECK (topup_sms_count IS NULL OR topup_sms_count > 0),
  topup_price_per_sms   DECIMAL(10,4) NULL,
  topup_amount_mwk      DECIMAL(15,2) NULL,
  -- Generated: credits from bundle OR topup
  effective_sms_credits INT GENERATED ALWAYS AS (
    COALESCE(bundle_sms_credits, topup_sms_count)
  ) STORED,
  -- Status
  status                TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','fulfilled','failed','cancelled')),
  fulfilled_at          TIMESTAMPTZ   NULL,
  notes                 TEXT          NULL,
  metadata              JSONB         NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_tier_id   ON orders(tier_id);
CREATE INDEX IF NOT EXISTS idx_orders_channel   ON orders(channel);

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

COMMENT ON COLUMN orders.effective_sms_credits IS
  'Generated column: COALESCE(bundle_sms_credits, topup_sms_count). Read-only.';


-- ============================================================
-- STEP 1h: Add order_id to invoices + auto invoice number trigger
-- ============================================================
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS order_id UUID NULL REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id);

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

CREATE OR REPLACE FUNCTION fn_generate_invoice_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_number IS NULL OR NEW.invoice_number = '' THEN
    NEW.invoice_number :=
      'INV-' || TO_CHAR(NOW(), 'YYYY') || '-'
      || LPAD(NEXTVAL('invoice_number_seq')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoices_invoice_number ON invoices;
CREATE TRIGGER trg_invoices_invoice_number
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION fn_generate_invoice_number();

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();


-- ============================================================
-- STEP 1i: Add channel + credits_amount to balance_ledger
--          + immutability triggers
-- ============================================================
ALTER TABLE balance_ledger
  ADD COLUMN IF NOT EXISTS channel        TEXT NOT NULL DEFAULT 'sms'
    CHECK (channel IN ('sms','whatsapp','email','ussd','mwk')),
  ADD COLUMN IF NOT EXISTS credits_amount INT  NULL;

COMMENT ON COLUMN balance_ledger.channel IS
  'Channel these credits belong to. ''mwk'' reserved for legacy MWK entries.';
COMMENT ON COLUMN balance_ledger.credits_amount IS
  'Integer credits debited or credited. Positive value; direction indicated by entry_type.';

CREATE OR REPLACE FUNCTION fn_prevent_ledger_modification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'balance_ledger entries are immutable. Use a reversal entry instead (entry_type = ''reversal'').';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON balance_ledger;
DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON balance_ledger;

CREATE TRIGGER trg_prevent_ledger_update
  BEFORE UPDATE ON balance_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_prevent_ledger_modification();

CREATE TRIGGER trg_prevent_ledger_delete
  BEFORE DELETE ON balance_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_prevent_ledger_modification();


-- ============================================================
-- STEP 1j: RPC deduct_sms_credits
-- ============================================================
CREATE OR REPLACE FUNCTION deduct_sms_credits(
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
  SELECT sms_credits INTO v_current
  FROM tenants WHERE id = p_tenant_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant % not found', p_tenant_id;
  END IF;

  IF v_current < p_count THEN
    RETURN FALSE;
  END IF;

  SELECT price_per_unit INTO v_price
  FROM platform_pricing
  WHERE channel = 'sms' AND currency = 'MWK' AND is_active = true
  LIMIT 1;

  v_new_bal := v_current - p_count;

  UPDATE tenants
  SET sms_credits = v_new_bal, updated_at = NOW()
  WHERE id = p_tenant_id;

  INSERT INTO balance_ledger
    (tenant_id, entry_type, channel, credits_amount,
     amount_mwk, balance_after_mwk,
     reference_type, reference_id, description,
     message_count, cost_per_message_mwk)
  VALUES
    (p_tenant_id, 'debit', 'sms', p_count,
     p_count * COALESCE(v_price, 0),
     v_new_bal,
     p_reference_type, p_reference_id, p_description,
     p_count, v_price);

  RETURN TRUE;
END;
$$;


-- ============================================================
-- STEP 1k: RPC fulfill_bundle_order
-- ============================================================
CREATE OR REPLACE FUNCTION fulfill_bundle_order(p_order_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_order     orders%ROWTYPE;
  v_credits   INT;
  v_new_bal   INT;
  v_tier_name TEXT;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  -- Idempotency guard: safe to call twice
  IF v_order.status = 'fulfilled' THEN
    RETURN TRUE;
  END IF;

  IF v_order.status NOT IN ('pending','processing') THEN
    RAISE EXCEPTION 'Cannot fulfil order % in status %', p_order_id, v_order.status;
  END IF;

  IF v_order.order_type = 'bundle' THEN
    v_credits := v_order.bundle_sms_credits;

    SELECT name INTO v_tier_name FROM subscription_tiers WHERE id = v_order.tier_id;

    UPDATE tenants
    SET sms_credits          = sms_credits + v_credits,
        subscription_tier_id = v_order.tier_id,
        updated_at           = NOW()
    WHERE id = v_order.tenant_id;

    SELECT sms_credits INTO v_new_bal FROM tenants WHERE id = v_order.tenant_id;

    INSERT INTO balance_ledger
      (tenant_id, entry_type, channel, credits_amount,
       amount_mwk, balance_after_mwk,
       reference_type, reference_id, description, created_by)
    VALUES
      (v_order.tenant_id, 'credit', 'sms', v_credits,
       v_order.bundle_price_mwk, v_new_bal,
       'order', p_order_id,
       'Bundle purchase: ' || COALESCE(v_tier_name, 'Unknown tier'),
       v_order.created_by);

  ELSIF v_order.order_type = 'topup' THEN
    v_credits := v_order.topup_sms_count;

    UPDATE tenants
    SET sms_credits = sms_credits + v_credits, updated_at = NOW()
    WHERE id = v_order.tenant_id;

    SELECT sms_credits INTO v_new_bal FROM tenants WHERE id = v_order.tenant_id;

    INSERT INTO balance_ledger
      (tenant_id, entry_type, channel, credits_amount,
       amount_mwk, balance_after_mwk,
       reference_type, reference_id, description, created_by)
    VALUES
      (v_order.tenant_id, 'credit', 'sms', v_credits,
       v_order.topup_amount_mwk, v_new_bal,
       'order', p_order_id,
       'SMS top-up: ' || v_credits || ' credits @ MWK ' || v_order.topup_price_per_sms || '/SMS',
       v_order.created_by);

  ELSIF v_order.order_type = 'enterprise_assignment' THEN
    NULL; -- No money movement; tier already updated in the admin endpoint
  END IF;

  UPDATE orders
  SET status = 'fulfilled', fulfilled_at = NOW(), updated_at = NOW()
  WHERE id = p_order_id;

  RETURN TRUE;
END;
$$;


-- ============================================================
-- STEP 1l: fn_verify_balance_consistency (audit / reconciliation)
-- ============================================================
CREATE OR REPLACE FUNCTION fn_verify_balance_consistency(p_tenant_id UUID)
RETURNS TABLE(
  tenant_id          UUID,
  ledger_net_credits BIGINT,
  stored_sms_credits INT,
  discrepancy        BIGINT,
  is_consistent      BOOLEAN
) LANGUAGE sql STABLE AS $$
  SELECT
    p_tenant_id,
    SUM(CASE WHEN entry_type IN ('credit','reversal') THEN credits_amount
             ELSE -credits_amount END)::BIGINT AS ledger_net_credits,
    t.sms_credits,
    SUM(CASE WHEN entry_type IN ('credit','reversal') THEN credits_amount
             ELSE -credits_amount END)::BIGINT - t.sms_credits AS discrepancy,
    SUM(CASE WHEN entry_type IN ('credit','reversal') THEN credits_amount
             ELSE -credits_amount END)::BIGINT = t.sms_credits AS is_consistent
  FROM balance_ledger bl
  CROSS JOIN tenants t
  WHERE bl.tenant_id = p_tenant_id
    AND t.id = p_tenant_id
    AND bl.channel = 'sms'
  GROUP BY t.sms_credits;
$$;


-- ============================================================
-- STEP 1m: Aggregate views
-- ============================================================

-- Always-fresh tier pricing with computed and cached bundle prices
CREATE OR REPLACE VIEW v_tier_pricing AS
SELECT
  st.id,
  st.name,
  st.description,
  st.tier_type,
  st.sms_credits_included,
  st.bundle_discount_pct,
  st.is_postpaid,
  st.is_active,
  st.is_default,
  st.sort_order,
  pp.price_per_unit                    AS sms_global_price_mwk,
  CASE
    WHEN st.tier_type = 'bundle' AND st.sms_credits_included IS NOT NULL
    THEN CEIL(
      st.sms_credits_included
      * pp.price_per_unit
      * (1.0 - st.bundle_discount_pct / 100.0)
    )::INT
    ELSE NULL
  END                                  AS computed_bundle_price_mwk,
  st.cached_bundle_price_mwk,
  CASE
    WHEN st.tier_type = 'bundle' AND st.sms_credits_included IS NOT NULL
    THEN (st.sms_credits_included * pp.price_per_unit)::INT
    ELSE NULL
  END                                  AS full_price_mwk
FROM subscription_tiers st
CROSS JOIN platform_pricing pp
WHERE pp.channel = 'sms'
  AND pp.is_active = true;

-- Per-tenant SMS credit summary for reconciliation and dashboards
CREATE OR REPLACE VIEW v_tenant_sms_summary AS
SELECT
  t.id                                                            AS tenant_id,
  t.sms_credits                                                   AS current_sms_credits,
  COALESCE(SUM(bl.credits_amount) FILTER (
    WHERE bl.entry_type = 'credit'), 0)::BIGINT                   AS total_credits_ever,
  COALESCE(SUM(bl.credits_amount) FILTER (
    WHERE bl.entry_type = 'debit'), 0)::BIGINT                    AS total_sms_sent,
  COALESCE(COUNT(*) FILTER (
    WHERE bl.entry_type = 'debit'), 0)                            AS total_send_operations,
  MAX(bl.created_at) FILTER (WHERE bl.entry_type = 'debit')       AS last_send_at,
  MAX(bl.created_at) FILTER (WHERE bl.entry_type = 'credit')      AS last_credit_at
FROM tenants t
LEFT JOIN balance_ledger bl
  ON bl.tenant_id = t.id AND bl.channel = 'sms'
GROUP BY t.id, t.sms_credits;


-- ============================================================
-- VERIFICATION (run these separately after migration completes)
-- ============================================================

-- 1. All triggers created
-- SELECT trigger_name, event_object_table
-- FROM information_schema.triggers
-- WHERE trigger_schema = 'public' AND trigger_name LIKE 'trg_%'
-- ORDER BY event_object_table;

-- 2. Cached prices correct (Basic Bundle → 20000, Business Bundle → 100000)
-- SELECT name, sms_credits_included, bundle_discount_pct, cached_bundle_price_mwk
-- FROM subscription_tiers ORDER BY sort_order;

-- 3. Views exist
-- SELECT table_name FROM information_schema.views
-- WHERE table_name IN ('v_tier_pricing','v_tenant_sms_summary');

-- 4. RPCs exist
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_name IN ('deduct_sms_credits','fulfill_bundle_order','fn_verify_balance_consistency');

-- 5. Generated column on orders
-- SELECT column_name, generation_expression FROM information_schema.columns
-- WHERE table_name = 'orders' AND column_name = 'effective_sms_credits';
