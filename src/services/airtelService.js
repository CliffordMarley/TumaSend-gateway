const axios = require("axios");

const BASE_URL =
	process.env.AIRTEL_SMS_BASE_URL || "http://iqsms.airtel.in/api/v1";
const CLIENT_ID = process.env.AIRTEL_SMS_CLIENT_ID;
const USERNAME = process.env.AIRTEL_SMS_USERNAME;
const PASSWORD = process.env.AIRTEL_SMS_PASSWORD;

/**
 * Build the Basic Auth header value.
 */
function basicAuth() {
	const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
	return `Basic ${token}`;
}

/**
 * Airtel's subAccountId uses dashes; the env var may be stored with underscores.
 * e.g. f6f833cb_dde5_4eb0_... → f6f833cb-dde5-4eb0-...
 */
function toSubAccountId(username) {
	return (username || "").replace(/_/g, "-");
}

/**
 * Send SMS to one or many recipients via the Airtel Malawi gateway.
 *
 * @param {object} params
 * @param {string}   params.senderId           - Sender ID / header
 * @param {string[]} params.destinationAddress  - Array of normalised phone numbers
 * @param {string}   params.message             - Message body
 *
 * @returns {{ messageRequestId: string|null, incorrectNums: string[], raw: object }}
 */
async function sendSms({ senderId, destinationAddress, message }) {
	const payload = {
		customerId: CLIENT_ID,
		senderId,
		destinationAddress,
		message,
		metaData: {
			subAccountId: toSubAccountId(USERNAME),
		},
	};

	const response = await axios.post(`${BASE_URL}/sendDefaultSms`, payload, {
		headers: {
			"Content-Type": "application/json",
			Authorization: basicAuth(),
		},
		timeout: 30000,
	});

	const data = response.data || {};
	return {
		messageRequestId: data.messageRequestId || null,
		incorrectNums: Array.isArray(data.incorrectNum) ? data.incorrectNum : [],
		raw: data,
	};
}

module.exports = { sendSms };
