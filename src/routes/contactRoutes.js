const { Router } = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middlewares/authMiddleware');

const router = Router();

// ---------------------------------------------------------------------------
// Helper: resolve tenant_id for any active member (not just owner)
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

// ---------------------------------------------------------------------------
// CSV serialiser
// ---------------------------------------------------------------------------
function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map(row =>
    columns.map(col => {
      const val = row[col] ?? '';
      const str = Array.isArray(val) ? val.join(';') : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

// ===========================================================================
// IMPORTANT: specific paths (/export, /lists, /lists/*) MUST be declared
// before /:id so Express doesn't consume them as a parameter value.
// ===========================================================================

// ===========================================================================
// CONTACT LISTS  (declared first — before /:id)
// ===========================================================================

/**
 * @swagger
 * /api/v1/contacts/lists:
 *   get:
 *     summary: List contact lists
 *     description: Returns all contact lists belonging to the authenticated tenant.
 *     tags:
 *       - Contacts
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, archived, all]
 *           default: active
 *         description: Filter by list status
 *     responses:
 *       200:
 *         description: Array of contact lists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contact_lists:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ContactList'
 *       403:
 *         description: No active business account
 */
router.get('/lists', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { status = 'active' } = req.query;

  let query = supabaseAdmin
    .from('contact_lists')
    .select('id, name, description, contact_count, status, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (status !== 'all') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to fetch contact lists' });
  return res.json({ contact_lists: data });
});

/**
 * @swagger
 * /api/v1/contacts/lists:
 *   post:
 *     summary: Create a contact list
 *     tags:
 *       - Contacts
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
 *             properties:
 *               name:
 *                 type: string
 *                 example: TNM Subscribers
 *               description:
 *                 type: string
 *                 example: Monthly offer list
 *     responses:
 *       201:
 *         description: Contact list created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contact_list:
 *                   $ref: '#/components/schemas/ContactList'
 *       400:
 *         description: name is required
 */
router.post('/lists', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { name, description } = req.body;
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }

  const { data, error } = await supabaseAdmin
    .from('contact_lists')
    .insert({
      tenant_id: tenantId,
      created_by: req.user.id,
      name: name.trim(),
      description: description || null
    })
    .select()
    .single();

  if (error) {
    console.error('Contact list create error:', error);
    return res.status(500).json({ error: 'Failed to create contact list' });
  }

  return res.status(201).json({ contact_list: data });
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}:
 *   get:
 *     summary: Get a contact list with its members
 *     tags:
 *       - Contacts
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: List detail with paginated members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contact_list:
 *                   $ref: '#/components/schemas/ContactList'
 *                 members:
 *                   type: array
 *                   items:
 *                     type: object
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       404:
 *         description: Contact list not found
 */
