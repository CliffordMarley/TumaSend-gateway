const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');
const { rateLimit } = require('../middlewares/rateLimit');
const { requireScope } = require('../middlewares/requireScope');
const { queueSMS } = require('../services/smsService');
const { normalizePhone, isValidMalawiPhone } = require('../utils/numberResolver');

const router = Router();

async function upsertContactsFromRecipients(tenantId, phones, batchId) {
  if (!phones || phones.length === 0) return;
  const now = new Date().toISOString();

  // Insert new contacts (source='api', first_batch_id set to this send).
  // Existing contacts are left untouched (ignoreDuplicates: true keeps their original source/batch).
  await supabaseAdmin
    .from('contacts')
    .upsert(
      phones.map(phone => ({
        tenant_id: tenantId,
        phone,
        source: 'api',
        first_batch_id: batchId,
        last_contacted_at: now
      })),
      { onConflict: 'tenant_id,phone', ignoreDuplicates: true }
    );

  // Increment messages_sent + refresh last_contacted_at for ALL (new + existing)
  await supabaseAdmin.rpc('increment_contact_messages_sent', {
    p_tenant_id: tenantId,
    p_phones: phones,
    p_contacted_at: now
  });
}

/**
 * @swagger
 * /api/v1/send/sms:
 *   post:
 *     summary: Send SMS messages
 *     description: |
 *       Sends an SMS to one or more Malawi phone numbers.
 *       The API key must have the `sms:send` scope and be bound to an approved sender ID.
 *       SMS credits are deducted atomically (1 credit per SMS). Enterprise tenants are postpaid — no credit check.
 *       Recipients are automatically normalized to `265XXXXXXXXX` format.
 *
 *       **Contact capture:** Every unique recipient is automatically upserted into the tenant's
 *       contact book (`source = api`). This applies to both live and test-environment keys — contacts
 *       accumulate during testing and are immediately available for campaigns and contact lists.
 *     tags:
 *       - Messaging
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - from
 *               - recipients
 *               - message
 *             properties:
 *               from:
 *                 type: string
 *                 description: Sender ID — must match the sender ID bound to the API key
 *                 example: Machawi
 *               recipients:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of Malawi phone numbers (any local format accepted)
 *                 example: ["265887716765", "0991234567"]
 *               message:
 *                 type: string
 *                 description: Message content
 *                 example: Hello TNM
 *     responses:
 *       200:
 *         description: Batch accepted and queued for sending
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 batch_id:
 *                   type: string
 *                 total_recipients:
 *                   type: integer
 *                 sms_credits_remaining:
 *                   type: integer
 *                   description: Remaining credits after deduction (null for Enterprise/postpaid)
 *                 status:
 *                   type: string
 *                   example: processing
 *       400:
 *         description: Invalid request (missing fields, no valid recipients)
 *       402:
 *         description: Insufficient SMS credits
 *       403:
 *         description: Sender ID mismatch
 *       401:
 *         description: Invalid or missing API key
 */
router.post('/sms', apiKeyAuth, rateLimit, requireScope('sms:send'), async (req, res) => {
  const { from, recipients, message } = req.body;
  const { tenantId, senderIdId, senderName, apiKeyId, environment } = req.apiKey;
  const isTest = environment === 'test';

  if (!from || !message || message.trim().length === 0) {
    return res.status(400).json({ error: 'from and message are required' });
  }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients must be a non-empty array' });
  }

  if (from !== senderName) {
    return res.status(403).json({
      error: 'Sender ID mismatch',
      expected: senderName
    });
  }

  const normalizedRecipients = [];
  const invalidRecipients = [];

  for (const recipient of recipients) {
    const phone = normalizePhone(String(recipient));
    if (isValidMalawiPhone(phone)) {
      normalizedRecipients.push(phone);
    } else {
      invalidRecipients.push(String(recipient));
    }
  }

  if (normalizedRecipients.length === 0) {
    return res.status(400).json({
      error: 'No valid Malawi recipients',
      invalid_recipients: invalidRecipients
    });
  }

  const numSms = normalizedRecipients.length;

  // Test keys never touch credits
  let isPostpaid = isTest;
  if (!isTest) {
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('sms_credits, subscription_tier_id, subscription_tiers(is_postpaid)')
      .eq('id', tenantId)
      .single();

    isPostpaid = tenant?.subscription_tiers?.is_postpaid === true;

    if (!isPostpaid && (!tenant || tenant.sms_credits < numSms)) {
      return res.status(402).json({
        error: 'Insufficient SMS credits',
        required: numSms,
        available: tenant?.sms_credits || 0
      });
    }
  }

  const batchId = uuidv4();
  const requestId = uuidv4();

  const { error: batchError } = await supabaseAdmin
    .from('message_batches')
    .insert({
      id: batchId,
      tenant_id: tenantId,
      api_key_id: apiKeyId,
      sender_id_id: senderIdId,
      channel: 'sms',
      sender_name: senderName,
      content: message,
      total_recipients: numSms,
      cost_per_message_mwk: 0,
      total_cost_mwk: 0,
      status: 'processing',
      request_ip: req.ip,
      request_user_agent: req.headers['user-agent'],
      request_id: requestId,
      processing_started_at: new Date().toISOString()
    });

  if (batchError) {
    console.error('Batch insert error:', JSON.stringify(batchError));
    return res.status(500).json({ error: 'Failed to create batch' });
  }

  if (!isPostpaid) {
    const { data: deducted, error: deductError } = await supabaseAdmin.rpc('deduct_sms_credits', {
      p_tenant_id: tenantId,
      p_count: numSms,
      p_reference_type: 'message_batch',
      p_reference_id: batchId,
      p_description: `SMS batch to ${numSms} recipients`
    });

    if (deductError || deducted === false) {
      await supabaseAdmin
        .from('message_batches')
        .update({ status: 'failed' })
        .eq('id', batchId);
      return res.status(402).json({ error: 'Failed to deduct SMS credits' });
    }
  }

  const { error: messagesError } = await supabaseAdmin
    .from('messages')
    .insert(normalizedRecipients.map(recipient => ({
      tenant_id: tenantId,
      batch_id: batchId,
      recipient,
      status: 'queued',
      cost_mwk: 0
    })));

  if (messagesError) {
    console.error('Messages insert error:', JSON.stringify(messagesError));
    return res.status(500).json({ error: 'Failed to create messages' });
  }

  queueSMS(batchId, { environment });

  // Upsert recipients as contacts (fire-and-forget — never block the response)
  upsertContactsFromRecipients(tenantId, normalizedRecipients, batchId).catch(err =>
    console.error('Contact upsert error:', err.message)
  );

  let smsCreditsRemaining = null;
  if (!isTest && !isPostpaid) {
    const { data: updatedTenant } = await supabaseAdmin
      .from('tenants')
      .select('sms_credits')
      .eq('id', tenantId)
      .single();
    smsCreditsRemaining = updatedTenant?.sms_credits ?? null;
  }

  return res.status(200).json({
    success: true,
    batch_id: batchId,
    environment,
    total_recipients: numSms,
    invalid_recipients: invalidRecipients.length > 0 ? invalidRecipients : undefined,
    sms_credits_remaining: smsCreditsRemaining,
    status: 'processing',
    ...(isTest && { test_mode: true, note: 'No credits deducted — test environment' })
  });
});

module.exports = router;
