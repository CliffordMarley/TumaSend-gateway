const { Router } = require("express");
const { supabaseAdmin } = require("../config/supabase");
const { requireAuth } = require("../middlewares/authMiddleware");
const {
	invalidateBlocklistCache,
	invalidateTenantExemptionsCache,
} = require("../services/contentModerationService");

const router = Router();

// All routes require platform admin (enforced by requirePlatformAdmin below).
// systemKeyAuth is applied at mount time in app.js.

function requirePlatformAdmin(req, res, next) {
	if (!req.user?.is_platform_admin) {
		return res.status(403).json({ error: "Platform admin access required" });
	}
	next();
}

// ─────────────────────────────────────────────
// GET /api/v1/admin/moderation/blocklist
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/blocklist:
 *   get:
 *     summary: List content blocklist
 *     description: Returns all terms on the content blocklist. Platform admin only.
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: active_only
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Filter to only active terms
 *       - in: query
 *         name: channel
 *         schema:
 *           type: string
 *           enum: [sms, whatsapp]
 *         description: Filter by channel
 *     responses:
 *       200:
 *         description: List of blocklist entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 blocklist:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       term:
 *                         type: string
 *                         example: free money
 *                       term_type:
 *                         type: string
 *                         enum: [word, phrase, regex]
 *                       channels:
 *                         type: array
 *                         items:
 *                           type: string
 *                         example: [sms, whatsapp]
 *                       severity:
 *                         type: string
 *                         enum: [block, flag]
 *                       note:
 *                         type: string
 *                         nullable: true
 *                       is_active:
 *                         type: boolean
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       updated_at:
 *                         type: string
 *                         format: date-time
 *                 total:
 *                   type: integer
 *                   example: 42
 *       403:
 *         description: Platform admin access required
 */
router.get(
	"/blocklist",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const activeOnly = req.query.active_only !== "false";
		const channel = req.query.channel;

		let query = supabaseAdmin
			.from("content_blocklist")
			.select(
				"id, term, term_type, channels, severity, category, note, is_active, created_by, created_at, updated_at",
			)
			.order("created_at", { ascending: false });

		if (activeOnly) query = query.eq("is_active", true);
		if (channel) query = query.contains("channels", [channel]);

		const { data, error } = await query;

		if (error) {
			console.error("[moderation] List blocklist error:", error.message);
			return res.status(500).json({ error: "Failed to load blocklist" });
		}

		return res.json({ blocklist: data || [], total: (data || []).length });
	},
);

