-- ============================================================
-- Communications Gateway — Content Moderation Migration
-- Run this entire file in the Supabase SQL Editor
-- ============================================================


-- ============================================================
-- STEP 1: content_blocklist table
-- ============================================================
CREATE TABLE IF NOT EXISTS content_blocklist (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  term         TEXT        NOT NULL,
  term_type    TEXT        NOT NULL DEFAULT 'phrase'
                 CHECK (term_type IN ('word', 'phrase', 'regex')),
  channels     TEXT[]      NOT NULL DEFAULT ARRAY['sms','whatsapp'],
  severity     TEXT        NOT NULL DEFAULT 'block'
                 CHECK (severity IN ('block', 'flag')),
  note         TEXT        NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_by   UUID        NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term, term_type)
);

CREATE INDEX IF NOT EXISTS idx_blocklist_is_active  ON content_blocklist(is_active);
CREATE INDEX IF NOT EXISTS idx_blocklist_channels   ON content_blocklist USING GIN(channels);

DROP TRIGGER IF EXISTS trg_blocklist_updated_at ON content_blocklist;
CREATE TRIGGER trg_blocklist_updated_at
  BEFORE UPDATE ON content_blocklist
  FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

-- Platform admins can manage the blocklist via service role; no tenant access
ALTER TABLE content_blocklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocklist_service_only ON content_blocklist
  FOR ALL USING (auth.role() = 'service_role');


-- ============================================================
-- STEP 2: blocked_messages log table
-- ============================================================
CREATE TABLE IF NOT EXISTS blocked_messages (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         TEXT        NOT NULL CHECK (channel IN ('sms','whatsapp')),
  api_key_id      UUID        NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  message_content TEXT        NOT NULL,
  recipient_count INT         NOT NULL DEFAULT 1,
  matched_term    TEXT        NOT NULL,
  matched_type    TEXT        NOT NULL,
  severity        TEXT        NOT NULL CHECK (severity IN ('block','flag')),
  request_ip      TEXT        NULL,
  reviewed        BOOLEAN     NOT NULL DEFAULT false,
  reviewed_by     UUID        NULL REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ NULL,
  review_note     TEXT        NULL,
  blocked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocked_messages_tenant_id  ON blocked_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_blocked_messages_reviewed   ON blocked_messages(reviewed);
CREATE INDEX IF NOT EXISTS idx_blocked_messages_blocked_at ON blocked_messages(blocked_at DESC);
CREATE INDEX IF NOT EXISTS idx_blocked_messages_channel    ON blocked_messages(channel);

ALTER TABLE blocked_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocked_messages_service_only ON blocked_messages
  FOR ALL USING (auth.role() = 'service_role');


-- ============================================================
-- STEP 3: Seed a minimal starter blocklist
-- ============================================================
INSERT INTO content_blocklist (term, term_type, channels, severity, note)
VALUES
  ('fuck',        'word',   ARRAY['sms','whatsapp'], 'block', 'Profanity'),
  ('shit',        'word',   ARRAY['sms','whatsapp'], 'block', 'Profanity'),
  ('nigger',      'word',   ARRAY['sms','whatsapp'], 'block', 'Hate speech'),
  ('nigga',       'word',   ARRAY['sms','whatsapp'], 'block', 'Hate speech'),
  ('buy cheap',   'phrase', ARRAY['sms','whatsapp'], 'flag',  'Spam indicator'),
  ('click here',  'phrase', ARRAY['sms','whatsapp'], 'flag',  'Phishing indicator'),
  ('free money',  'phrase', ARRAY['sms','whatsapp'], 'block', 'Fraud indicator'),
  ('win a prize', 'phrase', ARRAY['sms','whatsapp'], 'block', 'Fraud indicator'),
  ('send your pin','phrase',ARRAY['sms','whatsapp'], 'block', 'Fraud/phishing')
ON CONFLICT (term, term_type) DO NOTHING;
