-- ============================================================
-- Communications Gateway — Content Moderation Migration
-- Run this entire file in the Supabase SQL Editor
-- ============================================================
-- ============================================================
-- STEP 1: content_blocklist table
-- ============================================================
CREATE TABLE IF NOT EXISTS content_blocklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  term TEXT NOT NULL,
  term_type TEXT NOT NULL DEFAULT 'phrase' CHECK (term_type IN ('word', 'phrase', 'regex')),
  channels TEXT [] NOT NULL DEFAULT ARRAY ['sms','whatsapp'],
  severity TEXT NOT NULL DEFAULT 'block' CHECK (severity IN ('block', 'flag')),
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('profanity','hate_speech','fraud','phishing','gambling_marketing','spam','explicit','general')),
  note TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term, term_type)
);

-- Add category to existing installs that ran the migration before this column existed
ALTER TABLE content_blocklist
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('profanity','hate_speech','fraud','phishing','gambling_marketing','spam','explicit','general'));

CREATE INDEX IF NOT EXISTS idx_blocklist_is_active ON content_blocklist(is_active);

CREATE INDEX IF NOT EXISTS idx_blocklist_channels ON content_blocklist USING GIN(channels);

DROP TRIGGER IF EXISTS trg_blocklist_updated_at ON content_blocklist;

CREATE TRIGGER trg_blocklist_updated_at BEFORE
UPDATE
  ON content_blocklist FOR EACH ROW EXECUTE FUNCTION fn_auto_updated_at();

-- Platform admins can manage the blocklist via service role; no tenant access
ALTER TABLE
  content_blocklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY blocklist_service_only ON content_blocklist FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- STEP 2: blocked_messages log table
-- ============================================================
CREATE TABLE IF NOT EXISTS blocked_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  api_key_id UUID NULL REFERENCES api_keys(id) ON DELETE
  SET
    NULL,
    message_content TEXT NOT NULL,
    recipient_count INT NOT NULL DEFAULT 1,
    matched_term TEXT NOT NULL,
    matched_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('block', 'flag')),
    request_ip TEXT NULL,
    reviewed BOOLEAN NOT NULL DEFAULT false,
    reviewed_by UUID NULL REFERENCES users(id),
    reviewed_at TIMESTAMPTZ NULL,
    review_note TEXT NULL,
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocked_messages_tenant_id ON blocked_messages(tenant_id);

CREATE INDEX IF NOT EXISTS idx_blocked_messages_reviewed ON blocked_messages(reviewed);

CREATE INDEX IF NOT EXISTS idx_blocked_messages_blocked_at ON blocked_messages(blocked_at DESC);

CREATE INDEX IF NOT EXISTS idx_blocked_messages_channel ON blocked_messages(channel);

ALTER TABLE
  blocked_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY blocked_messages_service_only ON blocked_messages FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- STEP 3: Seed starter blocklist
-- Categories: profanity, hate speech, fraud/phishing, spam,
--             mobile-money scams, loan sharks, explicit content
-- All entries use ON CONFLICT DO NOTHING — safe to re-run.
-- ============================================================
INSERT INTO
  content_blocklist (term, term_type, channels, severity, category, note)
