const admin = require("../config/firebase");
const { supabaseAdmin } = require("../config/supabase");
const { cacheGet, cacheSet, cacheDel } = require("../utils/cache");

// Cache TTL: 5 minutes. Balances freshness with DB load reduction.
const USER_TTL = 300;

/**
 * Invalidate the cached user record for a given Firebase UID.
 * Call this whenever a user's profile or status is updated.
 * @param {string} firebaseUid
 */
function invalidateUserCache(firebaseUid) {
	return cacheDel(`user:fbuid:${firebaseUid}`);
}

/**
 * Verifies Firebase JWT and attaches internal user object.
 *
 * Cache strategy
 * ─────────────
 * After the Firebase token is cryptographically verified (always), the
 * internal user record is read from Redis instead of the DB.  The Firebase
 * verification itself is handled by the Firebase Admin SDK and cannot be
 * skipped — only the subsequent Supabase lookup is cached.
 */
async function requireAuth(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return res.status(401).json({ error: "Unauthorized: No token provided" });
	}

	const token = authHeader.split("Bearer ")[1];

	try {
		// Firebase token verification is always performed — this cannot be cached.
		const decodedToken = await admin.auth().verifyIdToken(token);
		const firebaseUid = decodedToken.uid;

		const cacheKey = `user:fbuid:${firebaseUid}`;

		// ── 1. Try cache first ────────────────────────────────────────────────
		let user = await cacheGet(cacheKey);

		// ── 2. Cache miss → fetch from DB and populate cache ─────────────────
		if (!user) {
			const { data, error } = await supabaseAdmin
				.from("users")
				.select("id, email, full_name, is_platform_admin, status")
				.eq("firebase_uid", firebaseUid)
				.single();

			if (error || !data) {
				// Allow routes to proceed if they handle registration/first-time login specifically
				if (req.path === "/register") {
					req.firebaseUser = decodedToken;
					return next();
				}
				return res.status(401).json({ error: "User not found in system" });
			}

			user = data;
			cacheSet(cacheKey, user, USER_TTL);
		}

		if (user.status !== "active") {
			return res.status(403).json({ error: "User account is not active" });
		}

		req.user = user;
		req.firebaseUser = decodedToken;
		next();
	} catch (error) {
		console.error("Auth Error:", error);
		return res.status(401).json({ error: "Unauthorized: Invalid token" });
	}
}

module.exports = { requireAuth, invalidateUserCache };