// ─────────────────────────────────────────────
// POST /api/v1/admin/moderation/blocklist
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/blocklist:
 *   post:
 *     summary: Add a term to the blocklist
 *     description: |
 *       Adds a word, phrase, or regex pattern to the content blocklist.
 *
 *       - **word**: whole-word match (e.g. "kill" won't match "skill")
 *       - **phrase**: case-insensitive substring match anywhere in the message
 *       - **regex**: raw JavaScript-compatible regular expression (no flags needed)
 *
 *       Changes take effect within 60 seconds (Redis cache TTL).
 *     tags:
 *       - Moderation
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
 *               - term
 *             properties:
 *               term:
 *                 type: string
 *                 description: The word, phrase, or regex to block
 *                 example: free money
 *               term_type:
 *                 type: string
 *                 enum: [word, phrase, regex]
 *                 default: phrase
 *               channels:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [sms, whatsapp]
 *                 default: [sms, whatsapp]
 *               severity:
 *                 type: string
 *                 enum: [block, flag]
 *                 default: block
 *                 description: block — reject message with error; flag — allow but log for review
 *               note:
 *                 type: string
 *                 description: Admin note explaining why this term is blocked
 *     responses:
 *       201:
 *         description: Term added to blocklist
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Term added to blocklist
 *                 entry:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     term:
 *                       type: string
 *                       example: free money
 *                     term_type:
 *                       type: string
 *                       enum: [word, phrase, regex]
 *                     channels:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: [sms, whatsapp]
 *                     severity:
 *                       type: string
 *                       enum: [block, flag]
 *                     note:
 *                       type: string
 *                       nullable: true
 *                     is_active:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Missing term or invalid regex
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid regex: Unterminated group
 *       409:
 *         description: Term already exists with this type
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: This term with this type already exists on the blocklist
 *       403:
 *         description: Platform admin access required
 */
router.post(
	"/blocklist",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const {
			term,
			term_type = "phrase",
			channels = ["sms", "whatsapp"],
			severity = "block",
			category = "general",
			note,
		} = req.body;

		if (!term || typeof term !== "string" || term.trim().length === 0) {
			return res.status(400).json({ error: "term is required" });
		}

		const validTypes = ["word", "phrase", "regex"];
		if (!validTypes.includes(term_type)) {
			return res
				.status(400)
				.json({ error: `term_type must be one of: ${validTypes.join(", ")}` });
		}

		const validCategories = ["profanity", "hate_speech", "fraud", "phishing", "gambling_marketing", "spam", "explicit", "general"];
		if (!validCategories.includes(category)) {
			return res
				.status(400)
				.json({ error: `category must be one of: ${validCategories.join(", ")}` });
		}

		const validChannels = ["sms", "whatsapp"];
		const invalidChannels = channels.filter(c => !validChannels.includes(c));
		if (invalidChannels.length > 0) {
			return res
				.status(400)
				.json({ error: `Invalid channels: ${invalidChannels.join(", ")}` });
		}

		if (!["block", "flag"].includes(severity)) {
			return res
				.status(400)
				.json({ error: 'severity must be "block" or "flag"' });
		}

		if (term_type === "regex") {
			try {
				new RegExp(term.trim(), "i");
			} catch (e) {
				return res.status(400).json({ error: `Invalid regex: ${e.message}` });
			}
		}

		const { data, error } = await supabaseAdmin
			.from("content_blocklist")
			.insert({
				term: term.trim(),
				term_type,
				channels,
				severity,
				category,
				note: note || null,
				is_active: true,
				created_by: req.user.id,
			})
			.select(
				"id, term, term_type, channels, severity, category, note, is_active, created_at",
			)
			.single();

		if (error) {
			if (error.code === "23505") {
				return res
					.status(409)
					.json({
						error: "This term with this type already exists on the blocklist",
					});
			}
			console.error("[moderation] Add term error:", error.message);
			return res.status(500).json({ error: "Failed to add term" });
		}

		await invalidateBlocklistCache();

		return res
			.status(201)
			.json({ message: "Term added to blocklist", entry: data });
	},
);

// ─────────────────────────────────────────────
// PATCH /api/v1/admin/moderation/blocklist/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/blocklist/{id}:
 *   patch:
 *     summary: Update a blocklist entry
 *     description: Update severity, channels, active status, or note for a blocklist entry.
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               severity:
 *                 type: string
 *                 enum: [block, flag]
 *               channels:
 *                 type: array
 *                 items:
 *                   type: string
 *               is_active:
 *                 type: boolean
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: Entry updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Entry updated
 *                 entry:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     term:
 *                       type: string
 *                     term_type:
 *                       type: string
 *                       enum: [word, phrase, regex]
 *                     channels:
 *                       type: array
 *                       items:
 *                         type: string
 *                     severity:
 *                       type: string
 *                       enum: [block, flag]
 *                     note:
 *                       type: string
 *                       nullable: true
 *                     is_active:
 *                       type: boolean
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: No valid fields to update
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: No valid fields to update
 *       404:
 *         description: Entry not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Blocklist entry not found
 *       403:
 *         description: Platform admin access required
 */
router.patch(
	"/blocklist/:id",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;
		const { severity, channels, is_active, note } = req.body;

		const updates = {};
		if (severity !== undefined) {
			if (!["block", "flag"].includes(severity)) {
				return res
					.status(400)
					.json({ error: 'severity must be "block" or "flag"' });
			}
			updates.severity = severity;
		}
		if (channels !== undefined) updates.channels = channels;
		if (is_active !== undefined) updates.is_active = Boolean(is_active);
		if (note !== undefined) updates.note = note;

		if (Object.keys(updates).length === 0) {
			return res.status(400).json({ error: "No valid fields to update" });
		}

		const { data, error } = await supabaseAdmin
			.from("content_blocklist")
			.update(updates)
			.eq("id", id)
			.select(
				"id, term, term_type, channels, severity, note, is_active, updated_at",
			)
			.single();

		if (error || !data) {
			return res.status(404).json({ error: "Blocklist entry not found" });
		}

		await invalidateBlocklistCache();

		return res.json({ message: "Entry updated", entry: data });
	},
);

