/**
 * Redis-backed sliding-window rate limiter for API keys.
 *
 * Each API key can have per-second, per-minute, per-hour, and per-day limits
 * stored on req.apiKey.rateLimits.  Windows that have no limit configured
 * (null / undefined) are skipped.
 *
 * Uses Redis INCR + EXPIRE for each window.  If Redis is unavailable the
 * middleware degrades gracefully and allows the request through.
 */

const { getRedisClient } = require("../config/redis");

/**
 * Increment a counter in Redis and return the new value.
 * Sets the TTL on the key only when it is first created so the window
 * slides naturally rather than resetting on every request.
 *
 * @param {string} key
 * @param {number} ttlSeconds
 * @returns {Promise<number>}
 */
async function increment(key, ttlSeconds) {
	const redis = getRedisClient();
	// MULTI/EXEC keeps the INCR + EXPIRE atomic
	const [[, count]] = await redis
		.multi()
		.incr(key)
		.expire(key, ttlSeconds, "NX") // NX = only set TTL if the key has no expiry yet
		.exec();
	return count;
}

/**
 * Check a single rate-limit window.
 *
 * @param {string} baseKey   e.g. "rl:key123"
 * @param {string} window    e.g. "sec" | "min" | "hr" | "day"
 * @param {number} ttl       window duration in seconds
 * @param {number} limit     maximum requests allowed
 * @returns {Promise<{exceeded: boolean, count: number, limit: number, window: string}>}
 */
async function checkWindow(baseKey, window, ttl, limit) {
	const key = `${baseKey}:${window}`;
	const count = await increment(key, ttl);
	return { exceeded: count > limit, count, limit, window };
}

/**
 * Express middleware — enforces API-key rate limits using Redis.
 *
 * Reads limit configuration from req.apiKey.rateLimits (set by apiKeyAuth).
 * Returns 429 with Retry-After if any window is exceeded.
 */
async function rateLimit(req, res, next) {
	const { apiKeyId, rateLimits } = req.apiKey || {};
	if (!apiKeyId || !rateLimits) return next();

	const baseKey = `rl:${apiKeyId}`;

	// Define windows: [windowLabel, ttlInSeconds, configuredLimit]
	const windows = [
		["sec", 1, rateLimits.perSecond],
		["min", 60, rateLimits.perMinute],
		["hr", 3600, rateLimits.perHour],
		["day", 86400, rateLimits.perDay],
	].filter(([, , limit]) => limit != null && limit > 0);

	try {
		// Check all configured windows in parallel for speed
		const results = await Promise.all(
			windows.map(([label, ttl, limit]) =>
				checkWindow(baseKey, label, ttl, limit),
			),
		);

		const exceeded = results.find(r => r.exceeded);
		if (exceeded) {
			const retryAfter =
				exceeded.window === "sec"
					? 1
					: exceeded.window === "min"
						? 60
						: exceeded.window === "hr"
							? 3600
							: 86400;

			res.set("Retry-After", String(retryAfter));
			res.set("X-RateLimit-Limit", String(exceeded.limit));
			res.set("X-RateLimit-Window", exceeded.window);
			return res.status(429).json({
				error: "Rate limit exceeded",
				window: exceeded.window,
				limit: exceeded.limit,
				retry_after_seconds: retryAfter,
			});
		}

		// Attach usage headers for the tightest window (per-second if configured)
		const tightest = results[0];
		if (tightest) {
			res.set("X-RateLimit-Limit", String(tightest.limit));
			res.set(
				"X-RateLimit-Remaining",
				String(Math.max(0, tightest.limit - tightest.count)),
			);
		}

		next();
	} catch (err) {
		// Redis unavailable — fail open (do not block legitimate traffic)
		console.error("[rateLimit] Redis error, failing open:", err.message);
		next();
	}
}

module.exports = { rateLimit };
