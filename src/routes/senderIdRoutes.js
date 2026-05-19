const { Router } = require("express");
const { requireAuth } = require("../middlewares/authMiddleware");
const { supabaseAdmin } = require("../config/supabase");
const { cacheGet, cacheSet } = require("../utils/cache");

// Global sender IDs don't change often — cache for 10 minutes
const GLOBAL_SENDER_IDS_KEY = "senderids:global";
const GLOBAL_SENDER_IDS_TTL = 600;

const router = Router();

async function requireVerifiedTenant(req, res, next) {
	const { data, error } = await supabaseAdmin
		.from("tenant_members")
		.select(
			"tenant_id, tenants(id, name, kyc_status, whitelist_agreement_signed_at)",
		)
		.eq("user_id", req.user.id)
		.eq("is_owner", true)
		.eq("status", "active")
		.single();

	if (error || !data) {
		return res.status(403).json({ error: "No business account found" });
	}

	if (data.tenants.kyc_status !== "approved") {
		return res.status(403).json({
			error: "KYC must be fully approved before using sender IDs",
			kyc_status: data.tenants.kyc_status,
		});
	}

	req.ownedTenant = data;
	next();
}

// ─────────────────────────────────────────────
// GET /api/v1/sender-ids/global
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/sender-ids/global:
 *   get:
 *     summary: List available global sender IDs
 *     description: |
 *       Returns all active global sender IDs available to verified tenants.
 *       Any KYC-approved business can create an API key bound to a global sender ID
 *       without needing a separate whitelist request.
 *     tags:
 *       - Sender IDs
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of active global sender IDs
 *       403:
 *         description: KYC not approved
 */
router.get("/global", requireAuth, requireVerifiedTenant, async (req, res) => {
	// ── Cache hit ──────────────────────────────────────────────────────────
	const cached = await cacheGet(GLOBAL_SENDER_IDS_KEY);
	if (cached) return res.json({ sender_ids: cached });

	const { data: senderIds, error } = await supabaseAdmin
		.from("sender_ids")
		.select(
			"id, sender_id, display_name, description, channels, valid_from, valid_until",
		)
		.eq("is_global", true)
		.eq("status", "approved")
		.order("sender_id");

	if (error) {
		console.error("Global sender IDs error:", error);
		return res.status(500).json({ error: "Failed to load global sender IDs" });
	}

	cacheSet(GLOBAL_SENDER_IDS_KEY, senderIds || [], GLOBAL_SENDER_IDS_TTL);
	return res.json({ sender_ids: senderIds || [] });
});

// ─────────────────────────────────────────────
// GET /api/v1/sender-ids
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/sender-ids:
 *   get:
 *     summary: List your sender ID requests
 *     description: Returns all sender ID requests for the authenticated owner's business.
 *     tags:
 *       - Sender IDs
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of sender IDs with their current status
 *       403:
 *         description: KYC not approved
 */
router.get("/", requireAuth, requireVerifiedTenant, async (req, res) => {
	const { data: senderIds, error } = await supabaseAdmin
		.from("sender_ids")
		.select(
			"id, sender_id, display_name, description, channels, status, rejection_reason, requested_at, approved_at, valid_from, valid_until, created_at, updated_at",
		)
		.eq("tenant_id", req.ownedTenant.tenant_id)
		.eq("is_global", false)
		.order("created_at", { ascending: false });

	if (error) {
		console.error("List sender IDs error:", error);
		return res.status(500).json({ error: "Failed to load sender IDs" });
	}

	return res.json({ sender_ids: senderIds || [] });
});

// ─────────────────────────────────────────────
// POST /api/v1/sender-ids
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/sender-ids:
 *   post:
 *     summary: Request a sender ID whitelist
 *     description: |
 *       Submits a sender ID whitelist request. Only KYC-approved businesses may apply.
 *       Approval typically takes **48 working hours**.
 *
 *       **First-time applicants:** optionally include `agreement_document_url` (signed
 *       whitelist agreement document uploaded by the frontend). Not mandatory.
 *
 *       **Sender ID format:** 3–11 alphanumeric characters, no spaces.
 *       Examples: `MYSHOP`, `SURGE`, `BANK123`
 *     tags:
 *       - Sender IDs
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
 *                 description: Alphanumeric sender ID (3-11 chars, will be uppercased)
 *                 example: MYSHOP
 *               display_name:
 *                 type: string
 *                 description: Human-readable name for this sender ID
 *                 example: My Shop Ltd
 *               description:
 *                 type: string
 *                 description: Optional description of intended use
 *               agreement_document_url:
 *                 type: string
 *                 description: Optional — URL of signed whitelist agreement document (first-time only)
 *     responses:
 *       201:
 *         description: Sender ID request submitted successfully
 *       400:
 *         description: Invalid sender_id format or missing required fields
 *       409:
 *         description: A non-rejected request for this sender ID already exists
 *       403:
 *         description: KYC not approved
 */
