const { Router } = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middlewares/authMiddleware');
const { executeCampaignSend } = require('../services/campaignService');

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getTenantId(userId) {
  const { data } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();
  return data?.tenant_id || null;
}

async function getAvailableSender(senderIdId, tenantId) {
  const { data } = await supabaseAdmin
    .from('sender_ids')
    .select('id, sender_id, display_name, is_global, tenant_id, status')
    .eq('id', senderIdId)
    .eq('status', 'approved')
    .single();
  if (!data) return null;
  if (data.is_global || data.tenant_id === tenantId) return data;
  return null;
}

// ===========================================================================
// CAMPAIGN CRUD
// ===========================================================================

/**
 * @swagger
 * /api/v1/campaigns:
 *   get:
 *     summary: List campaigns
 *     description: Returns paginated campaigns for the authenticated tenant, newest first.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [draft, scheduled, running, completed, cancelled, failed]
 *         description: Filter by campaign status
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated campaign list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 campaigns:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Campaign'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 */
router.get('/', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { status, page = 1, per_page = 20 } = req.query;
  const limit = Math.min(Number(per_page) || 20, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  let query = supabaseAdmin
    .from('campaigns')
    .select(
      'id, name, description, sender_name, status, scheduled_at, started_at, completed_at, ' +
      'total_recipients, total_sent, total_delivered, total_failed, total_credits_used, ' +
      'contact_list_id, created_at',
      { count: 'exact' }
    )
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'Failed to fetch campaigns' });

  return res.json({
    campaigns: data,
    pagination: { total: count, page: Number(page), per_page: limit }
  });
});

/**
 * @swagger
 * /api/v1/campaigns:
 *   post:
 *     summary: Create a draft campaign
 *     description: |
 *       Creates a new campaign in `draft` status. A campaign must have a contact list
 *       assigned before it can be sent or scheduled. The sender ID must be either a
 *       global approved sender or one of the tenant's own approved custom sender IDs.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - message
 *               - sender_id_id
 *             properties:
 *               name:
 *                 type: string
 *                 example: May Promo
 *               description:
 *                 type: string
 *                 example: Monthly promotional blast
 *               message:
 *                 type: string
 *                 example: "Hi! Get 20% off this weekend. Reply STOP to opt out."
 *               sender_id_id:
 *                 type: string
 *                 format: uuid
 *                 description: UUID of an approved sender ID (global or your own)
 *               contact_list_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional. Attach a contact list at creation time.
 *     responses:
 *       201:
 *         description: Campaign created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 campaign:
 *                   $ref: '#/components/schemas/Campaign'
 *       400:
 *         description: Validation error or sender ID not available
 */
router.post('/', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { name, description, message, sender_id_id, contact_list_id } = req.body;

  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'name is required' });
  if (!message || message.trim().length === 0) return res.status(400).json({ error: 'message is required' });
  if (!sender_id_id) return res.status(400).json({ error: 'sender_id_id is required' });

  const sender = await getAvailableSender(sender_id_id, tenantId);
  if (!sender) {
    return res.status(400).json({ error: 'Sender ID not found or not approved for your account' });
  }

  if (contact_list_id) {
    const { data: list } = await supabaseAdmin
      .from('contact_lists')
      .select('id')
      .eq('id', contact_list_id)
      .eq('tenant_id', tenantId)
      .single();
    if (!list) return res.status(400).json({ error: 'Contact list not found' });
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .insert({
      tenant_id: tenantId,
      created_by: req.user.id,
      name: name.trim(),
      description: description || null,
      message: message.trim(),
      sender_id_id,
      sender_name: sender.sender_id,
      contact_list_id: contact_list_id || null,
      status: 'draft'
    })
    .select()
    .single();

  if (error) {
    console.error('Campaign create error:', error);
    return res.status(500).json({ error: 'Failed to create campaign' });
  }

  return res.status(201).json({ campaign: data });
});

