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
  note TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term, term_type)
);

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
  content_blocklist (term, term_type, channels, severity, note)
VALUES
  -- ── Profanity (word — whole-word only, won't flag "skill" for "kill") ──
  (
    'fuck',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'shit',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'ass',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Profanity — flagged only (common in legitimate use)'
  ),
  (
    'bitch',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'bastard',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'cunt',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'dick',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Profanity — flagged only'
  ),
  (
    'pussy',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'whore',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity'
  ),
  (
    'faggot',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Profanity / slur'
  ),
  -- ── Hate speech ──
  (
    'nigger',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Racial slur'
  ),
  (
    'nigga',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Racial slur'
  ),
  (
    'kaffir',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Racial slur — Southern Africa'
  ),
  (
    'chink',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Racial slur'
  ),
  (
    'wetback',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Racial slur'
  ),
  (
    'retard',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Ableist slur'
  ),
  (
    'kill all',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Incitement to violence'
  ),
  (
    'death to',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Incitement to violence'
  ),
  -- ── Fraud / phishing ──
  (
    'free money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Fraud indicator'
  ),
  (
    'win a prize',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Fraud indicator'
  ),
  (
    'you have won',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Lottery scam'
  ),
  (
    'congratulations you',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Lottery scam indicator'
  ),
  (
    'claim your reward',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Fraud indicator'
  ),
  (
    'claim your prize',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Fraud indicator'
  ),
  (
    'send your pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'PIN phishing'
  ),
  (
    'share your pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'PIN phishing'
  ),
  (
    'send your password',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Password phishing'
  ),
  (
    'confirm your otp',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'OTP phishing'
  ),
  (
    'send otp',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'OTP phishing'
  ),
  (
    'verify your account by replying',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Phishing'
  ),
  (
    'your account has been suspended',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Phishing / impersonation'
  ),
  (
    'bank account details',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Data harvesting indicator'
  ),
  (
    'click to claim',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Phishing link'
  ),
  (
    'limited time offer',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Spam / urgency tactic'
  ),
  (
    'act now',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Urgency spam'
  ),
  (
    'urgent action required',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Urgency phishing'
  ),
  -- ── Mobile-money scams (Malawi-specific: Airtel Money, TNM Mpamba) ──
  (
    'airtel money pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Mobile money PIN phishing'
  ),
  (
    'mpamba pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Mobile money PIN phishing'
  ),
  (
    'send airtel money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Mobile money scam indicator'
  ),
  (
    'send mpamba',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Mobile money scam indicator'
  ),
  (
    'mobile money pin',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Mobile money PIN phishing'
  ),
  (
    'reverse transaction',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Reversal scam'
  ),
  (
    'wrong transfer',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Reversal scam indicator'
  ),
  (
    'sent by mistake',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Reversal scam indicator'
  ),
  (
    'refund the money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Reversal scam indicator'
  ),
  -- ── Loan shark / predatory lending ──
  (
    'instant loan no collateral',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Predatory lending indicator'
  ),
  (
    'quick loan no documents',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Predatory lending indicator'
  ),
  (
    'borrow cash instantly',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Predatory lending indicator'
  ),
  -- ── Spam indicators ──
  (
    'buy cheap',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Spam indicator'
  ),
  (
    'click here',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Phishing / spam link'
  ),
  (
    'unsubscribe',
    'phrase',
    ARRAY ['sms'],
    'flag',
    'Bulk unsolicited SMS indicator'
  ),
  (
    'opt out',
    'phrase',
    ARRAY ['sms'],
    'flag',
    'Bulk unsolicited SMS indicator'
  ),
  (
    'for more info reply stop',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Unsolicited bulk SMS'
  ),
  (
    'reply stop to unsubscribe',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Unsolicited bulk SMS'
  ),
  (
    '100% free',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Spam indicator'
  ),
  (
    'no cost',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Spam indicator'
  ),
  (
    'make money fast',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Fraud / pyramid scheme'
  ),
  (
    'earn from home',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Spam / pyramid scheme indicator'
  ),
  (
    'double your money',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Investment fraud'
  ),
  (
    'guaranteed returns',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Investment fraud indicator'
  ),
  (
    'pyramid',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Pyramid scheme indicator'
  ),
  (
    'ponzi',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Ponzi scheme indicator'
  ),
  -- ── Explicit content ──
  (
    'xxx',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Explicit content'
  ),
  (
    'porn',
    'word',
    ARRAY ['sms','whatsapp'],
    'block',
    'Explicit content'
  ),
  (
    'nude',
    'word',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Explicit content indicator'
  ),
  (
    'naked pics',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Explicit content'
  ),
  (
    'send nudes',
    'phrase',
    ARRAY ['sms','whatsapp'],
    'block',
    'Explicit content / harassment'
  ),
  -- ── Regex patterns ──
  -- Matches URLs shortened to common phishing domains
  (
    '^.*(bit\.ly|tinyurl\.com|t\.co).*$',
    'regex',
    ARRAY ['sms','whatsapp'],
    'flag',
    'Shortened URL — review for phishing'
  ),
  -- Matches messages asking for any 4-6 digit PIN/OTP code
  (
    '(send|reply|share|give).{0,30}\\b\\d{4,6}\\b',
    'regex',
    ARRAY ['sms','whatsapp'],
    'block',
    'PIN/OTP extraction pattern'
  ) ON CONFLICT (term, term_type) DO NOTHING;