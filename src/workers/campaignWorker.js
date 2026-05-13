const { supabaseAdmin } = require('../config/supabase');
const { executeCampaignSend } = require('../services/campaignService');

let schedulerTimer = null;
let syncTimer = null;

/**
 * Fire any scheduled campaigns whose scheduled_at has elapsed.
 */
async function processScheduledCampaigns() {
  const now = new Date().toISOString();

  const { data: due, error } = await supabaseAdmin
    .from('campaigns')
    .select('id, name, tenant_id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .limit(10);

  if (error) {
    console.error('[campaignWorker] schedule query error:', error.message);
    return;
  }

  if (!due || due.length === 0) return;

  console.log(`[campaignWorker] dispatching ${due.length} scheduled campaign(s)`);

  for (const campaign of due) {
    console.log(`[campaignWorker] starting campaign ${campaign.id} — "${campaign.name}"`);
    executeCampaignSend(campaign.id).catch(err =>
      console.error(`[campaignWorker] campaign ${campaign.id} failed: ${err.message}`)
    );
  }
}

/**
 * Sync delivery stats from message_batches back onto running campaigns.
 * Marks completed/failed campaigns once their batch reaches a terminal state.
 */
async function syncRunningCampaigns() {
  const { data: running, error } = await supabaseAdmin
    .from('campaigns')
    .select('id, batch_id')
    .eq('status', 'running')
    .not('batch_id', 'is', null);

  if (error) {
    console.error('[campaignWorker] sync query error:', error.message);
    return;
  }

  if (!running || running.length === 0) return;

  for (const campaign of running) {
    const { data: batch } = await supabaseAdmin
      .from('message_batches')
      .select('status, total_sent, total_delivered, total_failed')
      .eq('id', campaign.batch_id)
      .single();

    if (!batch) continue;

    const updates = {
      total_sent: batch.total_sent || 0,
      total_delivered: batch.total_delivered || 0,
      total_failed: batch.total_failed || 0
    };

    // Transition to terminal state when the batch is done
    if (['completed', 'partial', 'failed'].includes(batch.status)) {
      updates.status = batch.status === 'failed' ? 'failed' : 'completed';
      updates.completed_at = new Date().toISOString();
    }

    await supabaseAdmin.from('campaigns').update(updates).eq('id', campaign.id);
  }
}

function startCampaignWorker() {
  // Check for due scheduled campaigns every minute
  schedulerTimer = setInterval(() => {
    processScheduledCampaigns().catch(err =>
      console.error('[campaignWorker] scheduler error:', err.message)
    );
  }, 60 * 1000);

  // Sync delivery stats for running campaigns every 2 minutes
  syncTimer = setInterval(() => {
    syncRunningCampaigns().catch(err =>
      console.error('[campaignWorker] sync error:', err.message)
    );
  }, 2 * 60 * 1000);

  // Initial runs after server startup
  setTimeout(() => {
    processScheduledCampaigns().catch(err =>
      console.error('[campaignWorker] startup scheduler error:', err.message)
    );
  }, 5000);

  setTimeout(() => {
    syncRunningCampaigns().catch(err =>
      console.error('[campaignWorker] startup sync error:', err.message)
    );
  }, 15000);

  console.log('[campaignWorker] started — scheduler every 60 s, stats sync every 2 min');
}

function stopCampaignWorker() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (syncTimer) clearInterval(syncTimer);
}

module.exports = { startCampaignWorker, stopCampaignWorker };