// ─────────────────────────────────────────────
// DELETE /api/v1/admin/moderation/blocklist/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/blocklist/{id}:
 *   delete:
 *     summary: Remove a term from the blocklist
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Term removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Term removed from blocklist
 *       404:
 *         description: Entry not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Blocklist entry not found
 *       403:
 *         description: Platform admin access required
 */
router.delete(
	"/blocklist/:id",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;

		const { error } = await supabaseAdmin
			.from("content_blocklist")
			.delete()
			.eq("id", id);

		if (error) {
			return res.status(404).json({ error: "Blocklist entry not found" });
		}

		await invalidateBlocklistCache();

		return res.json({ success: true, message: "Term removed from blocklist" });
	},
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/moderation/flagged
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/flagged:
 *   get:
 *     summary: List blocked and flagged messages
 *     description: |
 *       Returns a paginated log of all messages that were blocked or flagged by content moderation.
 *       Use this for admin review. Filter by `reviewed=false` to see pending items.
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: reviewed
 *         schema:
 *           type: boolean
 *         description: Filter by review status (omit for all)
 *       - in: query
 *         name: severity
 *         schema:
 *           type: string
 *           enum: [block, flag]
 *       - in: query
 *         name: channel
 *         schema:
 *           type: string
 *           enum: [sms, whatsapp]
 *       - in: query
 *         name: tenant_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Paginated list of flagged messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 flagged:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       tenant_id:
 *                         type: string
 *                         format: uuid
 *                       channel:
 *                         type: string
 *                         enum: [sms, whatsapp]
 *                       message_content:
 *                         type: string
 *                         example: Win a free prize now!
 *                       recipient_count:
 *                         type: integer
 *                         example: 3
 *                       matched_term:
 *                         type: string
 *                         example: win a prize
 *                       matched_type:
 *                         type: string
 *                         enum: [word, phrase, regex]
 *                       severity:
 *                         type: string
 *                         enum: [block, flag]
 *                       request_ip:
 *                         type: string
 *                         nullable: true
 *                       reviewed:
 *                         type: boolean
 *                       reviewed_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       review_note:
 *                         type: string
 *                         nullable: true
 *                       blocked_at:
 *                         type: string
 *                         format: date-time
 *                 total:
 *                   type: integer
 *                   example: 120
 *                 limit:
 *                   type: integer
 *                   example: 50
 *                 offset:
 *                   type: integer
 *                   example: 0
 *       403:
 *         description: Platform admin access required
 */
router.get("/flagged", requireAuth, requirePlatformAdmin, async (req, res) => {
	const { reviewed, severity, channel, tenant_id } = req.query;
	const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
	const offset = parseInt(req.query.offset || "0", 10);

	let query = supabaseAdmin
		.from("blocked_messages")
		.select(
			`
      id,
      tenant_id,
      channel,
      message_content,
      recipient_count,
      matched_term,
      matched_type,
      severity,
      request_ip,
      reviewed,
      reviewed_by,
      reviewed_at,
      review_note,
      blocked_at,
      tenants!tenant_id ( name ),
      api_keys!api_key_id ( name, key_prefix )
    `,
			{ count: "exact" },
		)
		.order("blocked_at", { ascending: false })
		.range(offset, offset + limit - 1);

	if (reviewed !== undefined) query = query.eq("reviewed", reviewed === "true");
	if (severity) query = query.eq("severity", severity);
	if (channel) query = query.eq("channel", channel);
	if (tenant_id) query = query.eq("tenant_id", tenant_id);

	const { data, error, count } = await query;

	if (error) {
		console.error("[moderation] Flagged list error:", error.message);
		return res.status(500).json({ error: "Failed to load flagged messages" });
	}

	return res.json({ flagged: data || [], total: count, limit, offset });
});

