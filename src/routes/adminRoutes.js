const { Router } = require("express");
const { supabaseAdmin } = require("../config/supabase");
const { requireAuth } = require("../middlewares/authMiddleware");
const { cacheGet, cacheSet, cacheDel } = require("../utils/cache");
const {
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendSenderIdApprovedEmail,
  sendSenderIdRejectedEmail,
  sendEnterpriseAssignedEmail,
} = require("../services/emailService");

// Cache TTLs
const PRICING_TTL = 1800; // 30 minutes
const TIERS_TTL = 1800; // 30 minutes
const PRICING_KEY = "admin:pricing:all";
const TIERS_KEY = "admin:tiers:all";

const router = Router();

function requirePlatformAdmin(req, res, next) {
	if (!req.user?.is_platform_admin) {
		return res.status(403).json({ error: "Platform admin access required" });
	}
	next();
}

/**
 * @swagger
 * /api/v1/admin/pricing:
 *   get:
 *     summary: List all channel prices
 *     description: Returns the global pricing table for all channels. Platform admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of channel prices
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pricing:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       channel:
 *                         type: string
 *                         example: sms
 *                       unit_label:
 *                         type: string
 *                         example: SMS
 *                       price_per_unit:
 *                         type: number
 *                         example: 18.0
 *                       currency:
 *                         type: string
 *                         example: MWK
 *                       is_active:
 *                         type: boolean
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Platform admin access required
 */
router.get("/pricing", requireAuth, requirePlatformAdmin, async (req, res) => {
	// ── Cache hit ──────────────────────────────────────────────────────────
	const cached = await cacheGet(PRICING_KEY);
	if (cached) return res.json({ pricing: cached });

	const { data: pricing, error } = await supabaseAdmin
		.from("platform_pricing")
		.select(
			"id, channel, unit_label, price_per_unit, currency, is_active, updated_at",
		)
		.order("channel");

	if (error) {
		console.error("Admin Pricing Error:", error);
		return res.status(500).json({ error: "Failed to load pricing" });
	}

	cacheSet(PRICING_KEY, pricing, PRICING_TTL);
	return res.json({ pricing });
});

/**
 * @swagger
 * /api/v1/admin/pricing/{channel}:
 *   patch:
 *     summary: Update global price for a channel
 *     description: |
 *       Updates the global price per unit for a channel (e.g. sms).
 *       A database trigger automatically recalculates `cached_bundle_price_mwk` on all affected bundle tiers.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: channel
 *         required: true
 *         schema:
 *           type: string
 *           enum: [sms, whatsapp, email, ussd]
 *         example: sms
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - price_per_unit
 *             properties:
 *               price_per_unit:
 *                 type: number
 *                 description: New price per unit in MWK (must be > 0)
 *                 example: 20.0
 *     responses:
 *       200:
 *         description: Price updated; response includes updated tier previews
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pricing:
 *                   type: object
 *                 affected_tiers:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Invalid price_per_unit
 *       404:
 *         description: Channel not found in pricing table
 */
router.patch(
	"/pricing/:channel",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { channel } = req.params;
		const { price_per_unit } = req.body;
		const user = req.user;

		if (typeof price_per_unit !== "number" || price_per_unit <= 0) {
			return res
				.status(400)
				.json({ error: "price_per_unit must be a positive number" });
		}

		const { data: updated, error } = await supabaseAdmin
			.from("platform_pricing")
			.update({ price_per_unit, updated_by: user.id })
			.eq("channel", channel)
			.eq("currency", "MWK")
			.select()
			.single();

		if (error || !updated) {
			return res
				.status(404)
				.json({ error: "Pricing entry not found for this channel" });
		}

		// Invalidate pricing and tiers caches — tiers embed the per-unit price
		await Promise.all([cacheDel(PRICING_KEY), cacheDel(TIERS_KEY)]);

		// Trigger has already fired and updated cached_bundle_price_mwk on all bundle tiers
		const { data: tiers } = await supabaseAdmin
			.from("v_tier_pricing")
			.select(
				"id, name, sms_credits_included, bundle_discount_pct, computed_bundle_price_mwk, cached_bundle_price_mwk",
			)
			.eq("tier_type", "bundle")
			.eq("is_active", true)
			.order("sort_order");

		return res.json({ pricing: updated, affected_tiers: tiers || [] });
	},
);