router.get('/lists/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { page = 1, per_page = 50 } = req.query;
  const limit = Math.min(Number(per_page) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const [listResult, membersResult] = await Promise.all([
    supabaseAdmin
      .from('contact_lists')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .single(),
    supabaseAdmin
      .from('contact_list_members')
      .select('id, added_at, contacts(id, phone, full_name, email, tags, messages_sent, messages_delivered, sms_opted_out)', { count: 'exact' })
      .eq('contact_list_id', req.params.id)
      .order('added_at', { ascending: false })
      .range(offset, offset + limit - 1)
  ]);

  if (listResult.error || !listResult.data) {
    return res.status(404).json({ error: 'Contact list not found' });
  }

  return res.json({
    contact_list: listResult.data,
    members: membersResult.data || [],
    pagination: { total: membersResult.count || 0, page: Number(page), per_page: limit }
  });
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}:
 *   patch:
 *     summary: Update a contact list
 *     tags:
 *       - Contacts
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
 *               status:
 *                 type: string
 *                 enum: [active, archived]
 *     responses:
 *       200:
 *         description: Updated contact list
 *       404:
 *         description: Contact list not found
 */
router.patch('/lists/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { name, description, status } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (description !== undefined) updates.description = description;
  if (status !== undefined) {
    if (!['active', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be active or archived' });
    }
    updates.status = status;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabaseAdmin
    .from('contact_lists')
    .update(updates)
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contact list not found' });
  return res.json({ contact_list: data });
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}:
 *   delete:
 *     summary: Delete a contact list
 *     description: Deletes the list and removes all memberships. The contacts themselves are not deleted.
 *     tags:
 *       - Contacts
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
 *       404:
 *         description: Contact list not found
 */
router.delete('/lists/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { error } = await supabaseAdmin
    .from('contact_lists')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId);

  if (error) return res.status(404).json({ error: 'Contact list not found' });
  return res.status(204).send();
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}/import:
 *   post:
 *     summary: Bulk-import contacts into a list by filter
 *     description: |
 *       Queries the tenant's contacts using the provided filters and adds every
 *       matching contact to the list in a single operation. Existing memberships
 *       are silently ignored (idempotent). Useful for building a list from all
 *       API-sourced contacts, a specific batch, a tag, or any combination.
 *     tags:
 *       - Contacts
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Contact list ID to import into
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source:
 *                 type: string
 *                 enum: [manual, import, api, campaign_signup]
 *                 description: Import contacts captured via this source
 *                 example: api
 *               batch_id:
 *                 type: string
 *                 format: uuid
 *                 description: Import recipients of a specific send batch
 *               tag:
 *                 type: string
 *                 description: Import contacts that carry this tag
 *               opted_out:
 *                 type: boolean
 *                 description: Include opted-out contacts (default false = exclude them)
 *     responses:
 *       200:
 *         description: Import result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 imported:
 *                   type: integer
 *                   description: Number of contacts newly added to the list
 *                 total_matched:
 *                   type: integer
 *                   description: Total contacts matching the filter
 *       400:
 *         description: At least one filter required
 *       404:
 *         description: Contact list not found
 */
router.post('/lists/:id/import', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { source, batch_id, tag, opted_out } = req.body;

  if (!source && !batch_id && !tag && opted_out === undefined) {
    return res.status(400).json({
      error: 'At least one filter is required: source, batch_id, tag, or opted_out'
    });
  }

  // Verify list belongs to this tenant
  const { data: list } = await supabaseAdmin
    .from('contact_lists')
    .select('id')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!list) return res.status(404).json({ error: 'Contact list not found' });

  // Fetch matching contacts
  let query = supabaseAdmin
    .from('contacts')
    .select('id')
    .eq('tenant_id', tenantId);

  if (source) query = query.eq('source', source);
  if (batch_id) query = query.eq('first_batch_id', batch_id);
  if (tag) query = query.contains('tags', [tag]);
  // By default exclude opted-out contacts unless explicitly requested
  if (opted_out === true) {
    query = query.eq('sms_opted_out', true);
  } else if (opted_out !== true) {
    query = query.eq('sms_opted_out', false);
  }

  const { data: contacts, error: fetchError } = await query;
  if (fetchError) {
    console.error('Import fetch error:', fetchError);
    return res.status(500).json({ error: 'Failed to query contacts' });
  }

  if (!contacts || contacts.length === 0) {
    return res.json({ imported: 0, total_matched: 0 });
  }

  const { data: inserted, error: upsertError } = await supabaseAdmin
    .from('contact_list_members')
    .upsert(
      contacts.map(c => ({
        contact_list_id: req.params.id,
        contact_id: c.id,
        added_by: req.user.id
      })),
      { onConflict: 'contact_list_id,contact_id', ignoreDuplicates: true }
    )
    .select();

  if (upsertError) {
    console.error('Import upsert error:', upsertError);
    return res.status(500).json({ error: 'Failed to import contacts' });
  }

  // Refresh denormalized count
  const { count } = await supabaseAdmin
    .from('contact_list_members')
    .select('id', { count: 'exact', head: true })
    .eq('contact_list_id', req.params.id);

  await supabaseAdmin
    .from('contact_lists')
    .update({ contact_count: count || 0 })
    .eq('id', req.params.id);

  return res.json({
    imported: inserted?.length ?? 0,
    total_matched: contacts.length
  });
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}/members:
 *   post:
 *     summary: Add contacts to a list
 *     tags:
 *       - Contacts
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
 *               - contact_ids
 *             properties:
 *               contact_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 example: ["uuid-1", "uuid-2"]
 *     responses:
 *       201:
 *         description: Members added
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 added:
 *                   type: integer
 *                   description: Number of newly added memberships (duplicates are silently ignored)
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Contact list not found
 */
router.post('/lists/:id/members', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { contact_ids } = req.body;
  if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
    return res.status(400).json({ error: 'contact_ids must be a non-empty array' });
  }

  const { data: list } = await supabaseAdmin
    .from('contact_lists')
    .select('id')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!list) return res.status(404).json({ error: 'Contact list not found' });

  const { data: validContacts } = await supabaseAdmin
    .from('contacts')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', contact_ids);

  if (!validContacts || validContacts.length === 0) {
    return res.status(400).json({ error: 'No valid contacts found' });
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('contact_list_members')
    .upsert(
      validContacts.map(c => ({
        contact_list_id: req.params.id,
        contact_id: c.id,
        added_by: req.user.id
      })),
      { onConflict: 'contact_list_id,contact_id', ignoreDuplicates: true }
    )
    .select();

  if (error) {
    console.error('Add members error:', error);
    return res.status(500).json({ error: 'Failed to add members' });
  }

  const { count } = await supabaseAdmin
    .from('contact_list_members')
    .select('id', { count: 'exact', head: true })
    .eq('contact_list_id', req.params.id);

  await supabaseAdmin
    .from('contact_lists')
    .update({ contact_count: count || 0 })
    .eq('id', req.params.id);

  return res.status(201).json({ added: inserted?.length ?? 0 });
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}/members:
 *   delete:
 *     summary: Remove contacts from a list
 *     tags:
 *       - Contacts
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
 *               - contact_ids
 *             properties:
 *               contact_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       204:
 *         description: Removed
 *       404:
 *         description: Contact list not found
 */
