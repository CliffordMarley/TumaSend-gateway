const { supabaseAdmin } = require('../config/supabase');
const { initClient, getAllActiveIds } = require('../services/whatsappClientManager');

let healthTimer = null;

/**
 * On startup, rehydrate sessions for all tenants that were previously connected.
 * LocalAuth persists session files on disk, so these clients can reconnect
 * without requiring a new QR scan.
 */
async function rehydrateSessions() {
  const { data: sessions, error } = await supabaseAdmin
    .from('whatsapp_sessions')
    .select('tenant_id, status')
    .in('status', ['ready', 'disconnected']);

  if (error) {
    console.error('[whatsappWorker] Failed to load sessions:', error.message);
    return;
  }

  if (!sessions || sessions.length === 0) {
    console.log('[whatsappWorker] No sessions to rehydrate');
    return;
  }

  console.log(`[whatsappWorker] Rehydrating ${sessions.length} session(s)...`);

  for (const session of sessions) {
    initClient(session.tenant_id).catch(err => {
      console.error(`[whatsappWorker] Rehydration failed for tenant ${session.tenant_id}:`, err.message);
    });
  }
}

/**
 * Periodic health check: detect clients that are in-memory but DB says disconnected,
 * and attempt to reconnect them.
 */
async function healthCheck() {
  const activeIds = getAllActiveIds();
  if (activeIds.length === 0) return;

  const { data: sessions } = await supabaseAdmin
    .from('whatsapp_sessions')
    .select('tenant_id, status')
    .in('tenant_id', activeIds);

  if (!sessions) return;

  for (const session of sessions) {
    if (session.status === 'disconnected') {
      console.log(`[whatsappWorker] Reconnecting tenant ${session.tenant_id}`);
      initClient(session.tenant_id).catch(err => {
        console.error(`[whatsappWorker] Reconnect failed for tenant ${session.tenant_id}:`, err.message);
      });
    }
  }
}

function startWhatsappWorker() {
  // Rehydrate after a short delay to let the server finish booting
  setTimeout(rehydrateSessions, 8000);

  // Health check every 5 minutes
  healthTimer = setInterval(healthCheck, 5 * 60 * 1000);

  console.log('[whatsappWorker] started — rehydrating sessions in 8s, health-check every 5 min');
}

function stopWhatsappWorker() {
  if (healthTimer) clearInterval(healthTimer);
}

module.exports = { startWhatsappWorker, stopWhatsappWorker };