/**
 * @swagger
 * /api/v1/admin/tiers:
 *   get:
 *     summary: List all subscription tiers (admin view)
 *     description: Returns all tiers including Enterprise, with cached and computed prices. Platform admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: All tiers with pricing data
 */
router.get("/tiers", requireAuth, requirePlatformAdmin, async (req, res) => {
	// ── Cache hit ──────────────────────────────────────────────────────────
	const cached = await cacheGet(TIERS_KEY);
	if (cached) return res.json({ tiers: cached });

	const { data: tiers, error } = await supabaseAdmin
		.from("v_tier_pricing")
		.select("*")
		.order("sort_order");

	if (error) {
		console.error("Admin Tiers Error:", error);
		return res.status(500).json({ error: "Failed to load tiers" });
	}

	cacheSet(TIERS_KEY, tiers, TIERS_TTL);
	return res.json({ tiers });
});

/**
 * @swagger
 * /api/v1/admin/tiers/{id}/discount:
 *   patch:
 *     summary: Update bundle discount percentage
 *     description: |
 *       Updates the discount applied to a bundle tier's computed price.
 *       A database trigger automatically recalculates `cached_bundle_price_mwk`.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Bundle tier UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bundle_discount_pct
 *             properties:
 *               bundle_discount_pct:
 *                 type: number
 *                 description: Discount percentage (0 to 99.99)
 *                 example: 10.0
 *     responses:
 *       200:
 *         description: Discount updated; returns fresh tier data with recomputed prices
 *       400:
 *         description: Invalid discount percentage
 *       404:
 *         description: Bundle tier not found
 */
router.patch(
	"/tiers/:id/discount",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;
		const { bundle_discount_pct } = req.body;

		if (
			typeof bundle_discount_pct !== "number" ||
			bundle_discount_pct < 0 ||
			bundle_discount_pct >= 100
		) {
			return res
				.status(400)
				.json({ error: "bundle_discount_pct must be between 0 and 99.99" });
		}

		const { error } = await supabaseAdmin
			.from("subscription_tiers")
			.update({ bundle_discount_pct })
			.eq("id", id)
			.eq("tier_type", "bundle");

		if (error) {
			return res.status(404).json({ error: "Bundle tier not found" });
		}

		// Invalidate tiers cache so updated discount is reflected immediately
		await cacheDel(TIERS_KEY);

		// Return fresh values after trigger has fired
		const { data: tier } = await supabaseAdmin
			.from("v_tier_pricing")
			.select(
				"id, name, sms_credits_included, bundle_discount_pct, computed_bundle_price_mwk, cached_bundle_price_mwk, full_price_mwk",
			)
			.eq("id", id)
			.single();

		return res.json({ tier });
	},
);

/**
 * @swagger
 * /api/v1/admin/enterprise:
 *   post:
 *     summary: Assign a tenant to the Enterprise plan
 *     description: |
 *       Moves a tenant onto the postpaid Enterprise plan. No payment is required.
 *       Only platform admins can perform this action. Creates an audit order record.
 *     tags:
 *       - Admin
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
 *               - tenant_id
 *             properties:
 *               tenant_id:
 *                 type: string
 *                 description: UUID of the tenant to assign
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *               notes:
 *                 type: string
 *                 description: Optional internal notes for the assignment
 *                 example: "High-volume client — agreed in contract"
 *     responses:
 *       201:
 *         description: Tenant successfully assigned to Enterprise plan
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 tenant_id:
 *                   type: string
 *                 order_id:
 *                   type: string
 *                 previous_tier_id:
 *                   type: string
 *       400:
 *         description: Tenant is not active
 *       404:
 *         description: Tenant not found
 *       500:
 *         description: Enterprise tier not configured or assignment failed
 */
