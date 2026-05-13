-- =============================================================
-- Inbound SMS (MO — Mobile Originated / Two-Way)
-- =============================================================
-- Stores every inbound message received from operators via
-- Kannel.  Opt-outs (STOP) and opt-ins (START) are applied
-- immediately to the contacts table by the Express handler;
-- this table is the permanent audit trail.
-- =============================================================

CREATE TABLE IF NOT EXISTS inbound_messages (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The sender (the subscriber's handset)
  from_number  TEXT        NOT NULL,

  -- The shortcode / virtual number the message was sent TO
  to_number    TEXT        NULL,

  -- Message content
  body         TEXT        NOT NULL,

  -- Which SMSC/operator received it (e.g. 'tnm', 'airtel')
  smsc_id      TEXT        NULL,

  -- Timestamp as reported by the operator
  smsc_time    TIMESTAMPTZ NULL,

  -- First word of the message, uppercased — used for keyword routing
  keyword      TEXT        NULL,

  -- Opt-out flag: set when keyword is STOP / UNSUBSCRIBE / QUIT / CANCEL / END
  is_opt_out   BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Opt-in flag: set when keyword is START / YES / UNSTOP
  is_opt_in    BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Link to the matching contact record, if one exists
  contact_id   UUID        NULL REFERENCES contacts(id) ON DELETE SET NULL,

  -- Tenant the matched contact belongs to (nullable — may be platform-wide)
  tenant_id    UUID        NULL REFERENCES tenants(id) ON DELETE SET NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Look up all replies from a specific number quickly
CREATE INDEX IF NOT EXISTS idx_inbound_from_number
  ON inbound_messages(from_number);

-- Chronological feed (newest first)
CREATE INDEX IF NOT EXISTS idx_inbound_created_at
  ON inbound_messages(created_at DESC);

-- Filter by keyword (e.g. find all STOP messages)
CREATE INDEX IF NOT EXISTS idx_inbound_keyword
  ON inbound_messages(keyword)
  WHERE keyword IS NOT NULL;

-- Fast opt-out audit query
CREATE INDEX IF NOT EXISTS idx_inbound_opt_out
  ON inbound_messages(is_opt_out)
  WHERE is_opt_out = TRUE;

-- Per-tenant inbox
CREATE INDEX IF NOT EXISTS idx_inbound_tenant_id
  ON inbound_messages(tenant_id)
  WHERE tenant_id IS NOT NULL;
