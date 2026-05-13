const { Router } = require('express');
const { supabaseAdmin } = require('../../config/supabase');

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

module.exports = router;
