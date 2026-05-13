const { Router } = require('express');
const { supabaseAdmin } = require('../../config/supabase');
const { normalizePhone } = require('../../utils/numberResolver');

const router = Router();

const DLR_STATUS_MAP = {
  '1': 'delivered',  // Delivered to phone
  '2': 'failed',     // Non-Delivered to Phone
  '4': 'sent',       // Queued on SMSC
  '8': 'sent',       // Delivered to SMSC
  '16': 'failed'     // Non-Delivered to SMSC
};

router.get('/dlr', async (req, res) => {
  const { msg_id, id, status, to, from, time } = req.query;

  if (!msg_id) return res.status(400).send('Missing msg_id');

  const mappedStatus = DLR_STATUS_MAP[status] || 'sent';

  const updateData = {
    dlr_status: status,
    dlr_received_at: new Date().toISOString(),
    dlr_raw: { id, status, to, from, time },
    status: mappedStatus
  };

  if (mappedStatus === 'delivered') {
    updateData.delivered_at = new Date().toISOString();
  } else if (mappedStatus === 'failed') {
    updateData.failed_at = new Date().toISOString();
  }

  const { data: message, error: msgError } = await supabaseAdmin
    .from('messages')
    .update(updateData)
    .eq('id', msg_id)
    .select('batch_id, recipient, tenant_id')
    .single();

  if (msgError || !message) {
    console.error('[DLR] message update failed:', msgError?.message);
    return res.status(200).send('OK'); // Always 200 to Kannel
  }

  // Update batch counters — read-then-write to avoid stale arithmetic
  if (message.batch_id) {
    if (mappedStatus === 'delivered') {
      const { data: batch } = await supabaseAdmin
        .from('message_batches')
        .select('total_delivered')
        .eq('id', message.batch_id)
        .single();

      if (batch) {
        await supabaseAdmin
          .from('message_batches')
          .update({ total_delivered: (batch.total_delivered || 0) + 1 })
          .eq('id', message.batch_id);
      }

      // Increment contact delivery stat
      if (message.tenant_id && message.recipient) {
        await supabaseAdmin.rpc('increment_contact_messages_delivered', {
          p_tenant_id: message.tenant_id,
          p_phone: message.recipient
        });
      }
    } else if (mappedStatus === 'failed') {
      const { data: batch } = await supabaseAdmin
        .from('message_batches')
        .select('total_failed')
        .eq('id', message.batch_id)
        .single();

      if (batch) {
        await supabaseAdmin
          .from('message_batches')
          .update({ total_failed: (batch.total_failed || 0) + 1 })
          .eq('id', message.batch_id);
      }
    }
  }

  res.status(200).send('OK');
});

// ---------------------------------------------------------------------------
// Keywords that trigger automatic opt-out or opt-in
// ---------------------------------------------------------------------------
const OPT_OUT_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END', 'OPTOUT', 'OPT-OUT']);
const OPT_IN_KEYWORDS  = new Set(['START', 'YES', 'UNSTOP', 'SUBSCRIBE', 'OPTIN', 'OPT-IN']);

/**
 * Parse Kannel's %t timestamp string into an ISO timestamp.
 * Kannel delivers time as "YYYYMMDDHHMMSS" (14 digits).
 * Returns null if the string cannot be parsed.
 */
function parseKannelTime(t) {
  if (!t) return null;
  const s = String(t).replace(/\D/g, '');
  if (s.length < 12) return null;
  try {
    const d = new Date(
      parseInt(s.slice(0, 4), 10),
      parseInt(s.slice(4, 6), 10) - 1,
      parseInt(s.slice(6, 8), 10),
      parseInt(s.slice(8, 10), 10),
      parseInt(s.slice(10, 12), 10),
      s.length >= 14 ? parseInt(s.slice(12, 14), 10) : 0
    );
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MO — Mobile Originated (inbound / two-way SMS)
// Called by Kannel: GET /api/v1/webhooks/kannel/mo
//   ?from=%p  &to=%P  &text=%b  &smsc=%i  &time=%t
// ---------------------------------------------------------------------------
router.get('/mo', async (req, res) => {
  // Always respond 200 immediately — Kannel does not retry on non-200
  res.status(200).send('OK');

  const { from, to, text, smsc, time } = req.query;
  const log = (msg, data) =>
    console.log(`[MO] ${msg}`, data !== undefined ? JSON.stringify(data) : '');

  if (!from || !text) {
    log('IGNORED — missing from or text', { from, text: !!text });
    return;
  }

  const fromNumber = normalizePhone(from);
  const toNumber   = to || null;
  const keyword    = text.trim().split(/\s+/)[0].toUpperCase().slice(0, 30);
  const isOptOut   = OPT_OUT_KEYWORDS.has(keyword);
  const isOptIn    = OPT_IN_KEYWORDS.has(keyword);

  log('Received', { from: fromNumber, to: toNumber, keyword, isOptOut, isOptIn, smsc });

  // ── Opt-out: mark all tenant contacts with this number as opted out ──────
  if (isOptOut) {
    const { error } = await supabaseAdmin
      .from('contacts')
      .update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString() })
      .eq('phone', fromNumber);

    if (error) log('ERROR — opt-out update failed', error);
    else       log('Opted out', { phone: fromNumber });
  }

  // ── Opt-in: clear opt-out flag across all tenants ───────────────────────
  if (isOptIn) {
    const { error } = await supabaseAdmin
      .from('contacts')
      .update({ sms_opted_out: false, sms_opted_out_at: null })
      .eq('phone', fromNumber);

    if (error) log('ERROR — opt-in update failed', error);
    else       log('Opted in', { phone: fromNumber });
  }

  // ── Resolve contact for linking (first match wins) ───────────────────────
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('id, tenant_id')
    .eq('phone', fromNumber)
    .limit(1)
    .maybeSingle();

  // ── Persist the inbound message ──────────────────────────────────────────
  const { error: insertError } = await supabaseAdmin
    .from('inbound_messages')
    .insert({
      from_number: fromNumber,
      to_number:   toNumber,
      body:        text,
      smsc_id:     smsc   || null,
      smsc_time:   parseKannelTime(time),
      keyword,
      is_opt_out:  isOptOut,
      is_opt_in:   isOptIn,
      contact_id:  contact?.id        || null,
      tenant_id:   contact?.tenant_id || null
    });

  if (insertError) log('ERROR — insert failed', insertError);
  else             log('Stored', { from: fromNumber, keyword });
});

module.exports = router;