router.delete('/lists/:id/members', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { contact_ids } = req.body;
  if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
    return res.status(400).json({ error: 'contact_ids must be a non-empty array' });
  }

  const { data: list } = await supabaseAdmin
    .from('contact_lists')
    .select('id')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!list) return res.status(404).json({ error: 'Contact list not found' });

  await supabaseAdmin
    .from('contact_list_members')
    .delete()
    .eq('contact_list_id', req.params.id)
    .in('contact_id', contact_ids);

  const { count } = await supabaseAdmin
    .from('contact_list_members')
    .select('id', { count: 'exact', head: true })
    .eq('contact_list_id', req.params.id);

  await supabaseAdmin
    .from('contact_lists')
    .update({ contact_count: count || 0 })
    .eq('id', req.params.id);

  return res.status(204).send();
});

/**
 * @swagger
 * /api/v1/contacts/lists/{id}/export:
 *   get:
 *     summary: Export a contact list as CSV
 *     description: Downloads all members of the list as a CSV file.
 *     tags:
 *       - Contacts
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
 *         description: CSV file
 *         content:
 *           text/csv:
 *             schema: { type: string }
 *       404:
 *         description: Contact list not found
 */
router.get('/lists/:id/export', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data: list } = await supabaseAdmin
    .from('contact_lists')
    .select('id, name')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (!list) return res.status(404).json({ error: 'Contact list not found' });

  const { data: members, error } = await supabaseAdmin
    .from('contact_list_members')
    .select('contacts(id, phone, full_name, first_name, last_name, email, tags, messages_sent, messages_delivered, sms_opted_out, created_at)')
    .eq('contact_list_id', req.params.id);

  if (error) return res.status(500).json({ error: 'Failed to export list' });

  const rows = (members || []).map(m => m.contacts).filter(Boolean);
  const csv = toCSV(rows, ['id', 'phone', 'full_name', 'first_name', 'last_name', 'email', 'tags', 'messages_sent', 'messages_delivered', 'sms_opted_out', 'created_at']);

  const safeName = list.name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  return res.send(csv);
});

// ===========================================================================
// CONTACTS  (/:id routes last — must come after all fixed-path routes above)
// ===========================================================================

