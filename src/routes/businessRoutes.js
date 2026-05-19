const { Router } = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendTeamInviteEmail, sendInvitationAcceptedEmail } = require('../services/emailService');

const router = Router();

/**
 * Helper: Get the tenant the authenticated user owns.
 * Returns the tenant and membership or null.
 */
async function getOwnedTenant(userId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id, is_owner, role_id, tenants(*)')
    .eq('user_id', userId)
    .eq('is_owner', true)
    .eq('status', 'active')
    .single();

  if (error || !data) return null;
  return data;
}

// ─────────────────────────────────────────────
// GET /api/v1/business — Get own business details
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business:
 *   get:
 *     summary: Get own business profile
 *     description: Returns the business (tenant) that the authenticated user owns.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Business profile retrieved
 *       403:
 *         description: You do not own a business
 *       404:
 *         description: Business not found
 */
router.get('/', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  res.json({ business: owned.tenants });
});

// ─────────────────────────────────────────────
// GET /api/v1/business/members — Get all members of the owned business
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business/members:
 *   get:
 *     summary: Get business members
 *     description: Returns all members of the authenticated owner's business.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Members list
 *       403:
 *         description: You do not own a business
 */
router.get('/members', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  // Fetch members with a two-step approach to avoid FK ambiguity
  const { data: memberRows, error } = await supabaseAdmin
    .from('tenant_members')
    .select('id, user_id, role_id, is_owner, status, joined_at')
    .eq('tenant_id', owned.tenant_id)
    .eq('status', 'active')
    .or('invite_accepted.eq.true,is_owner.eq.true');

  if (error) {
    console.error('Members fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch members', details: error.message });
  }

  // Enrich with user and role details
  const enriched = await Promise.all(memberRows.map(async (m) => {
    const [{ data: user }, { data: role }] = await Promise.all([
      supabaseAdmin.from('users').select('id, email, full_name, phone, avatar_url').eq('id', m.user_id).single(),
      supabaseAdmin.from('roles').select('id, name').eq('id', m.role_id).single()
    ]);
    return { ...m, user, role };
  }));

  res.json({ members: enriched });
});

// ─────────────────────────────────────────────
// PATCH /api/v1/business — Update business profile (owner only)
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business:
 *   patch:
 *     summary: Update business profile (one-time only)
 *     description: |
 *       Update the owned business details. **This can only be done once.**
 *       After the first update, further changes require contacting platform support.
 *       All fields are optional — only send what you want to update.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Business display name
 *                 example: Acme Holdings Ltd
 *               business_name:
 *                 type: string
 *                 description: Official legal business name
 *                 example: Acme Holdings Limited
 *               business_type:
 *                 type: string
 *                 description: "Type: sole_proprietor, partnership, limited_company, ngo"
 *                 example: limited_company
 *               registration_number:
 *                 type: string
 *                 description: Business registration number (MBRS)
 *                 example: "BR-2024-001234"
 *               tax_id:
 *                 type: string
 *                 description: MERA Tax Identification Number
 *                 example: "TIN-987654321"
 *               email:
 *                 type: string
 *                 description: Official business contact email
 *                 example: contact@acme.mw
 *               phone:
 *                 type: string
 *                 description: Business phone number
 *                 example: "0881234567"
 *               website:
 *                 type: string
 *                 description: Business website URL
 *                 example: https://acme.mw
 *               address_line1:
 *                 type: string
 *                 description: Primary street address
 *                 example: 12 Independence Drive
 *               address_line2:
 *                 type: string
 *                 description: Additional address info (suite, building, etc.)
 *                 example: Suite 3B, Gemini House
 *               city:
 *                 type: string
 *                 example: Blantyre
 *               country:
 *                 type: string
 *                 example: Malawi
 *     responses:
 *       200:
 *         description: Business updated successfully
 *       400:
 *         description: No valid fields provided
 *       403:
 *         description: Not an owner, or business has already been updated once
 *       500:
 *         description: Server error
 */
