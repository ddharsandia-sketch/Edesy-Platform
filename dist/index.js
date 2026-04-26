"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: '../../.env' });
// Validate environment variables before anything else
const env_1 = require("./lib/env");
const Sentry = __importStar(require("@sentry/node"));
// Initialize Sentry before everything else
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    });
    console.log('[SENTRY] Error tracking initialized');
}
const fastify_1 = __importDefault(require("fastify"));
const fastify_raw_body_1 = __importDefault(require("fastify-raw-body"));
const cors_1 = __importDefault(require("@fastify/cors"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const auth_1 = require("./routes/auth");
const agents_1 = require("./routes/agents");
const calls_1 = require("./routes/calls");
const knowledge_1 = require("./routes/knowledge");
const webhooks_1 = require("./routes/webhooks");
const billing_1 = require("./routes/billing");
const campaigns_1 = require("./routes/campaigns");
const settings_1 = require("./routes/settings");
const ai_1 = require("./routes/ai");
const integrations_1 = require("./routes/integrations");
const app = (0, fastify_1.default)({ logger: true });
// FIX 1: Register raw body BEFORE any routes — required for Stripe webhook signature verification
// global: false means only routes with config: { rawBody: true } capture the raw buffer
// FIX 1: Register raw body BEFORE any routes — required for Stripe/PayPal signature verification
app.register(fastify_raw_body_1.default, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
});
app.register(cors_1.default, {
    origin: (origin, cb) => {
        // Allow local development, any vercel deployment, or explicitly allowed origins
        if (!origin || origin.startsWith('http://localhost') || origin.endsWith('.vercel.app')) {
            return cb(null, true);
        }
        const allowed = process.env.ALLOWED_ORIGINS?.split(',') || [];
        if (allowed.includes(origin))
            return cb(null, true);
        cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true
});
app.register(jwt_1.default, { secret: process.env.JWT_SECRET });
app.register(multipart_1.default, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max
// Rate limiting - 100 requests per minute per IP
app.register(rate_limit_1.default, {
    max: 100,
    timeWindow: 60000,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.'
    })
});
// Register all routes
app.register(auth_1.authRoutes);
app.register(agents_1.agentRoutes);
app.register(calls_1.callRoutes);
app.register(knowledge_1.knowledgeRoutes);
app.register(billing_1.billingRoutes);
app.register(campaigns_1.campaignRoutes);
app.register(settings_1.settingsRoutes);
app.register(ai_1.aiRoutes, { prefix: '/ai' });
app.register(integrations_1.integrationRoutes);
// Webhooks: PayPal + Twilio need rawBody — register last
app.register(webhooks_1.webhookRoutes);
app.get('/health', async () => ({ status: 'ok' }));
// Start BullMQ post-call worker
const post_call_1 = require("./jobs/post-call");
const campaign_dialer_1 = require("./jobs/campaign-dialer");
post_call_1.postCallWorker.on('completed', job => console.log(`[BULLMQ] Post-call job ${job.id} completed`));
post_call_1.postCallWorker.on('failed', (job, err) => console.error(`[BULLMQ] Post-call job ${job?.id} failed:`, err.message));
campaign_dialer_1.campaignWorker.on('completed', job => console.log(`[BULLMQ] Campaign job ${job.id} done`));
campaign_dialer_1.campaignWorker.on('failed', (job, err) => console.error(`[BULLMQ] Campaign job ${job?.id} failed:`, err.message));
console.log('[BULLMQ] Post-call + Campaign workers started');
const start = async () => {
    try {
        await app.listen({ port: process.env.PORT ? parseInt(process.env.PORT) : 3001, host: '0.0.0.0' });
        console.log(`API running on port ${process.env.PORT || 3001}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};
start();
// Keep Railway services warm — ping worker every 4 minutes
// Railway sleeps after 5 min of inactivity on hobby plan
if (process.env.NODE_ENV === 'production') {
    setInterval(async () => {
        try {
            const url = (0, env_1.getWorkerUrl)();
            await fetch(`${url}/health`);
        }
        catch { /* Silent — non-critical */ }
    }, 4 * 60 * 1000); // Every 4 minutes
}