/**
 * @swagger
 * /api/v1/campaigns/{id}:
 *   get:
 *     summary: Get a campaign
 *     description: Returns campaign details including live delivery stats from the associated message batch.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Campaign detail
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 campaign:
 *                   $ref: '#/components/schemas/Campaign'
 *                 batch_stats:
 *                   type: object
 *                   nullable: true
 *                   description: Live stats from the message batch (null until campaign is sent)
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     status: { type: string }
 *                     total_recipients: { type: integer }
 *                     total_sent: { type: integer }
 *                     total_delivered: { type: integer }
 *                     total_failed: { type: integer }
 *                     completed_at: { type: string, format: date-time }
 *       404:
 *         description: Campaign not found
 */
router.get('/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data: campaign, error } = await supabaseAdmin
    .from('campaigns')
    .select('*, contact_lists(id, name, contact_count)')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !campaign) return res.status(404).json({ error: 'Campaign not found' });

  let batchStats = null;
  if (campaign.batch_id) {
    const { data: batch } = await supabaseAdmin
      .from('message_batches')
      .select('id, status, total_recipients, total_sent, total_delivered, total_failed, completed_at')
      .eq('id', campaign.batch_id)
      .single();
    batchStats = batch || null;
  }

  return res.json({ campaign, batch_stats: batchStats });
});

/**
 * @swagger
 * /api/v1/campaigns/{id}:
 *   patch:
 *     summary: Update a draft campaign
 *     description: Only campaigns in `draft` status can be edited.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               message: { type: string }
 *               sender_id_id:
 *                 type: string
 *                 format: uuid
 *               contact_list_id:
 *                 type: string
 *                 format: uuid
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Updated campaign
 *       400:
 *         description: Validation error or campaign is not a draft
 *       404:
 *         description: Campaign not found
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data: existing } = await supabaseAdmin
    .from('campaigns')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!existing) return res.status(404).json({ error: 'Campaign not found' });
  if (existing.status !== 'draft') {
    return res.status(400).json({ error: `Cannot edit a ${existing.status} campaign` });
  }

  const { name, description, message, sender_id_id, contact_list_id } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name.trim();
  if (description !== undefined) updates.description = description;
  if (message !== undefined) updates.message = message.trim();

  if (sender_id_id !== undefined) {
    const sender = await getAvailableSender(sender_id_id, tenantId);
    if (!sender) return res.status(400).json({ error: 'Sender ID not found or not approved for your account' });
    updates.sender_id_id = sender_id_id;
    updates.sender_name = sender.sender_id;
  }

  if (contact_list_id !== undefined) {
    if (contact_list_id === null) {
      updates.contact_list_id = null;
    } else {
      const { data: list } = await supabaseAdmin
        .from('contact_lists')
        .select('id')
        .eq('id', contact_list_id)
        .eq('tenant_id', tenantId)
        .single();
      if (!list) return res.status(400).json({ error: 'Contact list not found' });
      updates.contact_list_id = contact_list_id;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .update(updates)
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to update campaign' });
  return res.json({ campaign: data });
});

/**
 * @swagger
 * /api/v1/campaigns/{id}:
 *   delete:
 *     summary: Delete a campaign
 *     description: Only campaigns in `draft`, `cancelled`, or `failed` status can be deleted.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Deleted
 *       400:
 *         description: Campaign cannot be deleted in its current state
 *       404:
 *         description: Campaign not found
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data: existing } = await supabaseAdmin
    .from('campaigns')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!existing) return res.status(404).json({ error: 'Campaign not found' });

  if (!['draft', 'cancelled', 'failed'].includes(existing.status)) {
    return res.status(400).json({
      error: `Cannot delete a ${existing.status} campaign. Cancel it first if it is scheduled.`
    });
  }

  const { error } = await supabaseAdmin
    .from('campaigns')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId);

  if (error) return res.status(500).json({ error: 'Failed to delete campaign' });
  return res.status(204).send();
});

// ===========================================================================
// CAMPAIGN ACTIONS
// ===========================================================================

/**
 * @swagger
 * /api/v1/campaigns/{id}/send:
 *   post:
 *     summary: Send a campaign immediately
 *     description: |
 *       Triggers an immediate send of a `draft` or `scheduled` campaign.
 *       The campaign must already have a contact list assigned.
 *
 *       **What happens:**
 *       1. Opted-out contacts are excluded automatically.
 *       2. SMS credits are deducted atomically (1 per recipient). Enterprise/postpaid tenants are exempt.
 *       3. A message batch is created and SMS delivery begins asynchronously.
 *       4. Campaign status changes to `running`.
 *
 *       Poll `GET /api/v1/campaigns/{id}` or `GET /api/v1/campaigns/{id}/report`
 *       to track delivery progress.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Campaign dispatched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 batch_id: { type: string, format: uuid }
 *                 total_recipients: { type: integer }
 *                 status: { type: string, example: running }
 *       400:
 *         description: Campaign not sendable (no contact list, wrong status, sender revoked, or insufficient credits)
 *       404:
 *         description: Campaign not found
 */