router.patch('/', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  // ── One-time edit enforcement ──────────────────────────────────
  const { data: currentTenant, error: fetchError } = await supabaseAdmin
    .from('tenants')
    .select('created_at, updated_at')
    .eq('id', owned.tenant_id)
    .single();

  if (fetchError || !currentTenant) {
    return res.status(500).json({ error: 'Failed to verify business details' });
  }

  const createdAt = new Date(currentTenant.created_at).getTime();
  const updatedAt = new Date(currentTenant.updated_at).getTime();
  const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes grace after creation

  if (updatedAt - createdAt > GRACE_PERIOD_MS) {
    return res.status(403).json({
      error: 'Business profile has already been updated',
      message: 'Business details can only be edited once. Please contact support if you need further changes.'
    });
  }
  // ──────────────────────────────────────────────────────────────

  const allowed = [
    'name', 'business_name', 'business_type', 'registration_number', 'tax_id',
    'email', 'phone', 'website',
    'address_line1', 'address_line2', 'city', 'country'
  ];
  const updates = { updated_at: new Date().toISOString() };

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields provided to update', allowed });
  }

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .update(updates)
    .eq('id', owned.tenant_id)
    .select()
    .single();

  if (error) {
    console.error('Business update error:', error);
    return res.status(500).json({ error: 'Failed to update business', details: error.message });
  }

  res.json({ 
    message: 'Business updated successfully. Note: this is a one-time edit. Contact support for further changes.',
    business: data 
  });
});

// ─────────────────────────────────────────────
// DELETE /api/v1/business — NOT allowed for owners, super admins only
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business:
 *   delete:
 *     summary: Delete business (Super Admin only)
 *     description: Businesses cannot be deleted by their owners. Only super admins can delete a business. Owners get a 403.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Business deleted (super admin only)
 *       403:
 *         description: Owners are not permitted to delete their business
 */
router.delete('/', requireAuth, async (req, res) => {
  const user = req.user;

  // Check if super admin
  if (!user.is_platform_admin) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Business accounts cannot be deleted by their owners. Please contact platform support.'
    });
  }

  // Super admin: allow deletion by tenant_id passed in body
  const { tenant_id } = req.body;
  if (!tenant_id) {
    return res.status(400).json({ error: 'tenant_id is required for admin deletion' });
  }

  const { error } = await supabaseAdmin
    .from('tenants')
    .update({ status: 'deactivated', updated_at: new Date().toISOString() })
    .eq('id', tenant_id);

  if (error) return res.status(500).json({ error: 'Failed to deactivate business' });

  res.json({ message: 'Business deactivated successfully by admin' });
});

// ═════════════════════════════════════════════════════════════════
// MEMBER INVITATION SYSTEM (Owner only)
// ═════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/v1/business/invite:
 *   post:
 *     summary: Invite a team member (Owner only)
 *     description: |
 *       Invites an existing platform user to join the owner's business.
 *       The invited user must already have a registered account.
 *       The invitation is created with `invite_accepted: false` and `status: pending`.
 *       Available roles: `admin`, `developer`, `billing`, `viewer`
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - role
 *             properties:
 *               email:
 *                 type: string
 *                 description: Email of the user to invite (must already be registered)
 *                 example: newmember@example.com
 *               role:
 *                 type: string
 *                 description: Role to assign the invited member
 *                 example: developer
 *     responses:
 *       201:
 *         description: Invitation created successfully
 *       400:
 *         description: Missing fields or invalid role
 *       403:
 *         description: Only business owners can invite members
 *       404:
 *         description: Invited user not found
 *       409:
 *         description: User is already a member of this business
 */
