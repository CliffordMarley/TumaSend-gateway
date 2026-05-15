const { Router } = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { requireAuth } = require("../middlewares/authMiddleware");
const { supabaseAdmin } = require("../config/supabase");
const { invalidateApiKeyCache } = require("../middlewares/apiKeyAuth");

const router = Router();

async function requireVerifiedTenant(req, res, next) {
	const { data, error } = await supabaseAdmin
		.from("tenant_members")
		.select("tenant_id, tenants(id, name, kyc_status)")
		.eq("user_id", req.user.id)
		.eq("is_owner", true)
		.eq("status", "active")
		.single();

	if (error || !data) {
		return res.status(403).json({ error: "No business account found" });
	}

	if (data.tenants.kyc_status !== "approved") {
		return res.status(403).json({
			error: "KYC must be fully approved before managing API keys",
			kyc_status: data.tenants.kyc_status,
		});
	}

	req.ownedTenant = data;
	next();
}

function generateApiKey() {
	// Format: lc + 6 random hex chars + _ + 64 random hex chars
	// First 8 chars (key_prefix) = 'lc' + unique 6-hex — good lookup discriminator
	const id = crypto.randomBytes(3).toString("hex");
	const secret = crypto.randomBytes(32).toString("hex");
	const fullKey = `lc${id}_${secret}`;
	const keyPrefix = fullKey.substring(0, 8);
	return { fullKey, keyPrefix };
}

// ─────────────────────────────────────────────
// GET /api/v1/api-keys
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/api-keys:
 *   get:
 *     summary: List API keys
 *     description: |
 *       Returns all API keys for the authenticated owner's business.
 *       The actual key value is never returned after creation — only the prefix is shown.
 *     tags:
 *       - API Keys
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of API keys
 *       403:
 *         description: KYC not approved
 */
router.get("/", requireAuth, requireVerifiedTenant, async (req, res) => {
	const { data: keys, error } = await supabaseAdmin
		.from("api_keys")
		.select(
			`
      id,
      name,
      key_prefix,
      scopes,
      environment,
      status,
      allowed_ips,
      expires_at,
      last_used_at,
      total_requests,
      created_at,
      updated_at,
      sender_ids!sender_id_id (
        id,
        sender_id,
        display_name,
        is_global,
        status
      )
    `,
		)
		.eq("tenant_id", req.ownedTenant.tenant_id)
		.order("created_at", { ascending: false });

	if (error) {
		console.error("List API keys error:", error);
		return res.status(500).json({ error: "Failed to load API keys" });
	}

	return res.json({ api_keys: keys || [] });
});

// ─────────────────────────────────────────────
// POST /api/v1/api-keys
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/api-keys:
 *   post:
 *     summary: Create an API key
 *     description: |
 *       Creates a new API key bound to a sender ID.
 *
 *       The `sender_id_id` must be either:
 *       - A **global sender ID** (visible via `GET /api/v1/sender-ids/global`), or
 *       - Your own **approved** custom sender ID.
 *
 *       **Important:** The full API key is only returned in this response.
 *       Store it securely — it cannot be retrieved again. Use the rotate endpoint
 *       if you lose it.
 *
 *       Only one active API key is allowed per sender ID per business.
 *     tags:
 *       - API Keys
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
 *               - name
 *               - sender_id_id
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human-readable label for this key
 *                 example: Production Key
 *               sender_id_id:
 *                 type: string
 *                 description: UUID of the sender ID to bind this key to
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Permission scopes (default [sms:send])
 *                 example: ["sms:send"]
 *               environment:
 *                 type: string
 *                 enum: [live, test]
 *                 default: live
 *     responses:
 *       201:
 *         description: API key created — api_key field contains the full key (shown once only)
 *       400:
 *         description: Invalid sender_id_id or missing fields
 *       409:
 *         description: An active API key already exists for this sender ID
 *       403:
 *         description: KYC not approved
 */
