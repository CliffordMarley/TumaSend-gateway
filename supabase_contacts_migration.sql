-- ============================================================
-- Contacts, Contact Lists & Contact List Members
-- Run in Supabase SQL Editor
-- ============================================================

-- fn_auto_updated_at already exists from the billing migration.

-- ============================================================
-- contacts
-- ============================================================
CREATE TABLE IF NOT EXISTS contacts (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone                   TEXT          NULL,
  email                   TEXT          NULL,
  full_name               TEXT          NULL,
  first_name              TEXT          NULL,
  last_name               TEXT          NULL,
  custom_fields           JSONB         NOT NULL DEFAULT '{}',
  tags                    TEXT[]        NOT NULL DEFAULT '{}',
  sms_opted_out           BOOLEAN       NOT NULL DEFAULT FALSE,
  sms_opted_out_at        TIMESTAMPTZ   NULL,
  whatsapp_opted_out      BOOLEAN       NOT NULL DEFAULT FALSE,
  whatsapp_opted_out_at   TIMESTAMPTZ   NULL,
  email_opted_out         BOOLEAN       NOT NULL DEFAULT FALSE,
  email_opted_out_at      TIMESTAMPTZ   NULL,
  source                  TEXT          NULL CHECK (source IN ('manual', 'import', 'api', 'campaign_signup')),
  first_batch_id          UUID          NULL REFERENCES message_batches(id) ON DELETE SET NULL,
  messages_sent           INTEGER       NOT NULL DEFAULT 0,
  messages_delivered      INTEGER       NOT NULL DEFAULT 0,
  last_contacted_at       TIMESTAMPTZ   NULL,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, phone)
);

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON contacts;
CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

-- ============================================================
-- contact_lists
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_lists (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by     UUID        NULL REFERENCES users(id),
  name           TEXT        NOT NULL,
  description    TEXT        NULL,
  contact_count  INTEGER     NOT NULL DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_contact_lists_updated_at ON contact_lists;
CREATE TRIGGER trg_contact_lists_updated_at
  BEFORE UPDATE ON contact_lists
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

-- ============================================================
-- contact_list_members
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_list_members (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_list_id  UUID        NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id       UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by         UUID        NULL REFERENCES users(id),
  UNIQUE (contact_list_id, contact_id)
);

-- ============================================================
-- RLS: service role bypasses RLS so backend always has access.
-- Tenant-scoped read via authenticated users.
-- ============================================================
ALTER TABLE contacts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_lists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_list_members ENABLE ROW LEVEL SECURITY;

-- If the contacts table already exists without first_batch_id, add the column
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_batch_id UUID NULL REFERENCES message_batches(id) ON DELETE SET NULL;

-- Index for fast phone lookup during upserts
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone  ON contacts (tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id     ON contacts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_source        ON contacts (tenant_id, source);
CREATE INDEX IF NOT EXISTS idx_contacts_batch         ON contacts (tenant_id, first_batch_id);
CREATE INDEX IF NOT EXISTS idx_contact_lists_tenant   ON contact_lists (tenant_id);

-- ============================================================
-- RPC: bulk increment messages_sent + update last_contacted_at
-- Called from sendRoutes after each batch is accepted.
-- ============================================================
CREATE OR REPLACE FUNCTION increment_contact_messages_sent(
  p_tenant_id   UUID,
  p_phones      TEXT[],
  p_contacted_at TIMESTAMPTZ
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contacts
  SET
    messages_sent     = messages_sent + 1,
    last_contacted_at = p_contacted_at
  WHERE tenant_id = p_tenant_id
    AND phone = ANY(p_phones);
END;
$$;

-- ============================================================
-- RPC: increment messages_delivered for a single contact phone
-- Called from the Kannel DLR webhook on confirmed delivery.
-- ============================================================
CREATE OR REPLACE FUNCTION increment_contact_messages_delivered(
  p_tenant_id UUID,
  p_phone     TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contacts
  SET messages_delivered = messages_delivered + 1
  WHERE tenant_id = p_tenant_id
    AND phone = p_phone;
END;
$$;
