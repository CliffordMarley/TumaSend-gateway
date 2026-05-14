const axios = require("axios");
const { supabaseAdmin } = require("../config/supabase");
const airtelService = require("./airtelService");
const { detectNetwork } = require("../utils/numberResolver");

const KANNEL_URL = process.env.KANNEL_HOST || "127.0.0.1";
const KANNEL_PORT = process.env.KANNEL_PORT || "13013";
const KANNEL_USER = process.env.KANNEL_USERNAME || "api";
const KANNEL_PASS = process.env.KANNEL_PASSWORD || "password";
const MOCK_PORT = process.env.PORT || "3000";

function kannelEndpoint(isTest) {
	if (isTest) return `http://127.0.0.1:${MOCK_PORT}/cgi-bin/sendsms`;
	return `http://${KANNEL_URL}:${KANNEL_PORT}/cgi-bin/sendsms`;
}

async function queueSMS(batchId, options = {}) {
	const isTest = options.environment === "test";

	const { data: batch, error } = await supabaseAdmin
		.from("message_batches")
		.select("*, messages(*)")
		.eq("id", batchId)
		.single();

	if (error || !batch) {
		console.error(`[smsWorker] batch ${batchId} not found:`, error?.message);
		return;
	}

	let sentCount = 0;
	let failedCount = 0;

	// Split pending messages by network — Airtel numbers get HTTP, everything else gets Kannel
	const pending = batch.messages.filter(
		m => m.status === "queued" || m.status === "failed",
	);

	const airtelMessages = pending.filter(
		m => detectNetwork(m.recipient) === "airtel",
	);
	const kannelMessages = pending.filter(
		m => detectNetwork(m.recipient) !== "airtel",
	);

	// ── Airtel Malawi HTTP ─────────────────────────────────────────────────────
	if (airtelMessages.length > 0 && !isTest) {
		await supabaseAdmin
			.from("messages")
			.update({ status: "sending", sent_at: new Date().toISOString() })
			.in(
				"id",
				airtelMessages.map(m => m.id),
			);

		try {
			const { messageRequestId, incorrectNums, raw } =
				await airtelService.sendSms({
					senderId: batch.sender_name,
					destinationAddress: airtelMessages.map(m => m.recipient),
					message: batch.content,
				});

			const incorrectSet = new Set(incorrectNums);

			await Promise.all(
				airtelMessages.map(m => {
					if (incorrectSet.has(m.recipient)) {
						failedCount++;
						return supabaseAdmin
							.from("messages")
							.update({
								status: "failed",
								failed_at: new Date().toISOString(),
								error_message: "Rejected by Airtel: invalid number",
								provider: "airtel",
								provider_response: { raw },
							})
							.eq("id", m.id);
					} else {
						sentCount++;
						return supabaseAdmin
							.from("messages")
							.update({
								status: "sent",
								provider: "airtel",
								provider_message_id: messageRequestId,
								provider_response: { raw },
							})
							.eq("id", m.id);
					}
				}),
			);
		} catch (err) {
			failedCount += airtelMessages.length;
			const now = new Date().toISOString();
			await Promise.all(
				airtelMessages.map(m => {
					const retryCount = (m.retry_count || 0) + 1;
					return supabaseAdmin
						.from("messages")
						.update({
							status: "failed",
							failed_at: now,
							error_message: err.message,
							retry_count: retryCount,
							next_retry_at:
								retryCount <= 3
									? new Date(
											Date.now() + 60000 * Math.pow(2, retryCount - 1),
										).toISOString()
									: null,
						})
						.eq("id", m.id);
				}),
			);
		}
	}

	// ── Kannel SMPP (TNM + all non-Airtel, and all messages in test mode) ─────
	const kannelTargets = isTest ? pending : kannelMessages;

	for (const message of kannelTargets) {
		try {
			await supabaseAdmin
				.from("messages")
				.update({ status: "sending", sent_at: new Date().toISOString() })
				.eq("id", message.id);

			const response = await axios.get(kannelEndpoint(isTest), {
				params: {
					username: KANNEL_USER,
					password: KANNEL_PASS,
					to: message.recipient,
					from: batch.sender_name,
					text: batch.content,
					"dlr-mask": 31,
					"dlr-url": `${process.env.API_BASE_URL || "http://127.0.0.1:3000"}/api/v1/webhooks/kannel/dlr?msg_id=${message.id}&id=%I&status=%d&to=%p&from=%P&time=%t`,
				},
			});

			const kannelId = response.data.match(/(\d+)/)?.[1] || null;

			await supabaseAdmin
				.from("messages")
				.update({
					status: "sent",
					provider: "kannel",
					provider_message_id: kannelId,
					provider_response: { raw: response.data },
				})
				.eq("id", message.id);

			sentCount++;
		} catch (err) {
			const retryCount = (message.retry_count || 0) + 1;
			await supabaseAdmin
				.from("messages")
				.update({
					status: "failed",
					failed_at: new Date().toISOString(),
					error_message: err.message,
					retry_count: retryCount,
					next_retry_at:
						retryCount <= 3
							? new Date(
									Date.now() + 60000 * Math.pow(2, retryCount - 1),
								).toISOString()
							: null,
				})
				.eq("id", message.id);

			failedCount++;
		}
	}

	const total = batch.messages.length;
	const finalStatus =
		failedCount === total
			? "failed"
			: failedCount > 0
				? "partial"
				: "completed";

	await supabaseAdmin
		.from("message_batches")
		.update({
			total_sent: sentCount,
			total_failed: failedCount,
			status: finalStatus,
			completed_at: new Date().toISOString(),
		})
		.eq("id", batchId);
}

