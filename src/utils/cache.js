/**
 * Thin wrapper around ioredis providing JSON-aware get/set/del helpers.
 *
 * All methods degrade gracefully: if Redis is unavailable or throws, the
 * caller receives `null` from `cacheGet` and the set/del operations are
 * silently skipped so the application keeps working without a cache.
 */

const { getRedisClient } = require("../config/redis");

/**
 * Read a cached value. Returns the parsed object or `null` on miss / error.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function cacheGet(key) {
	try {
		const raw = await getRedisClient().get(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

/**
 * Write a value to the cache.
 * @param {string} key
 * @param {any} value  – will be JSON-serialised
 * @param {number} [ttlSeconds=300]  – defaults to 5 minutes
 */
async function cacheSet(key, value, ttlSeconds = 300) {
	try {
		await getRedisClient().set(key, JSON.stringify(value), "EX", ttlSeconds);
	} catch {
		// Redis unavailable — continue without caching
	}
}

/**
 * Delete one or more cache keys.
 * @param {...string} keys
 */
async function cacheDel(...keys) {
	if (!keys.length) return;
	try {
		await getRedisClient().del(...keys);
	} catch {
		// Redis unavailable — no-op
	}
}

/**
 * Delete all keys matching a pattern (uses SCAN to avoid blocking Redis).
 * @param {string} pattern  e.g. "apikey:prefix:*"
 */
async function cacheDelPattern(pattern) {
	try {
		const redis = getRedisClient();
		let cursor = "0";
		do {
			const [nextCursor, keys] = await redis.scan(
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				100,
			);
			cursor = nextCursor;
			if (keys.length) await redis.del(...keys);
		} while (cursor !== "0");
	} catch {
		// Redis unavailable — no-op
	}
}

module.exports = { cacheGet, cacheSet, cacheDel, cacheDelPattern };
