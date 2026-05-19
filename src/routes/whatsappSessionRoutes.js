const { Router } = require('express');
const QRCode = require('qrcode');
const { supabaseAdmin } = require('../config/supabase');
const { getRedisClient } = require('../config/redis');
const { initClient, destroyClient, getClient } = require('../services/whatsappClientManager');

const router = Router();

// All routes here are protected by systemKeyAuth (applied in app.js at mount time).
// The dashboard passes tenant_id in the request body or a dedicated header.

function getTenantId(req) {
  return req.body?.tenant_id || req.headers['x-tenant-id'];
}

// ─────────────────────────────────────────────
// POST /api/v1/whatsapp/sessions
// Start a new WhatsApp session for a tenant (triggers QR flow).
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/whatsapp/sessions:
 *   post:
 *     summary: Start a WhatsApp session
 *     description: |
 *       Initialises a new WhatsApp client for the tenant and starts the QR authentication flow.
 *       Poll `GET /api/v1/whatsapp/sessions/qr` to retrieve the QR code for scanning.
 *
 *       **Note:** The QR code expires in ~90 seconds. If it expires before scanning,
 *       a new one is automatically generated and stored in Redis.
 *     tags:
 *       - WhatsApp Sessions
 *     security:
 *       - SystemKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tenant_id
 *             properties:
 *               tenant_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Session initialisation started
 *       409:
 *         description: Session already active
 */
router.post('/sessions', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });

  const existingClient = getClient(tenantId);
  if (existingClient) {
    return res.status(409).json({ error: 'A WhatsApp session is already active for this tenant' });
  }

  const { data: existingSession } = await supabaseAdmin
    .from('whatsapp_sessions')
    .select('status')
    .eq('tenant_id', tenantId)
    .single();

  if (existingSession && existingSession.status === 'ready') {
    return res.status(409).json({ error: 'A connected WhatsApp session already exists. Disconnect it first.' });
  }

  // Upsert the session row so we always have a row to update
  await supabaseAdmin
    .from('whatsapp_sessions')
    .upsert({ tenant_id: tenantId, status: 'initializing' }, { onConflict: 'tenant_id' });

  // Start init in background — client events will update the DB row as they fire
  initClient(tenantId).catch(err => {
    console.error(`[WhatsApp] initClient failed for tenant ${tenantId}:`, err.message);
  });

  return res.json({ success: true, status: 'initializing', message: 'QR code will be available shortly. Poll GET /api/v1/whatsapp/sessions/qr' });
});

// ─────────────────────────────────────────────
// GET /api/v1/whatsapp/sessions/qr
// Return base64 PNG of the QR code for the tenant.
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/whatsapp/sessions/qr:
 *   get:
 *     summary: Get WhatsApp QR code
 *     description: |
 *       Returns the current QR code as a base64 PNG data URL.
 *       Returns 404 if no QR is available (not yet generated or session already ready).
 *       Returns 200 with `{ status: "ready" }` if the session is already authenticated.
 *     tags:
 *       - WhatsApp Sessions
 *     security:
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: tenant_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: QR code as base64 PNG or session already ready
 *       404:
 *         description: No QR code available yet
 */
router.get('/sessions/qr', async (req, res) => {
  const tenantId = req.query.tenant_id || req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });

  // If client is already ready, no QR needed
  const client = getClient(tenantId);
  if (client) {
    const { data: session } = await supabaseAdmin
      .from('whatsapp_sessions')
      .select('status, phone_number, display_name')
      .eq('tenant_id', tenantId)
      .single();

    if (session?.status === 'ready') {
      return res.json({ status: 'ready', phone_number: session.phone_number, display_name: session.display_name });
    }
  }

  const redis = getRedisClient();
  const rawQr = await redis.get(`wa:qr:${tenantId}`);

  if (!rawQr) {
    return res.status(404).json({ error: 'No QR code available. Session may not be initialised or QR has expired.' });
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(rawQr);
    return res.json({ qr: qrDataUrl, expires_in: 90 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate QR image' });
  }
});

// ─────────────────────────────────────────────
// GET /api/v1/whatsapp/sessions
// Get the current session status for a tenant.
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/whatsapp/sessions:
 *   get:
 *     summary: Get WhatsApp session status
 *     tags:
 *       - WhatsApp Sessions
 *     security:
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: tenant_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Current session status
 *       404:
 *         description: No session found
 */
router.get('/sessions', async (req, res) => {
  const tenantId = req.query.tenant_id || req.headers['x-tenant-id'];
  if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });

  const { data: session, error } = await supabaseAdmin
    .from('whatsapp_sessions')
    .select('status, phone_number, display_name, last_connected_at, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !session) {
    return res.status(404).json({ error: 'No WhatsApp session found for this tenant' });
  }

  return res.json({ session });
});

// ─────────────────────────────────────────────
// DELETE /api/v1/whatsapp/sessions
// Disconnect and destroy the WhatsApp session for a tenant.
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/whatsapp/sessions:
 *   delete:
 *     summary: Disconnect WhatsApp session
 *     description: Logs out of WhatsApp, destroys the Chromium session, and removes local session files.
 *     tags:
 *       - WhatsApp Sessions
 *     security:
 *       - SystemKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tenant_id
 *             properties:
 *               tenant_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Session disconnected
 *       404:
 *         description: No session found
 */
router.delete('/sessions', async (req, res) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });

  await destroyClient(tenantId);

  return res.json({ success: true, message: 'WhatsApp session disconnected' });
});

module.exports = router;