router.post(
	"/enterprise",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { tenant_id, notes } = req.body;
		const user = req.user;

		if (!tenant_id) {
			return res.status(400).json({ error: "tenant_id is required" });
		}

		try {
			const { data: tenant, error: tenantError } = await supabaseAdmin
				.from("tenants")
				.select("id, subscription_tier_id, status")
				.eq("id", tenant_id)
				.single();

			if (tenantError || !tenant) {
				return res.status(404).json({ error: "Tenant not found" });
			}

			if (tenant.status !== "active") {
				return res.status(400).json({ error: "Tenant is not active" });
			}

			const { data: enterpriseTier } = await supabaseAdmin
				.from("subscription_tiers")
				.select("id")
				.eq("tier_type", "enterprise")
				.eq("is_active", true)
				.single();

			if (!enterpriseTier) {
				return res
					.status(500)
					.json({ error: "Enterprise tier not configured" });
			}

			await supabaseAdmin
				.from("tenants")
				.update({ subscription_tier_id: enterpriseTier.id })
				.eq("id", tenant_id);

			const { data: order } = await supabaseAdmin
				.from("orders")
				.insert({
					tenant_id,
					created_by: user.id,
					order_type: "enterprise_assignment",
					channel: "sms",
					tier_id: enterpriseTier.id,
					status: "fulfilled",
					fulfilled_at: new Date().toISOString(),
					notes,
					metadata: {
						previous_tier_id: tenant.subscription_tier_id,
						assigned_by: user.id,
					},
				})
				.select()
				.single();

			sendEnterpriseAssignedEmail({ tenantId: tenant_id })
				.catch(err => console.error('[email] enterpriseAssigned:', err.message));

			return res.status(201).json({
				message: "Tenant successfully assigned to Enterprise plan",
				tenant_id,
				order_id: order.id,
				previous_tier_id: tenant.subscription_tier_id,
			});
		} catch (error) {
			console.error("Enterprise Assignment Error:", error);
			return res
				.status(500)
				.json({ error: "Failed to assign enterprise plan" });
		}
	},
);

// ─────────────────────────────────────────────────────────────
// KYC ADMIN ROUTES
// ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/kyc:
 *   get:
 *     summary: List KYC submissions pending review
 *     description: Returns all businesses that have submitted KYC documents and are awaiting admin review. Platform admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [submitted, approved, rejected, pending]
 *         description: Filter by KYC status (default: submitted)
 *     responses:
 *       200:
 *         description: List of KYC submissions
 */
router.get("/kyc", requireAuth, requirePlatformAdmin, async (req, res) => {
	const status = req.query.status || "submitted";

	const { data: tenants, error } = await supabaseAdmin
		.from("tenants")
		.select(
			`
      id,
      name,
      kyc_status,
      kyc_submitted_at,
      kyc_reviewed_at,
      kyc_rejection_reason,
      created_at,
      kyc_documents (
        id,
        document_type,
        document_name,
        file_url,
        storage_provider,
        storage_path,
        status,
        mime_type,
        file_size,
        created_at
      )
    `,
		)
		.eq("kyc_status", status)
		.order("kyc_submitted_at", { ascending: true });

	if (error) {
		console.error("Admin KYC list error:", error);
		return res.status(500).json({ error: "Failed to load KYC submissions" });
	}

	return res.json({
		submissions: tenants || [],
		count: (tenants || []).length,
	});
});

/**
 * @swagger
 * /api/v1/admin/kyc/{tenantId}:
 *   get:
 *     summary: Get full KYC details for a business
 *     description: Returns all KYC documents and business info for a specific tenant. Platform admin only.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tenantId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full KYC details for the business
 *       404:
 *         description: Tenant not found
 */
router.get(
	"/kyc/:tenantId",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { tenantId } = req.params;

		// Fetch tenant and documents separately to avoid !inner join masking the tenant
		const [tenantResult, docsResult, membersResult] = await Promise.all([
			supabaseAdmin
				.from("tenants")
				.select(
					"id, name, kyc_status, kyc_submitted_at, kyc_reviewed_at, kyc_rejection_reason, status, created_at",
				)
				.eq("id", tenantId)
				.single(),

			supabaseAdmin
				.from("kyc_documents")
				.select(
					"id, document_type, id_type, document_name, file_url, storage_provider, storage_path, status, mime_type, file_size, rejection_reason, created_at, updated_at",
				)
				.eq("tenant_id", tenantId)
				.order("created_at", { ascending: true }),

			supabaseAdmin
				.from("tenant_members")
				.select("users!user_id (id, full_name, email)")
				.eq("tenant_id", tenantId)
				.eq("is_owner", true),
		]);

		if (tenantResult.error || !tenantResult.data) {
			console.error(
				"Admin KYC detail — tenant lookup error:",
				tenantResult.error,
			);
			return res.status(404).json({ error: "Tenant not found" });
		}

		return res.json({
			tenant: {
				...tenantResult.data,
				kyc_documents: docsResult.data || [],
				owner: membersResult.data?.[0]?.users || null,
			},
		});
	},
);