/**
 * Retry individual failed messages whose next_retry_at has elapsed.
 */
async function retryFailedMessages() {
	const { data: messages, error } = await supabaseAdmin
		.from("messages")
		.select("id, batch_id, recipient, retry_count")
		.eq("status", "failed")
		.lte("next_retry_at", new Date().toISOString())
		.not("next_retry_at", "is", null)
		.lt("retry_count", 3)
		.limit(50);

	if (error || !messages || messages.length === 0) return;

	// Group by batch so we can look up sender_name/content once per batch
	const byBatch = {};
	for (const msg of messages) {
		if (!byBatch[msg.batch_id]) byBatch[msg.batch_id] = [];
		byBatch[msg.batch_id].push(msg);
	}

	for (const [batchId, msgs] of Object.entries(byBatch)) {
		const { data: batch } = await supabaseAdmin
			.from("message_batches")
			.select("sender_name, content, environment")
			.eq("id", batchId)
			.single();

		if (!batch) continue;

		const isTest = batch.environment === "test";

		for (const message of msgs) {
			const useAirtel =
				detectNetwork(message.recipient) === "airtel" && !isTest;

			try {
				await supabaseAdmin
					.from("messages")
					.update({ status: "sending", sent_at: new Date().toISOString() })
					.eq("id", message.id);

				if (useAirtel) {
					const { messageRequestId, incorrectNums, raw } =
						await airtelService.sendSms({
							senderId: batch.sender_name,
							destinationAddress: [message.recipient],
							message: batch.content,
						});

					const rejected = incorrectNums.includes(message.recipient);
					await supabaseAdmin
						.from("messages")
						.update(
							rejected
								? {
										status: "failed",
										failed_at: new Date().toISOString(),
										error_message: "Rejected by Airtel: invalid number",
										provider: "airtel",
										provider_response: { raw },
									}
								: {
										status: "sent",
										provider: "airtel",
										provider_message_id: messageRequestId,
										provider_response: { raw },
									},
						)
						.eq("id", message.id);
				} else {
					const response = await axios.get(kannelEndpoint(isTest), {
						params: {
							username: KANNEL_USER,
							password: KANNEL_PASS,
							to: message.recipient,
							from: batch.sender_name,
							text: batch.content,
							"dlr-mask": 31,
							"dlr-url": `${process.env.API_BASE_URL || "http://127.0.0.1:3000"}/api/v1/webhooks/kannel/dlr?msg_id=${message.id}&id=%I&status=%d&to=%p&from=%P&time=%t`,
						},
					});

					const kannelId = response.data.match(/(\d+)/)?.[1] || null;

					await supabaseAdmin
						.from("messages")
						.update({
							status: "sent",
							provider: "kannel",
							provider_message_id: kannelId,
							provider_response: { raw: response.data },
						})
						.eq("id", message.id);
				}
			} catch (err) {
				const retryCount = (message.retry_count || 0) + 1;
				await supabaseAdmin
					.from("messages")
					.update({
						status: "failed",
						failed_at: new Date().toISOString(),
						error_message: err.message,
						retry_count: retryCount,
						next_retry_at:
							retryCount <= 3
								? new Date(
										Date.now() + 60000 * Math.pow(2, retryCount - 1),
									).toISOString()
								: null,
					})
					.eq("id", message.id);
			}
		}
	}
}

module.exports = { queueSMS, retryFailedMessages };