router.post("/", requireAuth, requireVerifiedTenant, async (req, res) => {
	const tenantId = req.ownedTenant.tenant_id;
	const body = req.body || {};
	const { sender_id, display_name, description, agreement_document_url } = body;

	if (!sender_id || !display_name) {
		return res
			.status(400)
			.json({ error: "sender_id and display_name are required" });
	}

	const normalized = String(sender_id).toUpperCase().trim();
	if (!/^[A-Z0-9]{3,11}$/.test(normalized)) {
		return res.status(400).json({
			error:
				"sender_id must be 3-11 alphanumeric characters (letters and numbers only, no spaces)",
			example: "MYSHOP",
		});
	}

	// Block if a non-rejected request already exists for this tenant + sender_id
	const { data: existing } = await supabaseAdmin
		.from("sender_ids")
		.select("id, status")
		.eq("tenant_id", tenantId)
		.eq("sender_id", normalized)
		.neq("status", "rejected")
		.maybeSingle();

	if (existing) {
		return res.status(409).json({
			error: `A sender ID request for "${normalized}" already exists`,
			status: existing.status,
			id: existing.id,
		});
	}

	// Save whitelist agreement on the tenant if provided and not already recorded
	if (
		agreement_document_url &&
		!req.ownedTenant.tenants.whitelist_agreement_signed_at
	) {
		try {
			new URL(agreement_document_url);
		} catch {
			return res
				.status(400)
				.json({ error: "agreement_document_url must be a valid URL" });
		}
		await supabaseAdmin
			.from("tenants")
			.update({
				whitelist_agreement_signed_at: new Date().toISOString(),
				whitelist_agreement_document_url: agreement_document_url,
			})
			.eq("id", tenantId);
	}

	const { data: newSenderId, error } = await supabaseAdmin
		.from("sender_ids")
		.insert({
			tenant_id: tenantId,
			sender_id: normalized,
			display_name: display_name.trim(),
			description: description ? description.trim() : null,
			is_global: false,
			is_system: false,
			status: "pending",
			channels: ["sms"],
			requested_by: req.user.id,
			requested_at: new Date().toISOString(),
		})
		.select()
		.single();

	if (error) {
		console.error("Sender ID request error:", error);
		return res
			.status(500)
			.json({ error: "Failed to submit sender ID request" });
	}

	return res.status(201).json({
		message:
			"Sender ID request submitted. Approval typically takes 48 working hours.",
		sender_id: newSenderId,
	});
});

// ─────────────────────────────────────────────
// GET /api/v1/sender-ids/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/sender-ids/{id}:
 *   get:
 *     summary: Get a sender ID request
 *     tags:
 *       - Sender IDs
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
 *         description: Sender ID detail
 *       404:
 *         description: Not found
 */
router.get("/:id", requireAuth, requireVerifiedTenant, async (req, res) => {
	const { data: senderId, error } = await supabaseAdmin
		.from("sender_ids")
		.select(
			"id, sender_id, display_name, description, channels, status, rejection_reason, requested_at, approved_at, valid_from, valid_until, created_at, updated_at",
		)
		.eq("id", req.params.id)
		.eq("tenant_id", req.ownedTenant.tenant_id)
		.single();

	if (error || !senderId) {
		return res.status(404).json({ error: "Sender ID not found" });
	}

	return res.json({ sender_id: senderId });
});

// ─────────────────────────────────────────────
// DELETE /api/v1/sender-ids/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/sender-ids/{id}:
 *   delete:
 *     summary: Cancel a pending sender ID request
 *     description: Only pending requests can be cancelled. Approved sender IDs cannot be deleted.
 *     tags:
 *       - Sender IDs
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
 *         description: Request cancelled
 *       400:
 *         description: Only pending requests can be cancelled
 *       404:
 *         description: Not found
 */
router.delete("/:id", requireAuth, requireVerifiedTenant, async (req, res) => {
	const { data: existing, error: fetchError } = await supabaseAdmin
		.from("sender_ids")
		.select("id, status, is_system")
		.eq("id", req.params.id)
		.eq("tenant_id", req.ownedTenant.tenant_id)
		.single();

	if (fetchError || !existing) {
		return res.status(404).json({ error: "Sender ID not found" });
	}

	if (existing.is_system) {
		return res
			.status(403)
			.json({ error: "System sender IDs cannot be deleted" });
	}

	if (existing.status !== "pending") {
		return res.status(400).json({
			error: `Only pending requests can be cancelled. Current status: ${existing.status}`,
		});
	}

	const { error } = await supabaseAdmin
		.from("sender_ids")
		.delete()
		.eq("id", req.params.id);

	if (error) {
		return res
			.status(500)
			.json({ error: "Failed to cancel sender ID request" });
	}

	return res.json({ message: "Sender ID request cancelled successfully" });
});

module.exports = router;