/**
 * @swagger
 * /api/v1/contacts:
 *   get:
 *     summary: List contacts
 *     description: |
 *       Returns a paginated list of contacts for the authenticated tenant.
 *       Contacts are automatically captured from every `/send/sms` call
 *       (both live and test environment keys), and can also be created manually.
 *     tags:
 *       - Contacts
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Full-text search across phone, name and email
 *         example: "265887"
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [manual, import, api, campaign_signup]
 *         description: Filter by how the contact was captured. Use `api` to see everyone who received a send.
 *       - in: query
 *         name: batch_id
 *         schema: { type: string, format: uuid }
 *         description: Show only contacts first seen in a specific send batch
 *       - in: query
 *         name: tag
 *         schema: { type: string }
 *         description: Filter contacts that have this tag
 *       - in: query
 *         name: opted_out
 *         schema: { type: boolean }
 *         description: "true = show only opted-out contacts"
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: Paginated list of contacts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contacts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Contact'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       403:
 *         description: No active business account
 */
router.get('/', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { q, source, batch_id, tag, opted_out, page = 1, per_page = 50 } = req.query;
  const limit = Math.min(Number(per_page) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  let query = supabaseAdmin
    .from('contacts')
    .select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) query = query.or(`phone.ilike.%${q}%,full_name.ilike.%${q}%,email.ilike.%${q}%`);
  if (source) query = query.eq('source', source);
  if (batch_id) query = query.eq('first_batch_id', batch_id);
  if (tag) query = query.contains('tags', [tag]);
  if (opted_out !== undefined) query = query.eq('sms_opted_out', opted_out === 'true');

  const { data, error, count } = await query;
  if (error) {
    console.error('Contacts list error:', error);
    return res.status(500).json({ error: 'Failed to fetch contacts' });
  }

  return res.json({
    contacts: data,
    pagination: { total: count, page: Number(page), per_page: limit }
  });
});

/**
 * @swagger
 * /api/v1/contacts/export:
 *   get:
 *     summary: Export all contacts as CSV
 *     description: Downloads the tenant's full contact list as a CSV file. Supports the same filters as GET /contacts.
 *     tags:
 *       - Contacts
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [manual, import, api, campaign_signup]
 *       - in: query
 *         name: batch_id
 *         schema: { type: string, format: uuid }
 *         description: Export only contacts from a specific send batch
 *       - in: query
 *         name: tag
 *         schema: { type: string }
 *       - in: query
 *         name: opted_out
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema: { type: string }
 *             example: "id,phone,full_name,...\nuuid,265887716765,John Doe,..."
 */
router.get('/export', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { source, batch_id, tag, opted_out } = req.query;

  let query = supabaseAdmin
    .from('contacts')
    .select('id,phone,full_name,first_name,last_name,email,tags,source,first_batch_id,messages_sent,messages_delivered,sms_opted_out,created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (source) query = query.eq('source', source);
  if (batch_id) query = query.eq('first_batch_id', batch_id);
  if (tag) query = query.contains('tags', [tag]);
  if (opted_out !== undefined) query = query.eq('sms_opted_out', opted_out === 'true');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to export contacts' });

  const csv = toCSV(data, ['id', 'phone', 'full_name', 'first_name', 'last_name', 'email', 'tags', 'source', 'messages_sent', 'messages_delivered', 'sms_opted_out', 'created_at']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  return res.send(csv);
});

/**
 * @swagger
 * /api/v1/contacts:
 *   post:
 *     summary: Create a contact manually
 *     description: At least one of `phone` or `email` is required.
 *     tags:
 *       - Contacts
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone:
 *                 type: string
 *                 example: "265887716765"
 *               email:
 *                 type: string
 *                 example: "john@example.com"
 *               full_name:
 *                 type: string
 *                 example: "John Doe"
 *               first_name:
 *                 type: string
 *               last_name:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["vip", "airtel"]
 *               custom_fields:
 *                 type: object
 *                 example: { "account_number": "ACC-001" }
 *     responses:
 *       201:
 *         description: Contact created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contact:
 *                   $ref: '#/components/schemas/Contact'
 *       400:
 *         description: phone or email required
 *       409:
 *         description: Contact with this phone number already exists
 */
router.post('/', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { phone, email, full_name, first_name, last_name, tags, custom_fields } = req.body;

  if (!phone && !email) {
    return res.status(400).json({ error: 'At least one of phone or email is required' });
  }

  const { data, error } = await supabaseAdmin
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      phone: phone || null,
      email: email || null,
      full_name: full_name || null,
      first_name: first_name || null,
      last_name: last_name || null,
      tags: tags || [],
      custom_fields: custom_fields || {},
      source: 'manual'
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A contact with this phone number already exists' });
    }
    console.error('Contact create error:', error);
    return res.status(500).json({ error: 'Failed to create contact' });
  }

  return res.status(201).json({ contact: data });
});