router.post('/:id/send', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('id, status, contact_list_id')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (!['draft', 'scheduled'].includes(campaign.status)) {
    return res.status(400).json({ error: `Cannot send a ${campaign.status} campaign` });
  }

  if (!campaign.contact_list_id) {
    return res.status(400).json({
      error: 'Campaign has no contact list. Update the campaign with a contact_list_id first.'
    });
  }

  try {
    const result = await executeCampaignSend(req.params.id);
    return res.json({
      success: true,
      batch_id: result.batchId,
      total_recipients: result.totalRecipients,
      status: 'running'
    });
  } catch (err) {
    const isClientError = /insufficient|no eligible|not approved|no contact list/i.test(err.message);
    return res.status(isClientError ? 400 : 500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/v1/campaigns/{id}/schedule:
 *   post:
 *     summary: Schedule a campaign for future delivery
 *     description: |
 *       Schedules a `draft` campaign to send at a future timestamp.
 *       The campaign must have a contact list assigned before scheduling.
 *       The campaign worker checks for due campaigns every minute.
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - scheduled_at
 *             properties:
 *               scheduled_at:
 *                 type: string
 *                 format: date-time
 *                 description: ISO 8601 timestamp in the future
 *                 example: "2026-05-20T09:00:00Z"
 *     responses:
 *       200:
 *         description: Campaign scheduled
 *       400:
 *         description: Invalid timestamp, no contact list, or campaign not in draft status
 *       404:
 *         description: Campaign not found
 */
router.post('/:id/schedule', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required' });

  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ error: 'scheduled_at must be a valid ISO 8601 timestamp' });
  }
  if (scheduledDate <= new Date()) {
    return res.status(400).json({ error: 'scheduled_at must be in the future' });
  }

  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('id, status, contact_list_id')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (campaign.status !== 'draft') {
    return res.status(400).json({ error: `Cannot schedule a ${campaign.status} campaign` });
  }

  if (!campaign.contact_list_id) {
    return res.status(400).json({
      error: 'Campaign has no contact list. Update the campaign with a contact_list_id first.'
    });
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .update({ status: 'scheduled', scheduled_at: scheduledDate.toISOString() })
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to schedule campaign' });
  return res.json({ campaign: data });
});

/**
 * @swagger
 * /api/v1/campaigns/{id}/cancel:
 *   post:
 *     summary: Cancel a scheduled campaign
 *     description: Cancels a `scheduled` campaign before it fires. Returns the campaign to a cancellable state (it cannot be re-sent without being recreated as a new draft).
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Campaign cancelled
 *       400:
 *         description: Campaign is not in scheduled status
 *       404:
 *         description: Campaign not found
 */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('id, status')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (campaign.status !== 'scheduled') {
    return res.status(400).json({ error: 'Only scheduled campaigns can be cancelled' });
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .update({ status: 'cancelled', scheduled_at: null })
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to cancel campaign' });
  return res.json({ campaign: data });
});