router.post("/", requireAuth, requireVerifiedTenant, async (req, res) => {
	const tenantId = req.ownedTenant.tenant_id;
	const body = req.body || {};
	const { name, sender_id_id, scopes, environment } = body;

	if (!name || !sender_id_id) {
		return res
			.status(400)
			.json({ error: "name and sender_id_id are required" });
	}

	// Validate sender ID: must be global+approved OR tenant's own approved sender
	const { data: senderIdRow, error: senderError } = await supabaseAdmin
		.from("sender_ids")
		.select("id, sender_id, display_name, is_global, tenant_id, status")
		.eq("id", sender_id_id)
		.single();

	if (senderError || !senderIdRow) {
		return res.status(400).json({ error: "Sender ID not found" });
	}

	const isGlobalApproved =
		senderIdRow.is_global === true && senderIdRow.status === "approved";
	const isTenantApproved =
		senderIdRow.tenant_id === tenantId && senderIdRow.status === "approved";

	if (!isGlobalApproved && !isTenantApproved) {
		return res.status(400).json({
			error:
				"Sender ID must be an active global sender or your own approved sender ID",
			hint:
				senderIdRow.status !== "approved"
					? `Sender ID status is "${senderIdRow.status}" — must be "approved"`
					: "This sender ID does not belong to your business",
		});
	}

	const { fullKey, keyPrefix } = generateApiKey();
	const keyHash = await bcrypt.hash(fullKey, 10);

	const { data: newKey, error: insertError } = await supabaseAdmin
		.from("api_keys")
		.insert({
			tenant_id: tenantId,
			created_by: req.user.id,
			name: name.trim(),
			sender_id_id,
			key_prefix: keyPrefix,
			key_hash: keyHash,
			scopes:
				Array.isArray(scopes) && scopes.length > 0 ? scopes : ["sms:send"],
			environment: ["live", "test"].includes(environment)
				? environment
				: "live",
			allowed_ips: [],
			status: "active",
		})
		.select("id, name, key_prefix, scopes, environment, status, created_at")
		.single();

	if (insertError) {
		if (insertError.code === "23505") {
			return res.status(409).json({
				error:
					"An active API key already exists for this sender ID. Rotate or revoke the existing key first.",
			});
		}
		console.error("API key create error:", insertError);
		return res.status(500).json({ error: "Failed to create API key" });
	}

	return res.status(201).json({
		message: "API key created. Store it securely — it will not be shown again.",
		api_key: fullKey,
		id: newKey.id,
		name: newKey.name,
		key_prefix: newKey.key_prefix,
		scopes: newKey.scopes,
		environment: newKey.environment,
		status: newKey.status,
		created_at: newKey.created_at,
		sender_id: {
			id: senderIdRow.id,
			sender_id: senderIdRow.sender_id,
			display_name: senderIdRow.display_name,
			is_global: senderIdRow.is_global,
		},
	});
});

// ─────────────────────────────────────────────
// POST /api/v1/api-keys/:id/rotate
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/api-keys/{id}/rotate:
 *   post:
 *     summary: Rotate an API key
 *     description: |
 *       Revokes the existing key and issues a new one with the same settings.
 *       Use this if a key is compromised or as part of regular key rotation.
 *
 *       The new full key is shown **once only** in the response.
 *     tags:
 *       - API Keys
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
 *       201:
 *         description: New API key issued — api_key field contains the full key (shown once only)
 *       404:
 *         description: Active API key not found
 *       403:
 *         description: KYC not approved
 */
router.post(
	"/:id/rotate",
	requireAuth,
	requireVerifiedTenant,
	async (req, res) => {
		const { id } = req.params;
		const tenantId = req.ownedTenant.tenant_id;

		const { data: existing, error: fetchError } = await supabaseAdmin
			.from("api_keys")
			.select(
				"id, name, sender_id_id, scopes, environment, allowed_ips, expires_at",
			)
			.eq("id", id)
			.eq("tenant_id", tenantId)
			.eq("status", "active")
			.single();

		if (fetchError || !existing) {
			return res.status(404).json({ error: "Active API key not found" });
		}

		const { fullKey, keyPrefix } = generateApiKey();
		const keyHash = await bcrypt.hash(fullKey, 10);

		// Revoke old key and invalidate its cache entry
		await supabaseAdmin
			.from("api_keys")
			.update({
				status: "revoked",
				revoked_at: new Date().toISOString(),
				revoke_reason: "rotated",
				revoked_by: req.user.id,
			})
			.eq("id", id);
		await invalidateApiKeyCache(existing.key_prefix);

		// Create new key with identical settings
		const { data: newKey, error: insertError } = await supabaseAdmin
			.from("api_keys")
			.insert({
				tenant_id: tenantId,
				created_by: req.user.id,
				name: existing.name,
				sender_id_id: existing.sender_id_id,
				key_prefix: keyPrefix,
				key_hash: keyHash,
				scopes: existing.scopes,
				environment: existing.environment,
				allowed_ips: existing.allowed_ips,
				expires_at: existing.expires_at,
				status: "active",
			})
			.select("id, name, key_prefix, scopes, environment, status, created_at")
			.single();

		if (insertError) {
			console.error("API key rotate error:", insertError);
			return res.status(500).json({ error: "Failed to rotate API key" });
		}

		return res.status(201).json({
			message:
				"API key rotated. Store the new key securely — it will not be shown again.",
			api_key: fullKey,
			id: newKey.id,
			name: newKey.name,
			key_prefix: newKey.key_prefix,
			scopes: newKey.scopes,
			environment: newKey.environment,
			status: newKey.status,
			created_at: newKey.created_at,
			rotated_from_id: id,
		});
	},
);