/**
 * @swagger
 * /api/v1/contacts/{id}:
 *   get:
 *     summary: Get a single contact
 *     tags:
 *       - Contacts
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
 *         description: Contact record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 contact:
 *                   $ref: '#/components/schemas/Contact'
 *       404:
 *         description: Contact not found
 */
router.get('/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('*')
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contact not found' });
  return res.json({ contact: data });
});

/**
 * @swagger
 * /api/v1/contacts/{id}:
 *   patch:
 *     summary: Update a contact
 *     description: All fields are optional. Setting `sms_opted_out` to `true` also records `sms_opted_out_at`.
 *     tags:
 *       - Contacts
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
 *               phone: { type: string }
 *               email: { type: string }
 *               full_name: { type: string }
 *               first_name: { type: string }
 *               last_name: { type: string }
 *               tags:
 *                 type: array
 *                 items: { type: string }
 *               custom_fields: { type: object }
 *               sms_opted_out:
 *                 type: boolean
 *                 description: Set to true to mark as opted out of SMS
 *     responses:
 *       200:
 *         description: Updated contact
 *       400:
 *         description: No valid fields to update
 *       404:
 *         description: Contact not found
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const allowed = ['phone', 'email', 'full_name', 'first_name', 'last_name', 'tags', 'custom_fields', 'sms_opted_out'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  if (updates.sms_opted_out === true) {
    updates.sms_opted_out_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('contacts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contact not found' });
  return res.json({ contact: data });
});

/**
 * @swagger
 * /api/v1/contacts/{id}:
 *   delete:
 *     summary: Delete a contact
 *     description: Permanently removes the contact and removes them from all contact lists.
 *     tags:
 *       - Contacts
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
 *       404:
 *         description: Contact not found
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const tenantId = await getTenantId(req.user.id);
  if (!tenantId) return res.status(403).json({ error: 'No active business account' });

  const { error } = await supabaseAdmin
    .from('contacts')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', tenantId);

  if (error) return res.status(404).json({ error: 'Contact not found' });
  return res.status(204).send();
});

// ===========================================================================
// Shared schema components (referenced by $ref above)
// ===========================================================================

/**
 * @swagger
 * components:
 *   schemas:
 *     Contact:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         phone:
 *           type: string
 *           example: "265887716765"
 *         email:
 *           type: string
 *         full_name:
 *           type: string
 *         first_name:
 *           type: string
 *         last_name:
 *           type: string
 *         tags:
 *           type: array
 *           items: { type: string }
 *         custom_fields:
 *           type: object
 *         source:
 *           type: string
 *           enum: [manual, import, api, campaign_signup]
 *           description: "'api' = auto-captured from /send/sms (both live and test keys)"
 *         first_batch_id:
 *           type: string
 *           format: uuid
 *           description: ID of the first send batch that introduced this contact
 *         sms_opted_out:
 *           type: boolean
 *         messages_sent:
 *           type: integer
 *           description: Total times this contact was included in a batch
 *         messages_delivered:
 *           type: integer
 *           description: Confirmed deliveries via Kannel DLR
 *         last_contacted_at:
 *           type: string
 *           format: date-time
 *         created_at:
 *           type: string
 *           format: date-time
 *     ContactList:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         contact_count:
 *           type: integer
 *         status:
 *           type: string
 *           enum: [active, archived]
 *         created_at:
 *           type: string
 *           format: date-time
 *     Pagination:
 *       type: object
 *       properties:
 *         total:
 *           type: integer
 *         page:
 *           type: integer
 *         per_page:
 *           type: integer
 */

module.exports = router;
