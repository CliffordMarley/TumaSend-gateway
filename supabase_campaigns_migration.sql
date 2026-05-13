-- =============================================================
-- Campaign Engine Migration
-- =============================================================

-- Main campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by          UUID          NOT NULL REFERENCES users(id),
  name                TEXT          NOT NULL,
  description         TEXT          NULL,
  message             TEXT          NOT NULL,
  sender_id_id        UUID          NOT NULL REFERENCES sender_ids(id),
  sender_name         TEXT          NOT NULL,   -- snapshot of sender_ids.sender_id at creation
  contact_list_id     UUID          NULL REFERENCES contact_lists(id) ON DELETE SET NULL,
  status              TEXT          NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','running','completed','cancelled','failed')),
  scheduled_at        TIMESTAMPTZ   NULL,
  started_at          TIMESTAMPTZ   NULL,
  completed_at        TIMESTAMPTZ   NULL,
  -- Live stats (denormalised from batch for quick reads)
  total_recipients    INT           NOT NULL DEFAULT 0,
  total_sent          INT           NOT NULL DEFAULT 0,
  total_delivered     INT           NOT NULL DEFAULT 0,
  total_failed        INT           NOT NULL DEFAULT 0,
  total_credits_used  INT           NOT NULL DEFAULT 0,
  batch_id            UUID          NULL,       -- set once the send batch is created
  metadata            JSONB         NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Link message batches back to the campaign that created them
ALTER TABLE message_batches
  ADD COLUMN IF NOT EXISTS campaign_id UUID NULL REFERENCES campaigns(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_id     ON campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status        ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at
  ON campaigns(scheduled_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_message_batches_campaign
  ON message_batches(campaign_id)
  WHERE campaign_id IS NOT NULL;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON campaigns;
CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();
