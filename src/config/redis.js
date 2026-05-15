const Redis = require("ioredis");

let client;

function getRedisClient() {
	if (client) return client;

	const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

	client = new Redis(redisUrl, {
		// Reconnect automatically with exponential backoff (max 30s between retries)
		retryStrategy: times => Math.min(times * 100, 30_000),
		// Don't crash the process if Redis is temporarily unavailable
		enableOfflineQueue: false,
		lazyConnect: false,
		maxRetriesPerRequest: 1,
	});

	client.on("connect", () => console.log("[Redis] Connected"));
	client.on("error", err => console.error("[Redis] Error:", err.message));
	client.on("reconnecting", () => console.log("[Redis] Reconnecting..."));

	return client;
}

module.exports = { getRedisClient };
