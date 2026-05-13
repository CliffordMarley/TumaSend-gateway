const { supabaseAdmin } = require('../config/supabase');
const { queueSMS, retryFailedMessages } = require('../services/smsService');

// How long a batch can stay in 'processing' before being treated as stuck (ms)
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

let recoveryTimer = null;
let retryTimer = null;

/**
 * Pick up batches that are stuck in 'processing' — i.e. the server crashed
 * or was restarted while queueSMS was running.
 */
async function recoverStuckBatches() {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();

  const { data: stuck, error } = await supabaseAdmin
    .from('message_batches')
    .select('id, environment')
    .eq('status', 'processing')
    .lt('processing_started_at', cutoff)
    .limit(10);

  if (error) {
    console.error('[smsWorker] recovery query error:', error.message);
    return;
  }

  if (!stuck || stuck.length === 0) return;

  console.log(`[smsWorker] recovering ${stuck.length} stuck batch(es)`);
  for (const batch of stuck) {
    queueSMS(batch.id, { environment: batch.environment || 'live' }).catch(err =>
      console.error(`[smsWorker] recovery failed for batch ${batch.id}:`, err.message)
    );
  }
}

/**
 * Re-send messages whose next_retry_at has elapsed.
 */
async function runRetries() {
  retryFailedMessages().catch(err =>
    console.error('[smsWorker] retry run error:', err.message)
  );
}

function startSmsWorker() {
  // Recovery: check every 2 minutes for stuck batches
  recoveryTimer = setInterval(recoverStuckBatches, 2 * 60 * 1000);

  // Retries: check every 60 seconds for messages due for retry
  retryTimer = setInterval(runRetries, 60 * 1000);

  // Run once at startup to pick up anything from before the last restart
  setTimeout(recoverStuckBatches, 5000);
  setTimeout(runRetries, 10000);

  console.log('[smsWorker] started — recovery every 2 min, retries every 60 s');
}

function stopSmsWorker() {
  if (recoveryTimer) clearInterval(recoveryTimer);
  if (retryTimer) clearInterval(retryTimer);
}

module.exports = { startSmsWorker, stopSmsWorker };
