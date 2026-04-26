"use strict";
/**
 * provider-router.ts — apps/api/src/lib/provider-router.ts
 *
 * Automatic provider routing logic.
 * Delegates all tier/provider decisions to voice-tiers.ts.
 * This keeps backward compatibility with existing callers while
 * adding full 3-tier support.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILT_IN_AGENT_TEMPLATES = exports.INDIAN_LANGUAGES = exports.buildSystemPrompt = exports.resolveTierProviders = exports.INDIAN_LANGUAGE_CODES = void 0;
exports.resolveProviders = resolveProviders;
const voice_tiers_1 = require("./voice-tiers");
Object.defineProperty(exports, "resolveTierProviders", { enumerable: true, get: function () { return voice_tiers_1.resolveTierProviders; } });
Object.defineProperty(exports, "buildSystemPrompt", { enumerable: true, get: function () { return voice_tiers_1.buildSystemPrompt; } });
Object.defineProperty(exports, "INDIAN_LANGUAGE_CODES", { enumerable: true, get: function () { return voice_tiers_1.INDIAN_LANGUAGE_CODES; } });
// Keep for backward compat — array version used by existing code
exports.INDIAN_LANGUAGES = Array.from(voice_tiers_1.INDIAN_LANGUAGE_CODES);
/**
 * Resolve provider configuration based on language, region, and quality tier.
 *
 * @param language        - BCP-47 language code (e.g. "hi", "en")
 * @param voiceMode       - Legacy param kept for backward compat
 * @param telephonyRegion - Determines telephony provider (Exotel vs Twilio)
 * @param gender          - Voice gender preference
 * @param tierId          - NEW: explicit quality tier (overrides voiceMode)
 * @param useCaseId       - NEW: use case, used for prompt building
 */