// ─────────────────────────────────────────────
// PATCH /api/v1/admin/moderation/flagged/:id/review
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/flagged/{id}/review:
 *   patch:
 *     summary: Mark a flagged message as reviewed
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               review_note:
 *                 type: string
 *                 description: Optional note from the reviewing admin
 *     responses:
 *       200:
 *         description: Marked as reviewed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 entry:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     reviewed:
 *                       type: boolean
 *                       example: true
 *                     reviewed_at:
 *                       type: string
 *                       format: date-time
 *                     review_note:
 *                       type: string
 *                       nullable: true
 *       404:
 *         description: Entry not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Flagged message not found
 *       403:
 *         description: Platform admin access required
 */
router.patch(
	"/flagged/:id/review",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;
		const { review_note } = req.body;

		const { data, error } = await supabaseAdmin
			.from("blocked_messages")
			.update({
				reviewed: true,
				reviewed_by: req.user.id,
				reviewed_at: new Date().toISOString(),
				review_note: review_note || null,
			})
			.eq("id", id)
			.select("id, reviewed, reviewed_at, review_note")
			.single();

		if (error || !data) {
			return res.status(404).json({ error: "Flagged message not found" });
		}

		return res.json({ success: true, entry: data });
	},
);

// ─────────────────────────────────────────────
// GET /api/v1/admin/moderation/exemptions
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/exemptions:
 *   get:
 *     summary: List tenant moderation exemptions
 *     description: |
 *       Returns all per-tenant category exemptions. Optionally filter by `tenant_id`.
 *       Exempted tenants will not have their messages checked against terms in the exempted category.
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: tenant_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter exemptions for a specific tenant
 *     responses:
 *       200:
 *         description: List of exemptions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exemptions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       tenant_id:
 *                         type: string
 *                         format: uuid
 *                       tenant_name:
 *                         type: string
 *                         example: BetMalawi Ltd
 *                       category:
 *                         type: string
 *                         example: gambling_marketing
 *                       note:
 *                         type: string
 *                         nullable: true
 *                       granted_by:
 *                         type: string
 *                         format: uuid
 *                         nullable: true
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                 total:
 *                   type: integer
 *                   example: 3
 *       403:
 *         description: Platform admin access required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Platform admin access required
 */
router.get(
	"/exemptions",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { tenant_id } = req.query;

		let query = supabaseAdmin
			.from("tenant_moderation_exemptions")
			.select("id, tenant_id, category, note, granted_by, created_at, tenants!tenant_id ( name )")
			.order("created_at", { ascending: false });

		if (tenant_id) query = query.eq("tenant_id", tenant_id);

		const { data, error } = await query;

		if (error) {
			console.error("[moderation] List exemptions error:", error.message);
			return res.status(500).json({ error: "Failed to load exemptions" });
		}

		const exemptions = (data || []).map(row => ({
			id: row.id,
			tenant_id: row.tenant_id,
			tenant_name: row.tenants?.name || null,
			category: row.category,
			note: row.note,
			granted_by: row.granted_by,
			created_at: row.created_at,
		}));

		return res.json({ exemptions, total: exemptions.length });
	},
);