/**
 * @swagger
 * /api/v1/admin/kyc/{tenantId}/approve:
 *   post:
 *     summary: Approve a business KYC submission
 *     description: |
 *       Marks the tenant as KYC-approved. This unlocks the business to:
 *       - Apply for sender ID whitelisting
 *       - Send SMS messages
 *       - Access all platform features
 *
 *       All submitted documents are marked as approved automatically.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tenantId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Optional internal review notes
 *                 example: "Documents verified — certificate matches business registration."
 *     responses:
 *       200:
 *         description: KYC approved successfully
 *       400:
 *         description: Business has not submitted KYC documents
 *       404:
 *         description: Tenant not found
 */
router.post(
	"/kyc/:tenantId/approve",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { tenantId } = req.params;
		const { notes } = req.body || {};
		const admin = req.user;

		const { data: tenant, error: tenantError } = await supabaseAdmin
			.from("tenants")
			.select("id, name, kyc_status")
			.eq("id", tenantId)
			.single();

		if (tenantError || !tenant) {
			return res.status(404).json({ error: "Tenant not found" });
		}

		if (tenant.kyc_status === "pending") {
			return res
				.status(400)
				.json({
					error: "This business has not submitted any KYC documents yet",
				});
		}

		if (tenant.kyc_status === "approved") {
			return res
				.status(400)
				.json({ error: "KYC is already approved for this business" });
		}

		const now = new Date().toISOString();

		// Approve all pending/submitted documents in one shot
		await supabaseAdmin
			.from("kyc_documents")
			.update({
				status: "approved",
				reviewed_by: admin.id,
				reviewed_at: now,
				notes: notes || null,
			})
			.eq("tenant_id", tenantId)
			.in("status", ["pending", "submitted"]);

		// Mark the tenant as KYC approved
		const { error: updateError } = await supabaseAdmin
			.from("tenants")
			.update({
				kyc_status: "approved",
				kyc_reviewed_at: now,
				kyc_rejection_reason: null,
			})
			.eq("id", tenantId);

		if (updateError) {
			console.error("KYC approve error:", updateError);
			return res.status(500).json({ error: "Failed to approve KYC" });
		}

		sendKycApprovedEmail({ tenantId, tenantName: tenant.name })
			.catch(err => console.error('[email] kycApproved:', err.message));

		return res.json({
			message: `KYC approved for ${tenant.name}. Business is now verified and fully active.`,
			tenant_id: tenantId,
			kyc_status: "approved",
			reviewed_by: admin.id,
			reviewed_at: now,
		});
	},
);

/**
 * @swagger
 * /api/v1/admin/kyc/{tenantId}/reject:
 *   post:
 *     summary: Reject a business KYC submission
 *     description: |
 *       Rejects the KYC submission with a mandatory reason.
 *       The business owner will see the rejection reason and can resubmit corrected documents.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tenantId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for rejection shown to the business owner
 *                 example: "Business certificate is expired. Please upload a valid certificate."
 *               document_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional — specific document IDs to mark as rejected. If omitted, all pending documents are rejected.
 *     responses:
 *       200:
 *         description: KYC rejected
 *       400:
 *         description: Rejection reason is required
 *       404:
 *         description: Tenant not found
 */