router.post('/invite', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'Only business owners can invite members' });

  const { email, role } = req.body;

  if (!email || !role) {
    return res.status(400).json({ error: 'email and role are required' });
  }

  const VALID_ROLES = ['admin', 'developer', 'billing', 'viewer'];
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ 
      error: 'Invalid role', 
      allowed: VALID_ROLES 
    });
  }

  // Find the invitee by email
  const { data: invitee, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, status')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (userError || !invitee) {
    return res.status(404).json({ 
      error: 'User not found',
      message: 'The invited user must have a registered account on this platform first.'
    });
  }

  if (invitee.status !== 'active') {
    return res.status(403).json({ error: 'Cannot invite an inactive user account' });
  }

  // Check if user is already a member
  const { data: existingMember } = await supabaseAdmin
    .from('tenant_members')
    .select('id, status, invite_accepted')
    .eq('tenant_id', owned.tenant_id)
    .eq('user_id', invitee.id)
    .single();

  if (existingMember) {
    const status = existingMember.invite_accepted ? 'an active member' : 'already invited (pending acceptance)';
    return res.status(409).json({ 
      error: `User is ${status} of this business`
    });
  }

  // Look up the role record
  const { data: roleRecord } = await supabaseAdmin
    .from('roles')
    .select('id')
    .eq('name', role)
    .single();

  if (!roleRecord) {
    return res.status(500).json({ error: 'Role configuration not found. Contact support.' });
  }

  // Create the invitation (pending acceptance)
  const { data: membership, error: memberError } = await supabaseAdmin
    .from('tenant_members')
    .insert({
      tenant_id: owned.tenant_id,
      user_id: invitee.id,
      role_id: roleRecord.id,
      is_owner: false,
      invited_by: req.user.id,
      invited_at: new Date().toISOString(),
      invite_accepted: false,
      status: 'pending'
    })
    .select()
    .single();

  if (memberError) {
    console.error('Invite error:', memberError);
    return res.status(500).json({ error: 'Failed to create invitation', details: memberError.message });
  }

  sendTeamInviteEmail({
    inviteeEmail: invitee.email,
    inviteeName: invitee.full_name,
    businessName: owned.tenants?.name || 'the business',
    role,
  }).catch(err => console.error('[email] teamInvite:', err.message));

  res.status(201).json({
    message: `Invitation sent to ${invitee.full_name} (${invitee.email})`,
    invitation: {
      id: membership.id,
      invited_user: { id: invitee.id, email: invitee.email, full_name: invitee.full_name },
      role,
      status: 'pending',
      invite_accepted: false,
      invited_at: membership.invited_at
    }
  });
});

// ─────────────────────────────────────────────
// GET /api/v1/business/invitations — List all pending invitations (Owner only)
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business/invitations:
 *   get:
 *     summary: List pending invitations (Owner only)
 *     description: Returns all pending (unaccepted) invitations for the owner's business.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Pending invitations list
 *       403:
 *         description: Owner access required
 */
router.get('/invitations', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'Only business owners can view invitations' });

  const { data: invitations, error } = await supabaseAdmin
    .from('tenant_members')
    .select('id, user_id, role_id, invited_at, invite_accepted, status')
    .eq('tenant_id', owned.tenant_id)
    .eq('invite_accepted', false)
    .eq('status', 'pending');

  if (error) return res.status(500).json({ error: 'Failed to fetch invitations', details: error.message });

  // Enrich with user and role
  const enriched = await Promise.all(invitations.map(async (inv) => {
    const [{ data: user }, { data: role }] = await Promise.all([
      supabaseAdmin.from('users').select('id, email, full_name').eq('id', inv.user_id).single(),
      supabaseAdmin.from('roles').select('id, name').eq('id', inv.role_id).single()
    ]);
    return { ...inv, user, role };
  }));

  res.json({ invitations: enriched });
});

// ─────────────────────────────────────────────
// POST /api/v1/business/invite/accept — Accept an invitation (Invited user)
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business/invite/accept:
 *   post:
 *     summary: Accept a business invitation
 *     description: |
 *       Called by the invited user (using their own Bearer token) to accept a pending invitation.
 *       Looks up any pending invitation for the authenticated user and activates the membership.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - invitation_id
 *             properties:
 *               invitation_id:
 *                 type: string
 *                 description: The membership/invitation ID provided to the invited user
 *                 example: "uuid-of-invitation"
 *     responses:
 *       200:
 *         description: Invitation accepted, membership activated
 *       404:
 *         description: Invitation not found or does not belong to this user
 *       409:
 *         description: Invitation already accepted
 */