function resolveProviders(language, voiceMode = "voice_only", telephonyRegion = "international", gender = "female", tierId, _useCaseId) {
    const isIndian = voice_tiers_1.INDIAN_LANGUAGE_CODES.has(language);
    const region = isIndian ? "indian" : "international";
    // Map legacy voiceMode → tier if tierId not explicitly passed
    const resolvedTierId = tierId ?? (voiceMode === "voice_premium" ? "premium"
        : voiceMode === "voice_reasoning" ? "professional"
            : "efficient");
    const cfg = (0, voice_tiers_1.resolveTierProviders)(resolvedTierId, region, language, gender);
    return {
        llmModel: cfg.llmModel,
        llmLabel: cfg.llmLabel,
        sttProvider: cfg.sttProvider,
        sttModel: cfg.sttModel,
        sttMode: cfg.sttMode,
        ttsProvider: cfg.ttsProvider,
        ttsModel: cfg.ttsModel,
        ttsPace: cfg.ttsPace,
        ttsLoudness: cfg.ttsLoudness,
        voiceId: cfg.voiceId,
        telephonyProvider: telephonyRegion === "india" ? "exotel" : "twilio",
        costPerMinUSD: cfg.costPerMinUSD,
        qualityLabel: cfg.tierLabel,
    };
}
/** Full list of agent templates with pre-wired provider configs */
exports.BUILT_IN_AGENT_TEMPLATES = [
    {
        id: 'indian-sales',
        name: 'Indian Sales Agent',
        icon: '🇮🇳',
        category: 'sales',
        language: 'hi',
        description: 'Hindi-speaking outbound sales agent for the Indian market. Uses Sarvam for ultra-low latency STT/TTS.',
        tagline: 'Hindi outbound sales, Sarvam-powered, Exotel telephony',
        tags: ['Sales', 'Hindi', 'India'],
        color: 'from-orange-900/20',
        popular: true,
        ...resolveProviders('hi', 'voice_reasoning', 'india'),
        personaPrompt: `Aap ek professional sales agent hain jo potential customers se baat kar rahe hain. Aapka naam Aryan hai. 
Aap friendly, helpful aur persuasive hain. Aap customer ki zaroorat samajhkar unhe sahi product suggest karte hain.
Jab customer interested lage, toh appointment book karo ya senior sales rep se milwao.
Hamesha professional rehna, kabhi jhooth mat bolna.`,
    },
    {
        id: 'intl-support',
        name: 'International Support',
        icon: '🌐',
        category: 'customer_support',
        language: 'en',
        description: 'English-speaking support agent with Deepgram STT and ElevenLabs TTS. Twilio telephony.',
        tagline: 'English support, Deepgram + ElevenLabs, Twilio',
        tags: ['Support', 'English', 'Global'],
        color: 'from-blue-900/20',
        popular: true,
        ...resolveProviders('en', 'voice_reasoning', 'international'),
        personaPrompt: `You are a professional customer support agent named Alex. You are empathetic, patient, and solution-focused.
Your goal is to understand the customer's issue quickly and provide the most helpful resolution.
Always confirm the customer's issue before attempting to resolve it.
If an issue requires escalation, collect all details and transfer to the right team.
Keep responses concise and clear — customers are often frustrated.`,
    },
    {
        id: 'indian-support-reasoning',
        name: 'Indian Support + Reasoning',
        icon: '📞',
        category: 'customer_support',
        language: 'hi',
        description: 'Hindi support agent with advanced reasoning for complex queries.',
        tagline: 'Hindi support, Sarvam, Exotel, Gemini reasoning',
        tags: ['Support', 'Hindi', 'Reasoning'],
        color: 'from-purple-900/20',
        popular: false,
        ...resolveProviders('hi', 'voice_reasoning', 'india'),
        personaPrompt: `Aap ek experienced customer support agent hain. Aapka naam Priya hai.
Aap complex technical problems solve karne mein expert hain.
Pehle customer ki poori problem suniye, phir step-by-step solution dein.
Agar problem bahut complex ho toh escalation karo, lekin hamesha customer ko update karo.`,
    },
    {
        id: 'appointment-booking',
        name: 'Appointment Booking',
        icon: '📅',
        category: 'scheduling',
        language: 'en',
        description: 'Books appointments in real-time using Google Calendar integration.',
        tagline: 'English scheduling, Google Calendar, Twilio',
        tags: ['Scheduling', 'Calendar', 'English'],
        color: 'from-green-900/20',
        popular: false,
        ...resolveProviders('en', 'voice_reasoning', 'international'),
        personaPrompt: `You are a scheduling assistant named Sam. You help customers book appointments efficiently.
When booking, always confirm: date, time, purpose, and contact info.
Check availability before confirming. Offer 2-3 time slot options.
Send confirmation once the appointment is booked.
Be friendly but efficient — don't waste the customer's time.`,
    },
    {
        id: 'gujarat-business',
        name: 'Gujarat Business Agent',
        icon: '💼',
        category: 'sales',
        language: 'gu',
        description: 'Gujarati-speaking business agent with Sarvam male voice and Exotel.',
        tagline: 'Gujarati business, Sarvam male voice, Exotel',
        tags: ['Business', 'Gujarati', 'India'],
        color: 'from-yellow-900/20',
        popular: false,
        ...resolveProviders('gu', 'voice_only', 'india', 'male'),
        personaPrompt: `Tame ek professional business representative chho. Tamaro name Rahul Patel chhe.
Tame Gujarati business culture samajho chho - relationship-first approach rakho.
Saude vaat karo tya pehla vishwas banavo. Business terms clearly explain karo.
Decisions maate time aapvo, kabhi pressure na karo.`,
    },
    {
        id: 'lead-qualifier',
        name: 'Lead Qualifier',
        icon: '🎯',
        category: 'sales',
        language: 'en',
        description: 'Qualifies leads using BANT framework and auto-logs to HubSpot.',
        tagline: 'English lead qualification, BANT, HubSpot auto-log',
        tags: ['Sales', 'Lead Gen', 'HubSpot'],
        color: 'from-red-900/20',
        popular: true,
        ...resolveProviders('en', 'voice_reasoning', 'international'),
        personaPrompt: `You are a lead qualification specialist named Jordan. Use the BANT framework:
- Budget: Understand their budget range
- Authority: Confirm they are the decision maker
- Need: Identify their core pain point
- Timeline: When do they need a solution

Ask one question at a time. Be conversational, not interrogative.
After qualification, summarize what you learned and schedule a demo if they qualify.
Log all details accurately for the sales team.`,
    },
];