router.post(
	"/kyc/:tenantId/reject",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { tenantId } = req.params;
		const body = req.body || {};
		const { reason, document_ids } = body;
		const admin = req.user;

		if (!reason || reason.trim().length === 0) {
			return res.status(400).json({ error: "A rejection reason is required" });
		}

		const { data: tenant, error: tenantError } = await supabaseAdmin
			.from("tenants")
			.select("id, name, kyc_status")
			.eq("id", tenantId)
			.single();

		if (tenantError || !tenant) {
			return res.status(404).json({ error: "Tenant not found" });
		}

		const now = new Date().toISOString();

		// Reject specific documents or all pending ones
		let docQuery = supabaseAdmin
			.from("kyc_documents")
			.update({
				status: "rejected",
				reviewed_by: admin.id,
				reviewed_at: now,
				rejection_reason: reason,
			})
			.eq("tenant_id", tenantId);

		if (Array.isArray(document_ids) && document_ids.length > 0) {
			docQuery = docQuery.in("id", document_ids);
		} else {
			docQuery = docQuery.in("status", ["pending", "submitted"]);
		}

		await docQuery;

		const { error: updateError } = await supabaseAdmin
			.from("tenants")
			.update({
				kyc_status: "rejected",
				kyc_reviewed_at: now,
				kyc_rejection_reason: reason,
			})
			.eq("id", tenantId);

		if (updateError) {
			console.error("KYC reject error:", updateError);
			return res.status(500).json({ error: "Failed to reject KYC" });
		}

		sendKycRejectedEmail({ tenantId, tenantName: tenant.name, reason })
			.catch(err => console.error('[email] kycRejected:', err.message));

		return res.json({
			message: `KYC rejected for ${tenant.name}. Owner has been notified of the reason.`,
			tenant_id: tenantId,
			kyc_status: "rejected",
			reason,
			reviewed_by: admin.id,
			reviewed_at: now,
		});
	},
);

// ─────────────────────────────────────────────────────────────
// GLOBAL SENDER ID MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/global-sender-ids:
 *   get:
 *     summary: List all global sender IDs
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of global sender IDs
 */
router.get(
	"/global-sender-ids",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { data: senderIds, error } = await supabaseAdmin
			.from("sender_ids")
			.select(
				"id, sender_id, display_name, description, channels, status, is_system, valid_from, valid_until, created_at, updated_at",
			)
			.eq("is_global", true)
			.order("sender_id");

		if (error) {
			console.error("Admin global sender IDs error:", error);
			return res
				.status(500)
				.json({ error: "Failed to load global sender IDs" });
		}

		return res.json({ sender_ids: senderIds || [] });
	},
);

/**
 * @swagger
 * /api/v1/admin/global-sender-ids:
 *   post:
 *     summary: Create a global sender ID
 *     description: Creates a new global sender ID available to all KYC-approved tenants.
 *     tags:
 *       - Admin
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
 *               - sender_id
 *               - display_name
 *             properties:
 *               sender_id:
 *                 type: string
 *                 example: LETTSCOMM
 *               display_name:
 *                 type: string
 *                 example: Letts Communications
 *               description:
 *                 type: string
 *               channels:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["sms"]
 *     responses:
 *       201:
 *         description: Global sender ID created
 *       400:
 *         description: Invalid sender_id format
 *       409:
 *         description: Sender ID already exists
 */
router.post(
	"/global-sender-ids",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const body = req.body || {};
		const { sender_id, display_name, description, channels } = body;

		if (!sender_id || !display_name) {
			return res
				.status(400)
				.json({ error: "sender_id and display_name are required" });
		}

		const normalized = String(sender_id).toUpperCase().trim();
		if (!/^[A-Z0-9]{3,11}$/.test(normalized)) {
			return res.status(400).json({
				error: "sender_id must be 3-11 alphanumeric characters",
				example: "LETTSCOMM",
			});
		}

		const { data: newSenderId, error } = await supabaseAdmin
			.from("sender_ids")
			.insert({
				sender_id: normalized,
				display_name: display_name.trim(),
				description: description ? description.trim() : null,
				is_global: true,
				is_system: false,
				tenant_id: null,
				status: "approved",
				channels:
					Array.isArray(channels) && channels.length > 0 ? channels : ["sms"],
				approved_by: req.user.id,
				approved_at: new Date().toISOString(),
				valid_from: new Date().toISOString(),
			})
			.select()
			.single();

		if (error) {
			if (error.code === "23505") {
				return res
					.status(409)
					.json({ error: `Global sender ID "${normalized}" already exists` });
			}
			console.error("Create global sender ID error:", error);
			return res
				.status(500)
				.json({ error: "Failed to create global sender ID" });
		}

		return res
			.status(201)
			.json({ message: "Global sender ID created", sender_id: newSenderId });
	},
);

