const { Client, LocalAuth } = require('whatsapp-web.js');
const { supabaseAdmin } = require('../config/supabase');
const { getRedisClient } = require('../config/redis');

const SESSIONS_PATH = process.env.WHATSAPP_SESSIONS_PATH || './sessions';
const MAX_CLIENTS = parseInt(process.env.WHATSAPP_MAX_CLIENTS || '50', 10);

// Map<tenantId, Client>
const clients = new Map();

// Map<tenantId, boolean> — prevents concurrent initClient calls for the same tenant
const initializing = new Set();

async function updateSessionStatus(tenantId, fields) {
  await supabaseAdmin
    .from('whatsapp_sessions')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId);
}

async function forwardToTenantWebhook(tenantId, payload) {
  try {
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('webhook_url')
      .eq('id', tenantId)
      .single();

    if (!tenant?.webhook_url) return;

    const axios = require('axios');
    await axios.post(tenant.webhook_url, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Webhook delivery failures are non-fatal
  }
}

function wireEvents(client, tenantId) {
  const redis = getRedisClient();

  client.on('qr', async (qr) => {
    console.log(`[WhatsApp] QR generated for tenant ${tenantId}`);
    await redis.set(`wa:qr:${tenantId}`, qr, 'EX', 90);
    await updateSessionStatus(tenantId, { status: 'pending_qr' });
  });

  client.on('ready', async () => {
    const info = client.info;
    const phoneNumber = info?.wid?.user || null;
    const displayName = info?.pushname || null;
    console.log(`[WhatsApp] Client ready for tenant ${tenantId} (${phoneNumber})`);

    await redis.del(`wa:qr:${tenantId}`);
    await updateSessionStatus(tenantId, {
      status: 'ready',
      phone_number: phoneNumber,
      display_name: displayName,
      last_connected_at: new Date().toISOString(),
    });
  });

  client.on('message', async (msg) => {
    try {
      const from = msg.from.replace('@c.us', '').replace('@g.us', '');
      const body = msg.body;
      const timestamp = new Date(msg.timestamp * 1000).toISOString();

      await supabaseAdmin.from('inbound_messages').insert({
        tenant_id: tenantId,
        channel: 'whatsapp',
        from_number: from,
        message: body,
        raw_payload: {
          id: msg.id?.id,
          from: msg.from,
          to: msg.to,
          body: msg.body,
          type: msg.type,
          timestamp: msg.timestamp,
          hasMedia: msg.hasMedia,
        },
        received_at: timestamp,
      });

      forwardToTenantWebhook(tenantId, {
        event: 'message.received',
        channel: 'whatsapp',
        from: from,
        message: body,
        timestamp,
      });
    } catch (err) {
      console.error(`[WhatsApp] Failed to store inbound message for tenant ${tenantId}:`, err.message);
    }
  });

  client.on('message_ack', async (msg, ack) => {
    // ack: 1=sent, 2=received(delivered), 3=read
    const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read' };
    const newStatus = statusMap[ack];
    if (!newStatus) return;

    try {
      await supabaseAdmin
        .from('messages')
        .update({
          status: newStatus,
          ...(newStatus === 'delivered' && { delivered_at: new Date().toISOString() }),
        })
        .eq('provider_message_id', msg.id?.id)
        .eq('tenant_id', tenantId);
    } catch (err) {
      console.error(`[WhatsApp] message_ack update failed for tenant ${tenantId}:`, err.message);
    }
  });

  client.on('disconnected', async (reason) => {
    console.warn(`[WhatsApp] Client disconnected for tenant ${tenantId}: ${reason}`);
    clients.delete(tenantId);
    await updateSessionStatus(tenantId, { status: 'disconnected' });
  });

  client.on('auth_failure', async (msg) => {
    console.error(`[WhatsApp] Auth failure for tenant ${tenantId}: ${msg}`);
    clients.delete(tenantId);
    await updateSessionStatus(tenantId, { status: 'disconnected' });
  });
}

async function initClient(tenantId) {
  if (clients.has(tenantId)) return clients.get(tenantId);

  if (initializing.has(tenantId)) {
    // Wait up to 30s for concurrent init to complete
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (clients.has(tenantId)) return clients.get(tenantId);
    }
    throw new Error(`Timed out waiting for client init for tenant ${tenantId}`);
  }

  if (clients.size >= MAX_CLIENTS) {
    throw new Error(`Maximum WhatsApp client limit (${MAX_CLIENTS}) reached`);
  }

  initializing.add(tenantId);

  try {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: tenantId,
        dataPath: SESSIONS_PATH,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    wireEvents(client, tenantId);
    clients.set(tenantId, client);

    await updateSessionStatus(tenantId, { status: 'initializing' });
    await client.initialize();

    return client;
  } catch (err) {
    clients.delete(tenantId);
    await updateSessionStatus(tenantId, { status: 'disconnected' });
    throw err;
  } finally {
    initializing.delete(tenantId);
  }
}

function getClient(tenantId) {
  return clients.get(tenantId) || null;
}

async function destroyClient(tenantId) {
  const client = clients.get(tenantId);
  if (!client) return;

  clients.delete(tenantId);

  try {
    await client.logout();
  } catch {
    // logout may fail if already disconnected
  }

  try {
    await client.destroy();
  } catch {
    // destroy may fail if already destroyed
  }

  await updateSessionStatus(tenantId, { status: 'disconnected', phone_number: null, display_name: null });

  // Clean up Redis QR key if present
  const redis = getRedisClient();
  await redis.del(`wa:qr:${tenantId}`);
}

function getAllActiveIds() {
  return Array.from(clients.keys());
}

module.exports = { initClient, getClient, destroyClient, getAllActiveIds };
