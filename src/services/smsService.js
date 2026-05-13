const axios = require('axios');
const { supabaseAdmin } = require('../config/supabase');

const KANNEL_URL  = process.env.KANNEL_HOST     || '127.0.0.1';
const KANNEL_PORT = process.env.KANNEL_PORT     || '13013';
const KANNEL_USER = process.env.KANNEL_USERNAME || 'api';
const KANNEL_PASS = process.env.KANNEL_PASSWORD || 'password';
const MOCK_PORT   = process.env.PORT            || '3000';

function kannelEndpoint(isTest) {
  if (isTest) return `http://127.0.0.1:${MOCK_PORT}/cgi-bin/sendsms`;
  return `http://${KANNEL_URL}:${KANNEL_PORT}/cgi-bin/sendsms`;
}

async function queueSMS(batchId, options = {}) {
  const isTest = options.environment === 'test';

  const { data: batch, error } = await supabaseAdmin
    .from('message_batches')
    .select('*, messages(*)')
    .eq('id', batchId)
    .single();

  if (error || !batch) {
    console.error(`[smsWorker] batch ${batchId} not found:`, error?.message);
    return;
  }

  let sentCount = 0;
  let failedCount = 0;

  for (const message of batch.messages) {
    // Skip messages already past 'queued' state (idempotent re-runs)
    if (message.status !== 'queued' && message.status !== 'failed') continue;

    try {
      await supabaseAdmin
        .from('messages')
        .update({ status: 'sending', sent_at: new Date().toISOString() })
        .eq('id', message.id);

      const response = await axios.get(kannelEndpoint(isTest), {
        params: {
          username: KANNEL_USER,
          password: KANNEL_PASS,
          to: message.recipient,
          from: batch.sender_name,
          text: batch.content,
          'dlr-mask': 31,
          'dlr-url': `${process.env.API_BASE_URL || 'http://127.0.0.1:3000'}/api/v1/webhooks/kannel/dlr?msg_id=${message.id}&id=%I&status=%d&to=%p&from=%P&time=%t`
        }
      });

      const kannelId = response.data.match(/(\d+)/)?.[1] || null;

      await supabaseAdmin
        .from('messages')
        .update({
          status: 'sent',
          provider: 'kannel',
          provider_message_id: kannelId,
          provider_response: { raw: response.data }
        })
        .eq('id', message.id);

      sentCount++;
    } catch (err) {
      const retryCount = (message.retry_count || 0) + 1;
      await supabaseAdmin
        .from('messages')
        .update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          error_message: err.message,
          retry_count: retryCount,
          next_retry_at: retryCount <= 3
            ? new Date(Date.now() + 60000 * Math.pow(2, retryCount - 1)).toISOString()
            : null
        })
        .eq('id', message.id);

      failedCount++;
    }
  }

  const total = batch.messages.length;
  const finalStatus = failedCount === total ? 'failed'
    : failedCount > 0 ? 'partial'
    : 'completed';

  await supabaseAdmin
    .from('message_batches')
    .update({
      total_sent: sentCount,
      total_failed: failedCount,
      status: finalStatus,
      completed_at: new Date().toISOString()
    })
    .eq('id', batchId);
}

/**
 * Retry individual failed messages whose next_retry_at has elapsed.
 */
async function retryFailedMessages() {
  const { data: messages, error } = await supabaseAdmin
    .from('messages')
    .select('id, batch_id, recipient, retry_count')
    .eq('status', 'failed')
    .lte('next_retry_at', new Date().toISOString())
    .not('next_retry_at', 'is', null)
    .lt('retry_count', 3)
    .limit(50);

  if (error || !messages || messages.length === 0) return;

  // Group by batch so we can look up sender_name/content once per batch
  const byBatch = {};
  for (const msg of messages) {
    if (!byBatch[msg.batch_id]) byBatch[msg.batch_id] = [];
    byBatch[msg.batch_id].push(msg);
  }

  for (const [batchId, msgs] of Object.entries(byBatch)) {
    const { data: batch } = await supabaseAdmin
      .from('message_batches')
      .select('sender_name, content, environment')
      .eq('id', batchId)
      .single();

    if (!batch) continue;

    const isTest = batch.environment === 'test';

    for (const message of msgs) {
      try {
        await supabaseAdmin
          .from('messages')
          .update({ status: 'sending', sent_at: new Date().toISOString() })
          .eq('id', message.id);

        const response = await axios.get(kannelEndpoint(isTest), {
          params: {
            username: KANNEL_USER,
            password: KANNEL_PASS,
            to: message.recipient,
            from: batch.sender_name,
            text: batch.content,
            'dlr-mask': 31,
            'dlr-url': `${process.env.API_BASE_URL || 'http://127.0.0.1:3000'}/api/v1/webhooks/kannel/dlr?msg_id=${message.id}&id=%I&status=%d&to=%p&from=%P&time=%t`
          }
        });

        const kannelId = response.data.match(/(\d+)/)?.[1] || null;

        await supabaseAdmin
          .from('messages')
          .update({
            status: 'sent',
            provider: 'kannel',
            provider_message_id: kannelId,
            provider_response: { raw: response.data }
          })
          .eq('id', message.id);

      } catch (err) {
        const retryCount = (message.retry_count || 0) + 1;
        await supabaseAdmin
          .from('messages')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
            error_message: err.message,
            retry_count: retryCount,
            next_retry_at: retryCount <= 3
              ? new Date(Date.now() + 60000 * Math.pow(2, retryCount - 1)).toISOString()
              : null
          })
          .eq('id', message.id);
      }
    }
  }
}

module.exports = { queueSMS, retryFailedMessages };