router.post('/invite/accept', requireAuth, async (req, res) => {
  const { invitation_id } = req.body;

  if (!invitation_id) {
    return res.status(400).json({ error: 'invitation_id is required' });
  }

  // Find the invitation for this specific user
  const { data: invite, error: fetchError } = await supabaseAdmin
    .from('tenant_members')
    .select('id, invite_accepted, status, tenant_id, tenants(name)')
    .eq('id', invitation_id)
    .eq('user_id', req.user.id)
    .single();

  if (fetchError || !invite) {
    return res.status(404).json({ error: 'Invitation not found or does not belong to your account' });
  }

  if (invite.invite_accepted) {
    return res.status(409).json({ error: 'This invitation has already been accepted' });
  }

  if (invite.status !== 'pending') {
    return res.status(409).json({ error: `Invitation is no longer valid (status: ${invite.status})` });
  }

  const { data: membership, error: updateError } = await supabaseAdmin
    .from('tenant_members')
    .update({
      invite_accepted: true,
      status: 'active',
      joined_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', invitation_id)
    .select()
    .single();

  if (updateError) {
    return res.status(500).json({ error: 'Failed to accept invitation', details: updateError.message });
  }

  sendInvitationAcceptedEmail({
    tenantId: invite.tenant_id,
    tenantName: invite.tenants?.name,
    memberName: req.user.full_name,
  }).catch(err => console.error('[email] invitationAccepted:', err.message));

  res.json({
    message: `Welcome! You have joined ${invite.tenants?.name || 'the business'}.`,
    membership
  });
});

// ─────────────────────────────────────────────
// DELETE /api/v1/business/members/:memberId — Remove a member (Owner only)
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business/members/{memberId}:
 *   delete:
 *     summary: Remove a team member (Owner only)
 *     description: Removes (soft-deletes) a member from the business. Owners cannot remove themselves.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: memberId
 *         required: true
 *         schema:
 *           type: string
 *         description: The tenant_member ID of the member to remove
 *     responses:
 *       200:
 *         description: Member removed
 *       403:
 *         description: Cannot remove yourself or not an owner
 *       404:
 *         description: Member not found
 */
router.delete(['/members/:memberId', '/members'], requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'Only business owners can remove members' });

  const memberId = req.params.memberId || req.query.memberId;
  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required either as a path parameter or query parameter' });
  }

  // Verify membership belongs to this tenant
  const { data: member, error: fetchError } = await supabaseAdmin
    .from('tenant_members')
    .select('id, user_id, is_owner')
    .eq('id', memberId)
    .eq('tenant_id', owned.tenant_id)
    .single();

  if (fetchError || !member) return res.status(404).json({ error: 'Member not found in your business' });

  if (member.user_id === req.user.id) {
    return res.status(403).json({ error: 'You cannot remove yourself. Transfer ownership first.' });
  }

  if (member.is_owner) {
    return res.status(403).json({ error: 'Cannot remove another owner' });
  }

  const { error } = await supabaseAdmin
    .from('tenant_members')
    .update({ status: 'removed', updated_at: new Date().toISOString() })
    .eq('id', memberId);

  if (error) return res.status(500).json({ error: 'Failed to remove member', details: error.message });

  res.json({ message: 'Member removed from business successfully' });
});

// ─────────────────────────────────────────────
// PATCH /api/v1/business/members/:memberId — Update member role (Owner only)
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/business/members/{memberId}:
 *   patch:
 *     summary: Update member role (Owner only)
 *     description: Changes the role of an existing active team member.
 *     tags:
 *       - Business
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: memberId
 *         required: true
 *         schema:
 *           type: string
 *         description: The tenant_member ID to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role
 *             properties:
 *               role:
 *                 type: string
 *                 description: New role name
 *                 example: billing
 *     responses:
 *       200:
 *         description: Member role updated
 *       400:
 *         description: Invalid role
 *       403:
 *         description: Owner access required
 *       404:
 *         description: Member not found
 */
router.patch(['/members/:memberId', '/members'], requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'Only business owners can change member roles' });

  const memberId = req.params.memberId || req.query.memberId;
  const { role } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required either as a path parameter or query parameter' });
  }

  const VALID_ROLES = ['admin', 'developer', 'billing', 'viewer'];
  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid or missing role', allowed: VALID_ROLES });
  }

  // Verify membership belongs to this tenant
  const { data: member, error: fetchError } = await supabaseAdmin
    .from('tenant_members')
    .select('id, user_id, is_owner')
    .eq('id', memberId)
    .eq('tenant_id', owned.tenant_id)
    .eq('status', 'active')
    .single();

  if (fetchError || !member) return res.status(404).json({ error: 'Active member not found in your business' });

  if (member.is_owner) {
    return res.status(403).json({ error: 'Cannot change the role of the business owner' });
  }

  // Get the role ID
  const { data: roleRecord } = await supabaseAdmin
    .from('roles')
    .select('id')
    .eq('name', role)
    .single();

  if (!roleRecord) return res.status(500).json({ error: 'Role not found in system' });

  const { data: updated, error } = await supabaseAdmin
    .from('tenant_members')
    .update({ role_id: roleRecord.id, updated_at: new Date().toISOString() })
    .eq('id', memberId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to update member role', details: error.message });

  res.json({ message: `Member role updated to '${role}' successfully`, membership: updated });
});

module.exports = router;