/**
 * @swagger
 * /api/v1/admin/global-sender-ids/{id}:
 *   patch:
 *     summary: Update a global sender ID
 *     description: Update display name, description, channels, or suspend/reactivate a global sender ID.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               display_name:
 *                 type: string
 *               description:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [approved, suspended]
 *               channels:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Updated
 *       404:
 *         description: Not found
 */
router.patch(
	"/global-sender-ids/:id",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;
		const body = req.body || {};
		const { display_name, description, status, channels } = body;

		const allowed_statuses = ["approved", "suspended"];
		if (status && !allowed_statuses.includes(status)) {
			return res
				.status(400)
				.json({
					error: `status must be one of: ${allowed_statuses.join(", ")}`,
				});
		}

		const updates = {};
		if (display_name) updates.display_name = display_name.trim();
		if (description !== undefined)
			updates.description = description ? description.trim() : null;
		if (status) updates.status = status;
		if (Array.isArray(channels) && channels.length > 0)
			updates.channels = channels;

		if (Object.keys(updates).length === 0) {
			return res.status(400).json({ error: "No valid fields to update" });
		}

		const { data: updated, error } = await supabaseAdmin
			.from("sender_ids")
			.update(updates)
			.eq("id", id)
			.eq("is_global", true)
			.select()
			.single();

		if (error || !updated) {
			return res.status(404).json({ error: "Global sender ID not found" });
		}

		return res.json({ sender_id: updated });
	},
);

/**
 * @swagger
 * /api/v1/admin/global-sender-ids/{id}/usage:
 *   get:
 *     summary: Get per-tenant usage for a global sender ID
 *     description: Shows which merchants are using this global sender ID, their API key status, and message counts.
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Per-tenant usage breakdown
 */
router.get(
	"/global-sender-ids/:id/usage",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;

		const { data: usage, error } = await supabaseAdmin
			.from("v_global_sender_usage")
			.select("*")
			.eq("sender_id_id", id)
			.order("total_messages_sent", { ascending: false });

		if (error) {
			console.error("Global sender usage error:", error);
			return res.status(500).json({ error: "Failed to load usage data" });
		}

		return res.json({ usage: usage || [] });
	},
);

// ─────────────────────────────────────────────────────────────
// SENDER ID WHITELIST APPROVAL
// ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/admin/sender-ids:
 *   get:
 *     summary: List sender ID whitelist requests
 *     description: Returns all tenant sender ID requests. Filter by status (default: pending).
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, approved, rejected, suspended, all]
 *         description: Filter by status (default pending)
 *     responses:
 *       200:
 *         description: List of sender ID requests
 */
router.get(
	"/sender-ids",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const status = req.query.status || "pending";

		let query = supabaseAdmin
			.from("sender_ids")
			.select(
				`
      id,
      sender_id,
      display_name,
      description,
      channels,
      status,
      rejection_reason,
      requested_at,
      approved_at,
      created_at,
      tenants!tenant_id (
        id,
        name,
        kyc_status
      )
    `,
			)
			.eq("is_global", false)
			.order("requested_at", { ascending: true });

		if (status !== "all") {
			query = query.eq("status", status);
		}

		const { data: senderIds, error } = await query;

		if (error) {
			console.error("Admin sender IDs list error:", error);
			return res
				.status(500)
				.json({ error: "Failed to load sender ID requests" });
		}

		return res.json({
			sender_ids: senderIds || [],
			count: (senderIds || []).length,
		});
	},
);

/**
 * @swagger
 * /api/v1/admin/sender-ids/{id}:
 *   get:
 *     summary: Get full detail of a sender ID request
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sender ID detail including tenant and owner info
 *       404:
 *         description: Not found
 */
