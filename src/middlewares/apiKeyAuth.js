const bcrypt = require("bcryptjs");
const { supabaseAdmin } = require("../config/supabase");
const { cacheGet, cacheSet, cacheDel } = require("../utils/cache");

// Cache TTL: 5 minutes. Short enough that revoked/updated keys expire quickly,
// long enough to eliminate the DB round-trip on every request.
const API_KEY_TTL = 300;

/**
 * Invalidate the cache entry for an API key prefix.
 * Call this whenever an API key is created, revoked, or updated.
 * @param {string} prefix  first 8 characters of the raw API key
 */
function invalidateApiKeyCache(prefix) {
	return cacheDel(`apikey:prefix:${prefix}`);
}

/**
 * Authenticates API requests using the x-api-key header.
 *
 * Cache strategy
 * ─────────────
 * The full key record (including the bcrypt hash) is cached in Redis keyed by
 * its 8-character prefix.  On every request we still run `bcrypt.compare` so
 * the actual secret is never skipped — only the expensive DB round-trip is
 * avoided.  `last_used_at` is updated in the background (fire-and-forget) so
 * it never adds latency to the hot path.
 */
async function apiKeyAuth(req, res, next) {
	try {
		const apiKey = req.headers["x-api-key"];

		if (!apiKey) {
			return res.status(401).json({ error: "API key required" });
		}

		// Extract prefix (first 8 chars)
		const prefix = apiKey.substring(0, 8);
		const cacheKey = `apikey:prefix:${prefix}`;

		// ── 1. Try cache first ──────────────────────────────────────────────────
		let keys = await cacheGet(cacheKey);

		// ── 2. Cache miss → fetch from DB and populate cache ───────────────────
		if (!keys) {
			const { data, error } = await supabaseAdmin
				.from("api_keys")
				.select(
					`
          id,
          key_hash,
          tenant_id,
          sender_id_id,
          scopes,
          environment,
          rate_limit_per_second,
          rate_limit_per_minute,
          rate_limit_per_hour,
          rate_limit_per_day,
          allowed_ips,
          status,
          expires_at,
          sender_ids!inner (
            sender_id,
            status
          ),
          tenants!inner (
            status,
            kyc_status,
            balance_mwk
          )
        `,
				)
				.eq("key_prefix", prefix)
				.eq("status", "active")
				.single();

			if (error || !data) {
				return res.status(401).json({ error: "Invalid API key" });
			}

			keys = data;
			// Populate cache — do not await so it never blocks the request
			cacheSet(cacheKey, keys, API_KEY_TTL);
		}

		// ── 3. Always verify the bcrypt hash (secret never skipped) ────────────
		const validKey = await bcrypt.compare(apiKey, keys.key_hash);
		if (!validKey) {
			return res.status(401).json({ error: "Invalid API key" });
		}

		// ── 4. Remaining validations ────────────────────────────────────────────
		if (keys.expires_at && new Date(keys.expires_at) < new Date()) {
			return res.status(401).json({ error: "API key expired" });
		}

		if (keys.allowed_ips && keys.allowed_ips.length > 0) {
			const clientIp = req.ip || req.connection.remoteAddress;
			if (!keys.allowed_ips.includes(clientIp)) {
				return res.status(403).json({ error: "IP not whitelisted" });
			}
		}

		if (keys.tenants.status !== "active") {
			return res.status(403).json({ error: "Tenant account is not active" });
		}

		if (keys.tenants.kyc_status !== "approved") {
			return res
				.status(403)
				.json({ error: "KYC verification is required to use this API key" });
		}

		if (keys.sender_ids.status !== "approved") {
			return res.status(403).json({ error: "Sender ID is not approved" });
		}

		// ── 5. Update last_used_at in the background (fire-and-forget) ─────────
		supabaseAdmin
			.from("api_keys")
			.update({
				last_used_at: new Date().toISOString(),
				last_used_ip: req.ip,
			})
			.eq("id", keys.id)
			.then(() => {})
			.catch(err =>
				console.error("[apiKeyAuth] last_used_at update failed:", err.message),
			);

		// ── 6. Attach context to request ────────────────────────────────────────
		req.apiKey = {
			apiKeyId: keys.id,
			tenantId: keys.tenant_id,
			senderIdId: keys.sender_id_id,
			senderName: keys.sender_ids.sender_id,
			environment: keys.environment || "live",
			scopes: keys.scopes || [],
			rateLimits: {
				perSecond: keys.rate_limit_per_second,
				perMinute: keys.rate_limit_per_minute,
				perHour: keys.rate_limit_per_hour,
				perDay: keys.rate_limit_per_day,
			},
		};

		next();
	} catch (err) {
		console.error("API Key Auth Error:", err);
		return res
			.status(500)
			.json({ error: "Internal server error during authentication" });
	}
}

module.exports = { apiKeyAuth, invalidateApiKeyCache };
