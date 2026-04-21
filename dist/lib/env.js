"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.coerce.number().default(3001),
    DATABASE_URL: zod_1.z.string().url(),
    REDIS_URL: zod_1.z.string().url(),
    JWT_SECRET: zod_1.z.string().min(32),
    SUPABASE_URL: zod_1.z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: zod_1.z.string(),
    // AI Providers
    OPENAI_API_KEY: zod_1.z.string().optional(),
    DEEPGRAM_API_KEY: zod_1.z.string().optional(),
    ELEVENLABS_API_KEY: zod_1.z.string().optional(),
    CARTESIA_API_KEY: zod_1.z.string().optional(),
    GOOGLE_GEMINI_API_KEY: zod_1.z.string().optional(),
    TAVILY_API_KEY: zod_1.z.string().optional(),
    // Telephony
    TWILIO_ACCOUNT_SID: zod_1.z.string().optional(),
    TWILIO_AUTH_TOKEN: zod_1.z.string().optional(),
    EXOTEL_API_KEY: zod_1.z.string().optional(),
    EXOTEL_API_TOKEN: zod_1.z.string().optional(),
    SIGNALWIRE_PROJECT_ID: zod_1.z.string().optional(),
    SIGNALWIRE_API_TOKEN: zod_1.z.string().optional(),
    SIGNALWIRE_SPACE_URL: zod_1.z.string().optional(),
    // LiveKit
    LIVEKIT_API_KEY: zod_1.z.string().optional(),
    LIVEKIT_API_SECRET: zod_1.z.string().optional(),
    LIVEKIT_URL: zod_1.z.string().optional(),
    // Billing
    STRIPE_SECRET_KEY: zod_1.z.string().optional(),
    STRIPE_WEBHOOK_SECRET: zod_1.z.string().optional(),
    PAYPAL_CLIENT_ID: zod_1.z.string().optional(),
    PAYPAL_CLIENT_SECRET: zod_1.z.string().optional(),
    PAYPAL_WEBHOOK_ID: zod_1.z.string().optional(),
    // External Services
    VOICE_WORKER_URL: zod_1.z.string().url().optional(),
    NEXT_PUBLIC_APP_URL: zod_1.z.string().url().optional(),
    NEXT_PUBLIC_API_URL: zod_1.z.string().url().optional(),
    // Campaign Service
    CAMPAIGN_SERVICE_TOKEN: zod_1.z.string().optional(),
    // Observability
    SENTRY_DSN: zod_1.z.string().optional(),
    HUBSPOT_ACCESS_TOKEN: zod_1.z.string().optional(),
    // Qdrant
    QDRANT_URL: zod_1.z.string().url().optional(),
    QDRANT_API_KEY: zod_1.z.string().optional(),
});
// Validate environment variables on startup
const result = envSchema.safeParse(process.env);
if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
}
exports.env = result.data;
