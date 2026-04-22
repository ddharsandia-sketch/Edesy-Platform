"use strict";
/**
 * provider-router.ts
 *
 * Automatic provider routing logic:
 * - Language determines STT/TTS provider (Sarvam for Indian languages, Deepgram/ElevenLabs otherwise)
 * - Country/region determines telephony provider (Exotel for India, Twilio otherwise)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILT_IN_AGENT_TEMPLATES = exports.INDIAN_LANGUAGES = void 0;
exports.resolveProviders = resolveProviders;
exports.INDIAN_LANGUAGES = ['hi', 'gu', 'mr', 'ta', 'te', 'kn', 'bn', 'ml', 'pa', 'or'];
/**
 * Resolve provider configuration based on language and region.
 */
function resolveProviders(language, region, preferredLlm) {
    const isIndianLang = exports.INDIAN_LANGUAGES.includes(language);
    const isIndia = region === 'india' || isIndianLang;
    return {
        sttProvider: isIndianLang ? 'sarvam' : 'deepgram',
        ttsProvider: isIndianLang ? 'sarvam' : 'elevenlabs',
        voiceId: isIndianLang
            ? 'sarvam-bulbul-v2' // Sarvam Bulbul voice
            : '21m00Tcm4TlvDq8ikWAM', // ElevenLabs Rachel
        telephonyProvider: isIndia ? 'exotel' : 'twilio',
        llmModel: preferredLlm || 'gemini-2.0-flash',
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
        ...resolveProviders('hi', 'india'),
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
        ...resolveProviders('en', 'international'),
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
        sttProvider: 'sarvam',
        ttsProvider: 'sarvam',
        voiceId: 'sarvam-bulbul-v2',
        telephonyProvider: 'exotel',
        llmModel: 'gemini-2.5-flash',
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
        ...resolveProviders('en', 'international', 'gemini-2.5-flash'),
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
        sttProvider: 'sarvam',
        ttsProvider: 'sarvam',
        voiceId: 'sarvam-bulbul-v2',
        telephonyProvider: 'exotel',
        llmModel: 'gemini-2.0-flash',
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
        ...resolveProviders('en', 'international', 'gemini-2.5-flash'),
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
