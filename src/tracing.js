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
const { Resource } = require("@opentelemetry/resources");
const {
	SemanticResourceAttributes,
} = require("@opentelemetry/semantic-conventions");

const OTEL_ENABLED = process.env.OTEL_ENABLED !== "false";

if (!OTEL_ENABLED) {
	// Tracing disabled — nothing to do
	module.exports = { sdk: null };
} else {
	const exporters = [];

	// Always send to Jaeger/collector if endpoint is configured
	const otlpEndpoint =
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

	exporters.push(
		new SimpleSpanProcessor(
			new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
		),
	);

	// Also log to console in development
	if (process.env.NODE_ENV !== "production") {
		exporters.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
	}

	const sdk = new NodeSDK({
		resource: new Resource({
			[SemanticResourceAttributes.SERVICE_NAME]:
				process.env.OTEL_SERVICE_NAME || "tumasend-gateway",
			[SemanticResourceAttributes.SERVICE_VERSION]:
				process.env.npm_package_version || "1.0.0",
		}),
		spanProcessors: exporters,
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