// ─────────────────────────────────────────────
// PATCH /api/v1/api-keys/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/api-keys/{id}:
 *   patch:
 *     summary: Update API key settings
 *     description: |
 *       Update the name or IP allowlist of an active API key.
 *
 *       **`allowed_ips`** — provide an array of IPv4/IPv6 addresses to restrict which
 *       IPs can use this key. Pass an empty array `[]` to allow requests from any IP.
 *     tags:
 *       - API Keys
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
 *             properties:
 *               name:
 *                 type: string
 *                 description: New label for this key
 *                 example: Staging Key
 *               allowed_ips:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: IP whitelist — empty array allows all sources
 *                 example: ["196.168.1.10", "196.168.1.11"]
 *     responses:
 *       200:
 *         description: API key updated
 *       400:
 *         description: No valid fields provided
 *       404:
 *         description: Active API key not found
 */
router.patch("/:id", requireAuth, requireVerifiedTenant, async (req, res) => {
	const { id } = req.params;
	const tenantId = req.ownedTenant.tenant_id;
	const body = req.body || {};
	const { name, allowed_ips } = body;

	const updates = {};
	if (name !== undefined) updates.name = String(name).trim();
	if (allowed_ips !== undefined) {
		if (!Array.isArray(allowed_ips)) {
			return res
				.status(400)
				.json({
					error:
						"allowed_ips must be an array of IP addresses (use [] to allow all)",
				});
		}
		updates.allowed_ips = allowed_ips;
	}

	if (Object.keys(updates).length === 0) {
		return res
			.status(400)
			.json({ error: "Provide name and/or allowed_ips to update" });
	}

	const { data: updated, error } = await supabaseAdmin
		.from("api_keys")
		.update(updates)
		.eq("id", id)
		.eq("tenant_id", tenantId)
		.eq("status", "active")
		.select(
			"id, name, key_prefix, scopes, environment, allowed_ips, status, updated_at",
		)
		.single();

	if (error || !updated) {
		return res.status(404).json({ error: "Active API key not found" });
	}

	// Invalidate cache so updated settings (e.g. allowed_ips) take effect immediately
	await invalidateApiKeyCache(updated.key_prefix);

	return res.json({ message: "API key updated", api_key: updated });
});

// ─────────────────────────────────────────────
// DELETE /api/v1/api-keys/:id
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/api-keys/{id}:
 *   delete:
 *     summary: Revoke an API key
 *     tags:
 *       - API Keys
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
 *               reason:
 *                 type: string
 *                 description: Optional reason for revocation
 *     responses:
 *       200:
 *         description: API key revoked
 *       400:
 *         description: Key is already revoked
 *       404:
 *         description: API key not found
 */
router.delete("/:id", requireAuth, requireVerifiedTenant, async (req, res) => {
	const { id } = req.params;
	const tenantId = req.ownedTenant.tenant_id;

	const { data: existing, error: fetchError } = await supabaseAdmin
		.from("api_keys")
		.select("id, key_prefix, status")
		.eq("id", id)
		.eq("tenant_id", tenantId)
		.single();

	if (fetchError || !existing) {
		return res.status(404).json({ error: "API key not found" });
	}

	if (existing.status === "revoked") {
		return res.status(400).json({ error: "API key is already revoked" });
	}

	const body = req.body || {};
	const { error } = await supabaseAdmin
		.from("api_keys")
		.update({
			status: "revoked",
			revoked_at: new Date().toISOString(),
			revoked_by: req.user.id,
			revoke_reason: body.reason || "revoked by owner",
		})
		.eq("id", id);

	if (error) {
		return res.status(500).json({ error: "Failed to revoke API key" });
	}

	// Invalidate cache so the revoked key is rejected immediately
	await invalidateApiKeyCache(existing.key_prefix);

	return res.json({ message: "API key revoked successfully" });
});

module.exports = router;
