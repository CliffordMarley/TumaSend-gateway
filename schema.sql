-- Tuma Platform (Telecom Grade: Live & Test Modes) Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- 1. CORE & TENANT MANAGEMENT
-- ==========================================

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  business_type TEXT,
  registration_number TEXT,
  kyc_status TEXT DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Users mapped directly to Firebase Auth UIDs
CREATE TABLE users (
  id TEXT PRIMARY KEY, -- Firebase UID
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'developer' CHECK (role IN ('admin', 'developer', 'finance', 'super_admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API Keys differentiated by mode (Test vs Live)
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  key TEXT UNIQUE NOT NULL, -- e.g., tuma_test_xxx or tuma_live_xxx
  name TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  rate_limit INTEGER DEFAULT 100, -- Messages per second
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 2. BILLING & WALLETS (Test & Live Isolation)
-- ==========================================

-- Tenants have both a Test wallet and a Live wallet
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  balance NUMERIC DEFAULT 0,
  currency TEXT DEFAULT 'MWK',
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, mode)
);

CREATE OR REPLACE FUNCTION create_wallets()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO wallets (tenant_id, mode) VALUES (NEW.id, 'live');
  INSERT INTO wallets (tenant_id, mode, balance) VALUES (NEW.id, 'test', 1000); -- Give 1000 test credits
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_wallet_trigger
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION create_wallets();

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id),
  mode TEXT DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  amount NUMERIC NOT NULL,
  type TEXT CHECK (type IN ('topup', 'deduction', 'refund')), 
  idempotency_key TEXT UNIQUE,
  transaction_reference TEXT UNIQUE,
  callback_body JSONB,
  provider_response JSONB,
  invoice_id UUID,
  status TEXT DEFAULT 'pending',
  provider TEXT, -- e.g., PayChangu
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Pricing Engine
CREATE TABLE pricing (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator TEXT NOT NULL, -- e.g., TNM, AIRTEL, DEFAULT
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'ussd')),
  cost NUMERIC NOT NULL,
  currency TEXT DEFAULT 'MWK',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(operator, channel)
);

-- ==========================================
-- 3. CHANNELS & IDENTITIES
-- ==========================================

CREATE TABLE sender_ids (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE shortcodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  shortcode TEXT NOT NULL,
  type TEXT CHECK (type IN ('sms', 'ussd')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 4. PHONEBOOK (Contact Management)
-- ==========================================

CREATE TABLE contact_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  group_id UUID REFERENCES contact_groups(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(group_id, phone_number)
);

-- ==========================================
-- 5. MESSAGING ENGINE (Batches & Messages)
-- ==========================================

CREATE TABLE message_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  total_messages INTEGER NOT NULL,
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES message_batches(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id),
  mode TEXT DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  sender_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  operator TEXT, 
  smsc_id TEXT, -- Kannel SMSC connection
  provider_message_id TEXT, -- Kannel DLR matching ID
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  cost NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE message_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  response_code TEXT,
  provider_reference TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- 6. INTEGRATION & COMPLIANCE
-- ==========================================

CREATE TABLE ussd_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  shortcode_id UUID REFERENCES shortcodes(id),
  mode TEXT DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  session_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  network TEXT NOT NULL,
  state JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('sms.dlr', 'whatsapp.dlr', 'sms.incoming', 'ussd.callback')),
  url TEXT NOT NULL,
  secret TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE use_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, phone_number)
);

-- ==========================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ==========================================

-- Enable RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE shortcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ussd_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE use_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE blacklist ENABLE ROW LEVEL SECURITY;

-- Base Tenant Policy Macro (using Firebase UID)
CREATE POLICY "Tenant access" ON tenants FOR SELECT USING ( id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Users within tenant" ON users FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "API Keys access" ON api_keys FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Wallets access" ON wallets FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Transactions access" ON transactions FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Sender IDs access" ON sender_ids FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Shortcodes access" ON shortcodes FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "WhatsApp Templates access" ON whatsapp_templates FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Contact Groups access" ON contact_groups FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Contacts access" ON contacts FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Message Batches access" ON message_batches FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Messages access" ON messages FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Message Logs access" ON message_logs FOR SELECT USING ( message_id IN (SELECT id FROM messages WHERE tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub')) );
CREATE POLICY "USSD Sessions access" ON ussd_sessions FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Webhooks access" ON webhooks FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Use Cases access" ON use_cases FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );
CREATE POLICY "Blacklist access" ON blacklist FOR SELECT USING ( tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.jwt()->>'sub') );

-- Anyone authenticated can view public pricing
CREATE POLICY "Public Pricing access" ON pricing FOR SELECT USING ( true );
