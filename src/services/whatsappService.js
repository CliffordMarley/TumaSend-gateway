const { supabaseAdmin } = require('../config/supabase');
const { getClient } = require('./whatsappClientManager');

/**
 * Format a Malawi phone number to the WhatsApp chat ID format.
 * Input: '265991234567' → Output: '265991234567@c.us'
 */
function toWhatsAppId(phone) {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

/**
 * Deduct WhatsApp credits from the tenant's balance.
 * Returns { success, remaining_whatsapp_credits } or throws on DB error.
 */
async function deductWhatsAppCredits(tenantId, count, batchId) {
  const { data: deducted, error } = await supabaseAdmin.rpc('deduct_whatsapp_credits', {
    p_tenant_id: tenantId,
    p_count: count,
    p_reference_type: 'message_batch',
    p_reference_id: batchId,
    p_description: `WhatsApp batch to ${count} recipient${count === 1 ? '' : 's'}`,
  });

  if (error) throw new Error(`Credit deduction DB error: ${error.message}`);

  return deducted === true;
}

/**
 * Send a WhatsApp message to a single recipient.
 * Updates the message record in the DB with the result.
 */
async function sendWhatsAppMessage(tenantId, messageId, recipient, content) {
  const client = getClient(tenantId);

  if (!client) {
    await supabaseAdmin
      .from('messages')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        error_message: 'WhatsApp session not connected',
      })
      .eq('id', messageId);
    return { ok: false, error: 'session_not_connected' };
  }

  try {
    await supabaseAdmin
      .from('messages')
      .update({ status: 'sending', sent_at: new Date().toISOString() })
      .eq('id', messageId);

    const waId = toWhatsAppId(recipient);
    const sentMsg = await client.sendMessage(waId, content);

    await supabaseAdmin
      .from('messages')
      .update({
        status: 'sent',
        provider: 'wwebjs',
        provider_message_id: sentMsg.id?.id || null,
        provider_response: { _serialized: sentMsg.id?._serialized },
      })
      .eq('id', messageId);

    return { ok: true, messageId: sentMsg.id?.id };
  } catch (err) {
    const retryCount = 0;
    await supabaseAdmin
      .from('messages')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        error_message: err.message,
        retry_count: retryCount + 1,
        next_retry_at:
          retryCount < 3
            ? new Date(Date.now() + 60000 * Math.pow(2, retryCount)).toISOString()
            : null,
      })
      .eq('id', messageId);

    return { ok: false, error: err.message };
  }
}

module.exports = { sendWhatsAppMessage, deductWhatsAppCredits };