router.get(
	"/sender-ids/:id",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const [senderResult, memberResult] = await Promise.all([
			supabaseAdmin
				.from("sender_ids")
				.select(
					`
        id, sender_id, display_name, description, channels, status,
        rejection_reason, review_notes, requested_at, approved_at,
        valid_from, valid_until, created_at, updated_at,
        tenants!tenant_id (id, name, kyc_status, status)
      `,
				)
				.eq("id", req.params.id)
				.eq("is_global", false)
				.single(),

			supabaseAdmin
				.from("sender_ids")
				.select("tenant_id")
				.eq("id", req.params.id)
				.single(),
		]);

		if (senderResult.error || !senderResult.data) {
			return res.status(404).json({ error: "Sender ID request not found" });
		}

		// Fetch tenant owner separately
		let owner = null;
		if (memberResult.data?.tenant_id) {
			const { data: member } = await supabaseAdmin
				.from("tenant_members")
				.select("users!user_id (id, full_name, email)")
				.eq("tenant_id", memberResult.data.tenant_id)
				.eq("is_owner", true)
				.single();
			owner = member?.users || null;
		}

		return res.json({ sender_id: { ...senderResult.data, owner } });
	},
);

/**
 * @swagger
 * /api/v1/admin/sender-ids/{id}/approve:
 *   post:
 *     summary: Approve a sender ID request
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Optional internal review notes
 *     responses:
 *       200:
 *         description: Sender ID approved
 *       400:
 *         description: Request is not in pending status
 *       404:
 *         description: Not found
 */
router.post(
	"/sender-ids/:id/approve",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;
		const { notes } = req.body || {};
		const now = new Date().toISOString();

		const { data: existing, error: fetchError } = await supabaseAdmin
			.from("sender_ids")
			.select("id, sender_id, status, tenant_id")
			.eq("id", id)
			.eq("is_global", false)
			.single();

		if (fetchError || !existing) {
			return res.status(404).json({ error: "Sender ID request not found" });
		}

		if (existing.status !== "pending") {
			return res.status(400).json({
				error: `Cannot approve a request with status "${existing.status}". Only pending requests can be approved.`,
			});
		}

		const { data: updated, error } = await supabaseAdmin
			.from("sender_ids")
			.update({
				status: "approved",
				approved_by: req.user.id,
				approved_at: now,
				valid_from: now,
				review_notes: notes || null,
			})
			.eq("id", id)
			.select()
			.single();

		if (error) {
			console.error("Sender ID approve error:", error);
			return res.status(500).json({ error: "Failed to approve sender ID" });
		}

		sendSenderIdApprovedEmail({ tenantId: existing.tenant_id, senderId: existing.sender_id })
			.catch(err => console.error('[email] senderIdApproved:', err.message));

		return res.json({
			message: `Sender ID "${existing.sender_id}" approved successfully.`,
			sender_id: updated,
		});
	},
);

/**
 * @swagger
 * /api/v1/admin/sender-ids/{id}/reject:
 *   post:
 *     summary: Reject a sender ID request
 *     tags:
 *       - Admin
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Rejection reason shown to the tenant
 *               notes:
 *                 type: string
 *                 description: Optional internal admin notes
 *     responses:
 *       200:
 *         description: Sender ID rejected
 *       400:
 *         description: reason is required or request already processed
 *       404:
 *         description: Not found
 */
router.post(
	"/sender-ids/:id/reject",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;
		const body = req.body || {};
		const { reason, notes } = body;

		if (!reason || reason.trim().length === 0) {
			return res.status(400).json({ error: "A rejection reason is required" });
		}

		const { data: existing, error: fetchError } = await supabaseAdmin
			.from("sender_ids")
			.select("id, sender_id, status, tenant_id")
			.eq("id", id)
			.eq("is_global", false)
			.single();

		if (fetchError || !existing) {
			return res.status(404).json({ error: "Sender ID request not found" });
		}

		if (existing.status === "approved") {
			return res
				.status(400)
				.json({ error: "Cannot reject an already approved sender ID" });
		}

		const { data: updated, error } = await supabaseAdmin
			.from("sender_ids")
			.update({
				status: "rejected",
				rejection_reason: reason.trim(),
				review_notes: notes ? notes.trim() : null,
				approved_by: req.user.id,
			})
			.eq("id", id)
			.select()
			.single();

		if (error) {
			console.error("Sender ID reject error:", error);
			return res.status(500).json({ error: "Failed to reject sender ID" });
		}

		sendSenderIdRejectedEmail({ tenantId: existing.tenant_id, senderId: existing.sender_id, reason: reason.trim() })
			.catch(err => console.error('[email] senderIdRejected:', err.message));

		return res.json({
			message: `Sender ID "${existing.sender_id}" rejected.`,
			sender_id: updated,
		});
	},
);

module.exports = router;
