"use strict";

const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
	getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node");
const {
	OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");
const {
	SimpleSpanProcessor,
	ConsoleSpanExporter,
} = require("@opentelemetry/sdk-trace-node");

const OTEL_ENABLED = process.env.OTEL_ENABLED !== "false";

if (!OTEL_ENABLED) {
	// Tracing disabled — nothing to do
	module.exports = { sdk: null };
} else {
	const otlpEndpoint =
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

	const spanProcessors = [
		new SimpleSpanProcessor(
			new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
		),
	];

	// Also log to console in development
	if (process.env.NODE_ENV !== "production") {
		spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
	}

	// OTEL_SERVICE_NAME env var is read automatically by the SDK
	const sdk = new NodeSDK({
		spanProcessors,
		instrumentations: [
			getNodeAutoInstrumentations({
				// Reduce noise — skip fs and dns spans
				"@opentelemetry/instrumentation-fs": { enabled: false },
				"@opentelemetry/instrumentation-dns": { enabled: false },
				// Include HTTP, Express, pg, and axios
				"@opentelemetry/instrumentation-http": { enabled: true },
				"@opentelemetry/instrumentation-express": { enabled: true },
				"@opentelemetry/instrumentation-pg": { enabled: true },
			}),
		],
	});

	sdk.start();

	process.on("SIGTERM", () => sdk.shutdown());
	process.on("SIGINT", () => sdk.shutdown());

	module.exports = { sdk };
}
