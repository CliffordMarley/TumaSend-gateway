const admin = require("firebase-admin");
require("dotenv").config();

const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountValue) {
	throw new Error(
		"FIREBASE_SERVICE_ACCOUNT is not set. Add it to your .env file as a path to the service account JSON or as an inline JSON string.",
	);
}

let serviceAccount;
try {
	if (serviceAccountValue.startsWith("{")) {
		serviceAccount = JSON.parse(serviceAccountValue);
	} else {
		// Treat as a file path
		const path = require("path");
		const fs = require("fs");
		const resolved = path.resolve(serviceAccountValue);
		if (!fs.existsSync(resolved)) {
			throw new Error(`Service account file not found: ${resolved}`);
		}
		serviceAccount = JSON.parse(fs.readFileSync(resolved, "utf8"));
	}
} catch (error) {
	throw new Error(`Failed to load Firebase service account: ${error.message}`);
}

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;
