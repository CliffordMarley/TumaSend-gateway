const express = require("express");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
require("dotenv").config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());

// Capture raw body buffer so PayChangu webhook signature can be verified
// against the exact bytes PayChangu signed (re-stringifying a parsed object
// can change key order / whitespace and break the HMAC check).
app.use(
	express.json({
		verify: (req, _res, buf) => {
			req.rawBody = buf;
		},
	}),
);
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Swagger Configuration
const swaggerOptions = {
	definition: {
		openapi: "3.0.0",
		info: {
			title: "Communications Gateway API",
			version: "1.0.0",
			description: `Communications Gateway Backend API Documentation

### Authentication & Headers
All requests to the \`/api/v1\` routes (except webhooks) require a **System API Key** to verify they originate from a trusted application.

**Required Header:**
- Name: \`x-system-key\` (or \`system-key\`)
- Value: Your exact \`SYSTEM_API_KEY\` from the environment (case-sensitive).

Example:
\`\`\`
x-system-key: dhWs2UGdTExUXGk6kueJO9HdbfgD0LlgMn
\`\`\`
`,
		},
		components: {
			securitySchemes: {
				SystemKeyAuth: {
					type: "apiKey",
					in: "header",
					name: "x-system-key",
				},
				ApiKeyAuth: {
					type: "apiKey",
					in: "header",
					name: "x-api-key",
				},
				BearerAuth: {
					type: "http",
					scheme: "bearer",
					bearerFormat: "JWT",
				},
			},
		},
		security: [
			{
				SystemKeyAuth: [],
			},
		],
		servers: [
			{
				url:
					process.env.API_BASE_URL ||
					`http://localhost:${process.env.PORT || 3000}`,
			},
		],
	},
	apis: ["./src/routes/**/*.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Custom Middlewares
const { systemKeyAuth } = require("./middlewares/systemKeyAuth");

// Routes Imports
const authRoutes = require("./routes/authRoutes");
const profileRoutes = require("./routes/profileRoutes");
const businessRoutes = require("./routes/businessRoutes");
const kycRoutes = require("./routes/kycRoutes");
const sendRoutes = require("./routes/sendRoutes");
const batchRoutes = require("./routes/batchRoutes");
const balanceRoutes = require("./routes/balanceRoutes");
const orderRoutes = require("./routes/orderRoutes");
const adminRoutes = require("./routes/adminRoutes");
const moderationRoutes = require("./routes/moderationRoutes");
const senderIdRoutes = require("./routes/senderIdRoutes");
const apiKeyRoutes = require("./routes/apiKeyRoutes");
const kannelRoutes = require("./routes/webhooks/kannelRoutes");
const paychanguRoutes = require("./routes/webhooks/paychanguRoutes");
const contactRoutes = require("./routes/contactRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const { startSmsWorker } = require("./workers/smsWorker");
const { startPaychanguWorker } = require("./workers/paychanguWorker");
const { startCampaignWorker } = require("./workers/campaignWorker");
const { startWhatsappWorker } = require("./workers/whatsappWorker");
const whatsappSessionRoutes = require("./routes/whatsappSessionRoutes");

// Send routes — only x-api-key required, must be mounted BEFORE apiRouter
// so the systemKeyAuth middleware on apiRouter never intercepts them
app.use("/api/v1/send", sendRoutes);

// WhatsApp session management (system-key protected, dashboard-facing)
app.use("/api/v1/whatsapp", systemKeyAuth, whatsappSessionRoutes);

// Mock Kannel endpoint for local development
if (process.env.NODE_ENV !== "production") {
	app.get("/cgi-bin/sendsms", (req, res) => {
		const { to, from, text } = req.query;
		const mockId = Math.floor(Math.random() * 900000) + 100000;
		console.log(
			`[MOCK KANNEL] from=${from} to=${to} text="${text}" → id=${mockId}`,
		);
		res.type("text/plain").send(`0: Accepted for delivery: ${mockId}`);
	});
}

// Mount routes that require SYSTEM API KEY
const apiRouter = express.Router();
apiRouter.use(systemKeyAuth);

apiRouter.use("/auth", authRoutes);
apiRouter.use("/profile", profileRoutes);
apiRouter.use("/business", businessRoutes);
apiRouter.use("/kyc", kycRoutes);
apiRouter.use("/batches", batchRoutes);
apiRouter.use("/balance", balanceRoutes);
apiRouter.use("/", orderRoutes);
apiRouter.use("/sender-ids", senderIdRoutes);
apiRouter.use("/api-keys", apiKeyRoutes);
apiRouter.use("/admin", adminRoutes);
apiRouter.use("/admin/moderation", moderationRoutes);
apiRouter.use("/contacts", contactRoutes);
apiRouter.use("/campaigns", campaignRoutes);

// Mount Webhook Routes BEFORE apiRouter — they must never hit systemKeyAuth
app.use("/api/v1/webhooks/kannel", kannelRoutes);
app.use("/api/v1/webhooks/paychangu", paychanguRoutes);

app.use("/api/v1", apiRouter);

// Base Route
app.get("/", (_req, res) => {
	res.json({ message: "Welcome to Communications Gateway API" });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
	console.log(
		`API Documentation available at http://localhost:${PORT}/api-docs`,
	);
	startSmsWorker();
	startPaychanguWorker();
	startCampaignWorker();
	startWhatsappWorker();
});

module.exports = app;
