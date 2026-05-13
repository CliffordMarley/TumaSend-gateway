const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { queueSMS } = require('./smsService');

/**
 * Execute a campaign send — shared by the route (immediate) and worker (scheduled).
 * Campaign must be in 'draft' or 'scheduled' status.
 * Throws on any unrecoverable error after marking the campaign 'failed'.
 */
async function executeCampaignSend(campaignId) {
  const log = (msg, data) =>
    console.log(`[campaignService] ${msg}`, data !== undefined ? JSON.stringify(data) : '');

  // 1. Load campaign
  const { data: campaign, error: campError } = await supabaseAdmin
    .from('campaigns')
    .select('id, tenant_id, name, message, sender_id_id, sender_name, contact_list_id, status')
    .eq('id', campaignId)
    .single();

  if (campError || !campaign) throw new Error(`Campaign ${campaignId} not found`);

  if (!['draft', 'scheduled'].includes(campaign.status)) {
    throw new Error(`Campaign is already ${campaign.status}`);
  }

  // 2. Validate sender ID is still approved
  const { data: sender } = await supabaseAdmin
    .from('sender_ids')
    .select('id, sender_id, status, is_global, tenant_id')
    .eq('id', campaign.sender_id_id)
    .single();

  if (!sender || sender.status !== 'approved') {
    await supabaseAdmin.from('campaigns')
      .update({ status: 'failed', metadata: { error: 'Sender ID not approved' } })
      .eq('id', campaignId);
    throw new Error('Sender ID is not approved');
  }

  // 3. Resolve recipients from contact list
  if (!campaign.contact_list_id) {
    await supabaseAdmin.from('campaigns')
      .update({ status: 'failed', metadata: { error: 'No contact list attached' } })
      .eq('id', campaignId);
    throw new Error('Campaign has no contact list');
  }

  const { data: members, error: memberError } = await supabaseAdmin
    .from('contact_list_members')
    .select('contacts!inner(phone)')
    .eq('contact_list_id', campaign.contact_list_id)
    .eq('contacts.sms_opted_out', false)
    .not('contacts.phone', 'is', null);

  if (memberError) {
    log('ERROR — failed to load contact list members', memberError);
    await supabaseAdmin.from('campaigns')
      .update({ status: 'failed', metadata: { error: 'Failed to load contact list' } })
      .eq('id', campaignId);
    throw new Error('Failed to load contact list members');
  }

  const recipients = (members || [])
    .map(m => m.contacts?.phone)
    .filter(Boolean);

  if (recipients.length === 0) {
    await supabaseAdmin.from('campaigns')
      .update({ status: 'failed', metadata: { error: 'No eligible recipients (all opted out or no phone numbers)' } })
      .eq('id', campaignId);
    throw new Error('No eligible recipients in contact list');
  }

  log('Starting campaign', { campaignId, recipients: recipients.length });

  // 4. Mark campaign as running
  await supabaseAdmin.from('campaigns')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      total_recipients: recipients.length
    })
    .eq('id', campaignId);

  // 5. Check SMS credits
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('sms_credits, subscription_tier_id, subscription_tiers(is_postpaid)')
    .eq('id', campaign.tenant_id)
    .single();

  const isPostpaid = tenant?.subscription_tiers?.is_postpaid === true;

  if (!isPostpaid && (tenant?.sms_credits ?? 0) < recipients.length) {
    await supabaseAdmin.from('campaigns')
      .update({
        status: 'failed',
        metadata: { error: `Insufficient SMS credits: have ${tenant?.sms_credits ?? 0}, need ${recipients.length}` }
      })
      .eq('id', campaignId);
    throw new Error(`Insufficient SMS credits: have ${tenant?.sms_credits ?? 0}, need ${recipients.length}`);
  }

  // 6. Create message batch
  const batchId = uuidv4();
  const { error: batchError } = await supabaseAdmin
    .from('message_batches')
    .insert({
      id: batchId,
      tenant_id: campaign.tenant_id,
      sender_id_id: campaign.sender_id_id,
      sender_name: campaign.sender_name,
      channel: 'sms',
      content: campaign.message,
      total_recipients: recipients.length,
      cost_per_message_mwk: 0,
      total_cost_mwk: 0,
      status: 'processing',
      campaign_id: campaignId,
      environment: 'live',
      processing_started_at: new Date().toISOString()
    });

  if (batchError) {
    await supabaseAdmin.from('campaigns')
      .update({ status: 'failed', metadata: { error: 'Failed to create message batch' } })
      .eq('id', campaignId);
    throw new Error(`Failed to create message batch: ${batchError.message}`);
  }

  // 7. Deduct credits atomically
  if (!isPostpaid) {
    const { data: deducted, error: deductError } = await supabaseAdmin.rpc('deduct_sms_credits', {
      p_tenant_id: campaign.tenant_id,
      p_count: recipients.length,
      p_reference_type: 'message_batch',
      p_reference_id: batchId,
      p_description: `Campaign: ${campaign.name}`
    });

    if (deductError || deducted === false) {
      await supabaseAdmin.from('message_batches').update({ status: 'failed' }).eq('id', batchId);
      await supabaseAdmin.from('campaigns')
        .update({ status: 'failed', metadata: { error: 'Failed to deduct SMS credits' } })
        .eq('id', campaignId);
      throw new Error('Failed to deduct SMS credits');
    }
  }

  // 8. Insert message rows
  const { error: msgError } = await supabaseAdmin
    .from('messages')
    .insert(recipients.map(phone => ({
      tenant_id: campaign.tenant_id,
      batch_id: batchId,
      recipient: phone,
      status: 'queued',
      cost_mwk: 0
    })));

  if (msgError) {
    await supabaseAdmin.from('message_batches').update({ status: 'failed' }).eq('id', batchId);
    await supabaseAdmin.from('campaigns')
      .update({ status: 'failed', metadata: { error: 'Failed to queue messages' } })
      .eq('id', campaignId);
    throw new Error(`Failed to insert messages: ${msgError.message}`);
  }

  // 9. Attach batch to campaign
  await supabaseAdmin.from('campaigns')
    .update({
      batch_id: batchId,
      total_credits_used: isPostpaid ? 0 : recipients.length
    })
    .eq('id', campaignId);

  // 10. Fire SMS queue (non-blocking)
  queueSMS(batchId, { environment: 'live' }).catch(err =>
    log('queueSMS error', { campaignId, batchId, error: err.message })
  );

  log('Campaign dispatched', { campaignId, batchId, recipients: recipients.length });
  return { batchId, totalRecipients: recipients.length };
}

module.exports = { executeCampaignSend };