// ===========================================================================
// CAMPAIGN REPORT
// ===========================================================================

/**
 * @swagger
 * /api/v1/campaigns/{id}/report:
 *   get:
 *     summary: Get campaign delivery report
 *     description: |
 *       Returns live delivery statistics and a paginated log of individual message
 *       outcomes for the campaign's send batch.
 *
 *       Use the `status` query parameter to filter by delivery outcome
 *       (`queued`, `sent`, `delivered`, `failed`).
 *     tags:
 *       - Campaigns
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [queued, sent, delivered, failed]
 *         description: Filter messages by delivery status
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: Campaign report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 campaign:
 *                   type: object
 *                   description: Campaign summary row
 *                 delivery_stats:
 *                   type: object
 *                   nullable: true
 *                   description: Live counters from the message batch
 *                   properties:
 *                     status: { type: string }
 *                     total_recipients: { type: integer }
 *                     total_sent: { type: integer }
 *                     total_delivered: { type: integer }
 *                     total_failed: { type: integer }
 *                 messages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       recipient: { type: string }
 *                       status: { type: string }
 *                       sent_at: { type: string, format: date-time }
 *                       delivered_at: { type: string, format: date-time, nullable: true }
 *                       failed_at: { type: string, format: date-time, nullable: true }
 *                       error_message: { type: string, nullable: true }
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       404:
 *         description: Campaign not found
 */
router.get('/:id/report', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { status, page = 1, per_page = 50 } = req.query;
  const limit = Math.min(Number(per_page) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const { data: campaign, error: campError } = await supabaseAdmin
    .from('campaigns')
    .select(
      'id, name, status, total_recipients, total_sent, total_delivered, total_failed, ' +
      'total_credits_used, batch_id, started_at, completed_at, sender_name'
    )
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (campError || !campaign) return res.status(404).json({ error: 'Campaign not found' });

  if (!campaign.batch_id) {
    return res.json({
      campaign,
      delivery_stats: null,
      messages: [],
      pagination: { total: 0, page: 1, per_page: limit }
    });
  }

  let msgQuery = supabaseAdmin
    .from('messages')
    .select(
      'id, recipient, status, sent_at, delivered_at, failed_at, error_message, provider_message_id',
      { count: 'exact' }
    )
    .eq('batch_id', campaign.batch_id)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (status) msgQuery = msgQuery.eq('status', status);

  const [msgResult, batchResult] = await Promise.all([
    msgQuery,
    supabaseAdmin
      .from('message_batches')
      .select('status, total_recipients, total_sent, total_delivered, total_failed, completed_at')
      .eq('id', campaign.batch_id)
      .single()
  ]);

  if (msgResult.error) return res.status(500).json({ error: 'Failed to load message report' });

  return res.json({
    campaign,
    delivery_stats: batchResult.data || null,
    messages: msgResult.data || [],
    pagination: { total: msgResult.count, page: Number(page), per_page: limit }
  });
});

// ===========================================================================
// Swagger schema components
// ===========================================================================

/**
 * @swagger
 * components:
 *   schemas:
 *     Campaign:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         name:
 *           type: string
 *         description:
 *           type: string
 *           nullable: true
 *         message:
 *           type: string
 *         sender_name:
 *           type: string
 *           description: Sender ID string used for this campaign (e.g. LETTSCOMM)
 *         sender_id_id:
 *           type: string
 *           format: uuid
 *         contact_list_id:
 *           type: string
 *           format: uuid
 *           nullable: true
 *         status:
 *           type: string
 *           enum: [draft, scheduled, running, completed, cancelled, failed]
 *         scheduled_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         started_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         completed_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         total_recipients:
 *           type: integer
 *         total_sent:
 *           type: integer
 *         total_delivered:
 *           type: integer
 *         total_failed:
 *           type: integer
 *         total_credits_used:
 *           type: integer
 *         batch_id:
 *           type: string
 *           format: uuid
 *           nullable: true
 *         created_at:
 *           type: string
 *           format: date-time
 */

module.exports = router;