// ─────────────────────────────────────────────
// POST /api/v1/admin/moderation/exemptions
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/exemptions:
 *   post:
 *     summary: Grant a category exemption to a tenant
 *     description: |
 *       Grants a tenant an exemption from an entire moderation category. All current and future
 *       terms in that category will be skipped when checking messages for this tenant.
 *
 *       **Non-exemptable categories:** `profanity` and `hate_speech` can never be granted as
 *       exemptions — attempting to do so returns a `400` error.
 *
 *       **Exemptable categories:** `fraud`, `phishing`, `gambling_marketing`, `spam`, `explicit`, `general`
 *
 *       Changes take effect within 60 seconds (Redis cache TTL).
 *     tags:
 *       - Moderation
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
 *               - category
 *             properties:
 *               tenant_id:
 *                 type: string
 *                 format: uuid
 *                 description: The tenant to exempt
 *               category:
 *                 type: string
 *                 enum: [fraud, phishing, gambling_marketing, spam, explicit, general]
 *                 example: gambling_marketing
 *                 description: The category to exempt. profanity and hate_speech are not exemptable.
 *               note:
 *                 type: string
 *                 description: Admin note explaining the business reason for this exemption
 *                 example: Regulated betting operator — licensed by MRA
 *     responses:
 *       201:
 *         description: Exemption granted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Exemption granted
 *                 exemption:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     tenant_id:
 *                       type: string
 *                       format: uuid
 *                     category:
 *                       type: string
 *                       example: gambling_marketing
 *                     note:
 *                       type: string
 *                       nullable: true
 *                     granted_by:
 *                       type: string
 *                       format: uuid
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid category or attempting to exempt a non-exemptable category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "profanity cannot be exempted — this category is enforced for all tenants"
 *       409:
 *         description: This tenant already has an exemption for this category
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: This tenant already has an exemption for this category
 *       403:
 *         description: Platform admin access required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Platform admin access required
 */
router.post(
	"/exemptions",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { tenant_id, category, note } = req.body;

		if (!tenant_id || !category) {
			return res.status(400).json({ error: "tenant_id and category are required" });
		}

		const NON_EXEMPTABLE = ["profanity", "hate_speech"];
		if (NON_EXEMPTABLE.includes(category)) {
			return res.status(400).json({
				error: `${category} cannot be exempted — this category is enforced for all tenants`,
			});
		}

		const VALID_CATEGORIES = ["fraud", "phishing", "gambling_marketing", "spam", "explicit", "general"];
		if (!VALID_CATEGORIES.includes(category)) {
			return res.status(400).json({
				error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`,
			});
		}

		const { data, error } = await supabaseAdmin
			.from("tenant_moderation_exemptions")
			.insert({
				tenant_id,
				category,
				note: note || null,
				granted_by: req.user.id,
			})
			.select("id, tenant_id, category, note, granted_by, created_at")
			.single();

		if (error) {
			if (error.code === "23505") {
				return res.status(409).json({
					error: "This tenant already has an exemption for this category",
				});
			}
			if (error.code === "23503") {
				return res.status(400).json({ error: "Tenant not found" });
			}
			console.error("[moderation] Grant exemption error:", error.message);
			return res.status(500).json({ error: "Failed to grant exemption" });
		}

		await invalidateTenantExemptionsCache(tenant_id);

		return res.status(201).json({ message: "Exemption granted", exemption: data });
	},
);

// ─────────────────────────────────────────────
// DELETE /api/v1/admin/moderation/exemptions/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/admin/moderation/exemptions/{id}:
 *   delete:
 *     summary: Revoke a tenant category exemption
 *     description: |
 *       Revokes a previously granted exemption. The tenant's messages will be checked against
 *       that category again within 60 seconds (Redis cache TTL).
 *     tags:
 *       - Moderation
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The exemption ID to revoke
 *     responses:
 *       200:
 *         description: Exemption revoked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Exemption revoked
 *       404:
 *         description: Exemption not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Exemption not found
 *       403:
 *         description: Platform admin access required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Platform admin access required
 */
router.delete(
	"/exemptions/:id",
	requireAuth,
	requirePlatformAdmin,
	async (req, res) => {
		const { id } = req.params;

		// Fetch first so we can invalidate the right tenant's cache
		const { data: existing } = await supabaseAdmin
			.from("tenant_moderation_exemptions")
			.select("tenant_id")
			.eq("id", id)
			.single();

		if (!existing) {
			return res.status(404).json({ error: "Exemption not found" });
		}

		const { error } = await supabaseAdmin
			.from("tenant_moderation_exemptions")
			.delete()
			.eq("id", id);

		if (error) {
			console.error("[moderation] Revoke exemption error:", error.message);
			return res.status(500).json({ error: "Failed to revoke exemption" });
		}

		await invalidateTenantExemptionsCache(existing.tenant_id);

		return res.json({ success: true, message: "Exemption revoked" });
	},
);

module.exports = router;