VALUES
  -- ── Profanity (word — whole-word only, won't flag "skill" for "kill") ──
  (
    'fuck',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'shit',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'ass',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'profanity',
    'Profanity — flagged only (common in legitimate use)'
  ),
  (
    'bitch',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'bastard',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'cunt',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'dick',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'profanity',
    'Profanity — flagged only'
  ),
  (
    'pussy',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'whore',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity'
  ),
  (
    'faggot',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'profanity',
    'Profanity / slur'
  ),
  -- ── Hate speech ──
  (
    'nigger',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Racial slur'
  ),
  (
    'nigga',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Racial slur'
  ),
  (
    'kaffir',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Racial slur — Southern Africa'
  ),
  (
    'chink',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Racial slur'
  ),
  (
    'wetback',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Racial slur'
  ),
  (
    'retard',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Ableist slur'
  ),
  (
    'kill all',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Incitement to violence'
  ),
  (
    'death to',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'hate_speech',
    'Incitement to violence'
  ),
  -- ── Gambling marketing (exemptable for regulated betting operators) ──
  (
    'win a prize',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'gambling_marketing',
    'Gambling marketing / fraud indicator'
  ),
  (
    'you have won',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'gambling_marketing',
    'Gambling marketing / lottery scam'
  ),
  (
    'congratulations you',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'gambling_marketing',
    'Gambling marketing / lottery scam indicator'
  ),
  (
    'claim your reward',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'gambling_marketing',
    'Gambling marketing / fraud indicator'
  ),
  (
    'claim your prize',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'gambling_marketing',
    'Gambling marketing / fraud indicator'
  ),
  -- ── Fraud ──
  (
    'free money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'fraud',
    'Fraud indicator'
  ),
  (
    'double your money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'fraud',
    'Investment fraud'
  ),
  (
    'make money fast',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'fraud',
    'Fraud / pyramid scheme'
  ),
  (
    'guaranteed returns',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'fraud',
    'Investment fraud indicator'
  ),
  (
    'pyramid',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'fraud',
    'Pyramid scheme indicator'
  ),
  (
    'ponzi',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'fraud',
    'Ponzi scheme indicator'
  ),
  (
    'instant loan no collateral',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'fraud',
    'Predatory lending indicator'
  ),
  (
    'quick loan no documents',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'fraud',
    'Predatory lending indicator'
  ),
  (
    'borrow cash instantly',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'fraud',
    'Predatory lending indicator'
  ),
  -- ── Phishing ──
  (
    'send your pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'PIN phishing'
  ),
  (
    'share your pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'PIN phishing'
  ),
  (
    'send your password',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Password phishing'
  ),
  (
    'confirm your otp',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'OTP phishing'
  ),
  (
    'send otp',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'OTP phishing'
  ),
  (
    'verify your account by replying',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Phishing'
  ),
  (
    'your account has been suspended',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Phishing / impersonation'
  ),
  (
    'bank account details',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Data harvesting indicator'
  ),
  (
    'click to claim',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Phishing link'
  ),
  (
    'limited time offer',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Spam / urgency tactic'
  ),
  (
    'act now',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Urgency spam'
  ),
  (
    'urgent action required',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Urgency phishing'
  ),
  -- ── Mobile-money scams (Malawi-specific: Airtel Money, TNM Mpamba) ──
  (
    'airtel money pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Mobile money PIN phishing'
  ),
  (
    'mpamba pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Mobile money PIN phishing'
  ),
  (
    'send airtel money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Mobile money scam indicator'
  ),
  (
    'send mpamba',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Mobile money scam indicator'
  ),
  (
    'mobile money pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Mobile money PIN phishing'
  ),
  (
    'reverse transaction',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'Reversal scam'
  ),
  (
    'wrong transfer',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Reversal scam indicator'
  ),
  (
    'sent by mistake',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Reversal scam indicator'
  ),
  (
    'refund the money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'phishing',
    'Reversal scam indicator'
  ),
  -- ── Spam indicators ──
  (
    'buy cheap',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Spam indicator'
  ),
  (
    'click here',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Phishing / spam link'
  ),
  (
    'unsubscribe',
    'phrase',
    ARRAY ['sms'],
    'flag',
    'spam',
    'Bulk unsolicited SMS indicator'
  ),
  (
    'opt out',
    'phrase',
    ARRAY ['sms'],
    'flag',
    'spam',
    'Bulk unsolicited SMS indicator'
  ),
  (
    'for more info reply stop',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Unsolicited bulk SMS'
  ),
  (
    'reply stop to unsubscribe',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Unsolicited bulk SMS'
  ),
  (
    '100% free',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Spam indicator'
  ),
  (
    'no cost',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Spam indicator'
  ),
  (
    'earn from home',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Spam / pyramid scheme indicator'
  ),
  -- ── Explicit content ──
  (
    'xxx',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'explicit',
    'Explicit content'
  ),
  (
    'porn',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'explicit',
    'Explicit content'
  ),
  (
    'nude',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'explicit',
    'Explicit content indicator'
  ),
  (
    'naked pics',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'explicit',
    'Explicit content'
  ),
  (
    'send nudes',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'explicit',
    'Explicit content / harassment'
  ),
  -- ── Regex patterns ──
  -- Matches URLs shortened to common phishing domains
  (
    '^.*(bit\.ly|tinyurl\.com|t\.co).*$',
    'regex',
    ARRAY ['sms','whatsapp'],
    'flag',
    'spam',
    'Shortened URL — review for phishing'
  ),
  -- Matches messages asking for any 4-6 digit PIN/OTP code
  (
    '(send|reply|share|give).{0,30}\\b\\d{4,6}\\b',
    'regex',
    ARRAY ['sms','whatsapp'],
    'block',
    'phishing',
    'PIN/OTP extraction pattern'
  ) ON CONFLICT (term, term_type) DO NOTHING;

-- ── Backfill categories for any rows inserted before this column was added ──
-- (ON CONFLICT above won't update existing rows, so we backfill by term match)
UPDATE content_blocklist SET category = 'profanity'
  WHERE term IN ('fuck','shit','ass','bitch','bastard','cunt','dick','pussy','whore','faggot')
    AND category = 'general';

UPDATE content_blocklist SET category = 'hate_speech'
  WHERE term IN ('nigger','nigga','kaffir','chink','wetback','retard','kill all','death to')
    AND category = 'general';

UPDATE content_blocklist SET category = 'gambling_marketing'
  WHERE term IN ('win a prize','you have won','congratulations you','claim your reward','claim your prize')
    AND category = 'general';

UPDATE content_blocklist SET category = 'fraud'
  WHERE term IN ('free money','double your money','make money fast','guaranteed returns',
                 'pyramid','ponzi','instant loan no collateral','quick loan no documents','borrow cash instantly')
    AND category = 'general';

UPDATE content_blocklist SET category = 'phishing'
  WHERE term IN ('send your pin','share your pin','send your password','confirm your otp','send otp',
                 'verify your account by replying','your account has been suspended','bank account details',
                 'click to claim','limited time offer','act now','urgent action required',
                 'airtel money pin','mpamba pin','send airtel money','send mpamba','mobile money pin',
                 'reverse transaction','wrong transfer','sent by mistake','refund the money',
                 '(send|reply|share|give).{0,30}\\b\\d{4,6}\\b')
    AND category = 'general';

UPDATE content_blocklist SET category = 'spam'
  WHERE term IN ('buy cheap','click here','unsubscribe','opt out','for more info reply stop',
                 'reply stop to unsubscribe','100% free','no cost','earn from home',
                 '^.*(bit\.ly|tinyurl\.com|t\.co).*$')
    AND category = 'general';

UPDATE content_blocklist SET category = 'explicit'
  WHERE term IN ('xxx','porn','nude','naked pics','send nudes')
    AND category = 'general';

-- ============================================================
-- STEP 4: Per-tenant moderation exemptions
-- Platform admins grant a tenant an exemption from an entire
-- category. New terms added to that category are automatically
-- exempt for already-exempted tenants.
-- profanity and hate_speech are never exemptable (enforced at
-- the route layer — not a DB constraint so admins get a clear
-- 400 error rather than a cryptic CHECK violation).
-- ============================================================
CREATE TABLE IF NOT EXISTS tenant_moderation_exemptions (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category    TEXT        NOT NULL
    CHECK (category IN ('fraud','phishing','gambling_marketing','spam','explicit','general')),
  note        TEXT        NULL,
  granted_by  UUID        NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, category)
);

CREATE INDEX IF NOT EXISTS idx_tenant_exemptions_tenant_id
  ON tenant_moderation_exemptions(tenant_id);

ALTER TABLE tenant_moderation_exemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY exemptions_service_only ON tenant_moderation_exemptions
  FOR ALL USING (auth.role() = 'service_role');