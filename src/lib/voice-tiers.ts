/**
 * voice-tiers.ts — apps/api/src/lib/voice-tiers.ts
 * =================================================
 * Single source of truth for ALL quality tiers and use cases.
 *
 * HOW IT WORKS:
 *   1. User picks a use case in the wizard (e.g. "sales_outbound")
 *   2. getRecommendedTier() returns the suggested tier + reason
 *   3. User can accept suggestion or manually pick a different tier
 *   4. resolveTierProviders() returns the full provider config
 *   5. That config is saved on the Agent record and used at call time
 *
 * TO ADD A NEW USE CASE: add one entry to USE_CASES array below.
 * TO ADD A NEW TIER: add one entry to VOICE_TIERS array below.
 * Nothing else needs changing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TIER DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export type TierId = "efficient" | "professional" | "premium" | "gemini_live";

export interface VoiceTier {
  id:               TierId;
  name:             string;
  tagline:          string;        // shown in wizard card subtitle
  costPerMinUSD:    number;
  costPer1000Calls: number;        // at avg 5 min/call
  badge:            string;        // e.g. "Most Popular"
  badgeColor:       string;        // css class
  latencyMs:        number;        // approx TTFB
  bestFor:          string[];      // use case ids this tier excels at
  notRecommendedFor: string[];     // use case ids where this tier falls short

  // Provider config for INDIAN languages
  indian: {
    sttProvider:    string;
    sttModel:       string;
    sttMode:        string;
    ttsProvider:    string;
    ttsModel:       string;
    ttsPace:        number;
    ttsLoudness:    number;
    llmModel:       string;
    llmLabel:       string;
  };

  // Provider config for INTERNATIONAL / English
  international: {
    sttProvider:    string;
    ttsProvider:    string;
    ttsModel:       string;
    llmModel:       string;
    llmLabel:       string;
  };

  // System prompt addition (appended to every agent using this tier)
  voicePromptAddition: string;
}

export const VOICE_TIERS: VoiceTier[] = [
  // ── TIER 1: EFFICIENT ──────────────────────────────────────────────────────
  {
    id:               "efficient",
    name:             "Efficient",
    tagline:          "Fast, cheap, handles simple conversations perfectly",
    costPerMinUSD:    0.011,
    costPer1000Calls: 55,    // 1000 calls × 5 min avg × $0.011
    badge:            "Best Value",
    badgeColor:       "bg-green-100 text-green-700",
    latencyMs:        150,
    bestFor:          ["receptionist", "faq_bot", "order_status"],
    notRecommendedFor: ["ai_companion", "sales_outbound"],

    indian: {
      sttProvider: "sarvam",
      sttModel:    "saaras:v3",
      sttMode:     "realtime_fast",
      ttsProvider: "sarvam",
      ttsModel:    "bulbul:v3",
      ttsPace:     1.05,
      ttsLoudness: 1.5,
      llmModel:    "gemini-2.0-flash",
      llmLabel:    "Gemini 2.0 Flash",
    },
    international: {
      sttProvider: "deepgram",
      ttsProvider: "cartesia",
      ttsModel:    "sonic-2",
      llmModel:    "gemini-2.0-flash",
      llmLabel:    "Gemini 2.0 Flash",
    },

    voicePromptAddition: `
=== EFFICIENT TIER — VOICE RULES ===
Keep responses SHORT. Maximum 2 sentences per turn.
Acknowledge caller first, then answer.
Use natural filler words: "haan", "bilkul" (Hindi) or "got it", "sure" (English).
Never list more than 2 options at once.
=== END ===`,
  },

  // ── TIER 2: PROFESSIONAL ───────────────────────────────────────────────────
  {
    id:               "professional",
    name:             "Professional",
    tagline:          "Reasoning + natural voice — handles complex calls confidently",
    costPerMinUSD:    0.018,
    costPer1000Calls: 90,
    badge:            "Most Popular",
    badgeColor:       "bg-blue-100 text-blue-700",
    latencyMs:        220,
    bestFor:          ["sales_outbound", "customer_support", "lead_qualifier", "appointment"],
    notRecommendedFor: ["ai_companion"],

    indian: {
      sttProvider: "sarvam",
      sttModel:    "saaras:v3",
      sttMode:     "realtime_balanced",
      ttsProvider: "sarvam",
      ttsModel:    "bulbul:v3",
      ttsPace:     1.0,
      ttsLoudness: 1.5,
      llmModel:    "gemini-2.5-flash",
      llmLabel:    "Gemini 2.5 Flash (reasoning)",
    },
    international: {
      sttProvider: "deepgram",
      ttsProvider: "elevenlabs",
      ttsModel:    "eleven_turbo_v2_5",
      llmModel:    "gemini-2.5-flash",
      llmLabel:    "Gemini 2.5 Flash (reasoning)",
    },

    voicePromptAddition: `
=== PROFESSIONAL TIER — VOICE RULES ===
SENTENCE LENGTH: Max 3 sentences per turn. Break complex info into 2 turns.
ACKNOWLEDGMENT: Always acknowledge what caller said before responding.
  Hindi/Indian: use "haan", "bilkul", "zaroor", "samajh gaya"
  English: use "of course", "absolutely", "got it", "I understand"
EMOTION VARIETY:
  - Caller has problem → empathetic, slower pace
  - Good news → warm, slightly excited
  - Instructions → clear, direct
CODE-MIXING: Match caller's language mix exactly (Hinglish → Hinglish reply).
OBJECTION HANDLING (sales): Never argue. Use "main samajhta hoon" or "I understand that" then pivot.
CALL ENDINGS: Confirm main outcome + warm closing line.
NEVER: Say "As an AI", list >3 items, ask 2 questions at once, use bullet points.
=== END ===`,
  },

  // ── TIER 3: PREMIUM ────────────────────────────────────────────────────────
  {
    id:               "premium",
    name:             "Premium",
    tagline:          "Human-level emotional depth and reasoning",
    costPerMinUSD:    0.045,
    costPer1000Calls: 225,
    badge:            "Human-Level",
    badgeColor:       "bg-purple-100 text-purple-700",
    latencyMs:        300,
    bestFor:          ["ai_companion", "mental_health", "vip_support"],
    notRecommendedFor: [],

    indian: {
      sttProvider: "sarvam",
      sttModel:    "saaras:v3",
      sttMode:     "realtime_balanced",
      ttsProvider: "elevenlabs",
      ttsModel:    "eleven_multilingual_v2",
      ttsPace:     0.95,
      ttsLoudness: 1.2,
      llmModel:    "claude-3-5-sonnet",
      llmLabel:    "Claude 3.5 Sonnet",
    },
    international: {
      sttProvider: "deepgram",
      ttsProvider: "elevenlabs",
      ttsModel:    "eleven_turbo_v2_5",
      llmModel:    "claude-3-5-sonnet",
      llmLabel:    "Claude 3.5 Sonnet",
    },

    voicePromptAddition: `
=== PREMIUM TIER — VOICE RULES ===
EMOTIONAL INTELLIGENCE: Read the emotional state of every caller message.
  Respond to the emotion FIRST, then to the content.
  Example: Caller says "I've been waiting 3 days for a response" →
  RIGHT: "That sounds really frustrating — 3 days is too long to wait. Let me look into this right now."

PACING: Use natural pauses. Short sentences after emotional moments.

WARMTH MARKERS: Use these naturally (don't overuse — max once per 4 turns):
  Hindi: "aap ki baat sun ke accha laga", "main aapke saath hoon"
  English: "I really appreciate you sharing that", "You're in good hands"

ACTIVE LISTENING: Occasionally reflect back what you heard.
  "So if I understand correctly, you're saying..." (max once per call)

NEVER RUSH: Never say "quickly" or "just a moment". Take time with caller.
NEVER DISMISS: Never say "that's a common issue" — it minimizes their concern.
=== END ===`,
  },

// ── TIER 4: GEMINI LIVE HD ────────────────────────────────────────────────
  {
    id:               "gemini_live",
    name:             "Gemini Live HD",
    tagline:          "⚡ Ultra-low latency native audio (<300ms) — English only",
    costPerMinUSD:    0.025,
    costPer1000Calls: 125,
    badge:            "Lightning Fast",
    badgeColor:       "bg-amber-100 text-amber-700",
    latencyMs:        250,
    bestFor:          ["appointment", "customer_support", "ai_companion"],
    notRecommendedFor: ["indian"],

    indian: {
      sttProvider: "sarvam",
      sttModel:    "saaras:v3",
      sttMode:     "realtime_balanced",
      ttsProvider: "sarvam",
      ttsModel:    "bulbul:v3",
      ttsPace:     1.0,
      ttsLoudness: 1.5,
      llmModel:    "gemini-2.0-flash",
      llmLabel:    "Gemini 2.0 Flash",
    },
    international: {
      sttProvider: "google",
      ttsProvider: "google",
      ttsModel:    "gemini-live",
      llmModel:    "gemini-2.0-flash",
      llmLabel:    "Gemini 2.0 Flash (Live)",
    },

    voicePromptAddition: `
=== GEMINI LIVE TIER — VOICE RULES ===
NATURAL FLOW: Speak with native speed. Use natural interruptions.
CONCISENESS: Keep responses extremely short. 1-2 sentences max.
SPEED: Respond immediately. No filler words needed as latency is native.
=== END ===`,
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// USE CASE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export type UseCaseId =
  | "receptionist"
  | "sales_outbound"
  | "customer_support"
  | "lead_qualifier"
  | "appointment"
  | "ai_companion"
  | "mental_health"
  | "vip_support"
  | "premium_sales"
  | "faq_bot"
  | "order_status";

export interface UseCase {
  id:                UseCaseId;
  label:             string;
  emoji:             string;
  description:       string;
  suggestedTier:     TierId;
  suggestionReason:  string;   // shown in wizard: "We suggest Professional because..."
  examplePrompt:     string;   // pre-filled persona prompt example
  examplePromptHindi?: string; // Hindi version if applicable
}

export const USE_CASES: UseCase[] = [
  {
    id:               "receptionist",
    label:            "Receptionist / Front Desk",
    emoji:            "📞",
    description:      "Answer calls, give hours/location info, transfer to humans",
    suggestedTier:    "efficient",
    suggestionReason: "Receptionists handle simple predictable questions — Efficient tier is fast and saves cost",
    examplePrompt:    "You are a friendly receptionist for {business_name}. Greet callers warmly, answer questions about opening hours, location, and services. For complex issues, take their name and number and tell them someone will call back within 2 hours.",
    examplePromptHindi: "Aap {business_name} ke liye ek friendly receptionist hain. Callers ko warmly greet karein, opening hours, location, aur services ke baare mein sawaalon ke jawab dein. Complex maamlein ke liye unka naam aur number lijiye aur batayein ki koi 2 ghante mein call karega.",
  },
  {
    id:               "sales_outbound",
    label:            "Outbound Sales",
    emoji:            "🎯",
    description:      "Proactively call leads, pitch product, handle objections, close",
    suggestedTier:    "professional",
    suggestionReason: "Sales needs reasoning to handle objections and adapt pitch — Professional tier thinks before responding",
    examplePrompt:    "You are an expert sales agent for {business_name}. Your goal is to introduce our product, understand the prospect's current situation, present relevant benefits, handle objections confidently, and close for a meeting or trial. Be consultative, not pushy. Listen more than you talk.",
    examplePromptHindi: "Aap {business_name} ke liye ek expert sales agent hain. Aapka goal hai product introduce karna, prospect ki situation samajhna, relevant benefits batana, objections handle karna, aur meeting ya trial ke liye close karna. Consultative raho, pushy nahi.",
  },
  {
    id:               "customer_support",
    label:            "Customer Support",
    emoji:            "🎧",
    description:      "Handle complaints, troubleshoot issues, process refunds, escalate",
    suggestedTier:    "professional",
    suggestionReason: "Support calls are unpredictable — Professional tier handles complex multi-step problem solving",
    examplePrompt:    "You are a customer support specialist for {business_name}. Listen carefully to the customer's issue, empathize genuinely, and resolve it efficiently. If you can resolve it: do so and confirm. If not: take ownership, explain next steps clearly, and give a realistic timeline. Never blame the customer.",
    examplePromptHindi: "Aap {business_name} ke customer support specialist hain. Customer ki problem dhyan se sunein, genuinely empathize karein, aur efficiently resolve karein. Agar aap resolve kar saktein hain: karein aur confirm karein. Agar nahi: ownership lein, next steps clearly batayein.",
  },
  {
    id:               "lead_qualifier",
    label:            "Lead Qualifier",
    emoji:            "🔍",
    description:      "Qualify inbound leads by budget, timeline, and need before handoff",
    suggestedTier:    "professional",
    suggestionReason: "Lead scoring requires reasoning to assess fit and decide routing — Professional tier is ideal",
    examplePrompt:    "You are a lead qualification specialist for {business_name}. Your job is to have a natural conversation to understand: 1) What problem are they trying to solve? 2) What is their budget range? 3) What is their timeline? 4) Are they the decision maker? Score leads as HOT (buy soon, right budget), WARM (interested but not ready), or COLD (wrong fit). Be conversational, not interrogative.",
  },
  {
    id:               "appointment",
    label:            "Appointment Booking",
    emoji:            "📅",
    description:      "Book, reschedule, and cancel appointments into a calendar",
    suggestedTier:    "professional",
    suggestionReason: "Scheduling needs reasoning to handle date/time logic and conflicts — Professional tier manages this reliably",
    examplePrompt:    "You are a scheduling assistant for {business_name}. Help callers book, reschedule, or cancel appointments. Always confirm: caller's full name, contact number, preferred date and time, and reason for visit. Repeat the confirmed details back before ending the call.",
    examplePromptHindi: "Aap {business_name} ke scheduling assistant hain. Callers ko appointments book, reschedule, ya cancel karne mein madad karein. Hamesha confirm karein: caller ka poora naam, contact number, preferred date aur time, aur visit ka reason.",
  },
  {
    id:               "ai_companion",
    label:            "AI Companion / Personal Assistant",
    emoji:            "🤝",
    description:      "Personal assistant, emotional support, daily check-ins, coaching",
    suggestedTier:    "premium",
    suggestionReason: "Companions need emotional depth and natural pacing — Premium tier gives human-level warmth and empathy",
    examplePrompt:    "You are a warm, caring personal assistant named {agent_name}. You remember context from the conversation, respond to emotions first and information second. You are never rushed. You use the caller's name naturally. You celebrate their wins and acknowledge their struggles. You are non-judgmental and always make the caller feel heard.",
  },
];


// ─────────────────────────────────────────────────────────────────────────────
// CORE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Indian language codes used for region detection */
export const INDIAN_LANGUAGE_CODES = new Set([
  'hi', 'gu', 'mr', 'ta', 'te', 'kn', 'bn', 'ml', 'pa', 'or'
]);

/**
 * Given a use case, returns the suggested tier + the reason string.
 * Used by the wizard to pre-select and show the suggestion badge.
 */
export function getRecommendedTier(useCaseId: UseCaseId): {
  tier:   VoiceTier;
  reason: string;
} {
  const useCase = USE_CASES.find((u) => u.id === useCaseId);
  if (!useCase) {
    return {
      tier:   VOICE_TIERS.find((t) => t.id === "professional")!,
      reason: "Professional tier works well for most use cases",
    };
  }
  return {
    tier:   VOICE_TIERS.find((t) => t.id === useCase.suggestedTier)!,
    reason: useCase.suggestionReason,
  };
}

/**
 * Given a tier ID and language region, returns the full provider config.
 * This is what gets saved on the Agent record in the database.
 */
export function resolveTierProviders(
  tierId:   TierId,
  region:   "indian" | "international",
  language: string,
  gender:   "female" | "male"
): {
  sttProvider:  string;
  sttModel:     string;
  sttMode:      string;
  ttsProvider:  string;
  ttsModel:     string;
  ttsPace:      number;
  ttsLoudness:  number;
  voiceId:      string;
  llmModel:     string;
  llmLabel:     string;
  voicePromptAddition: string;
  costPerMinUSD: number;
  tierLabel:    string;
} {
  const tier = VOICE_TIERS.find((t) => t.id === tierId) ?? VOICE_TIERS[1];

  // ── Voice ID map for Indian languages ──────────────────────────────────────
  const SARVAM_VOICES: Record<string, { female: string; male: string }> = {
    hi: { female: "meera",   male: "arjun"    },
    gu: { female: "diya",    male: "neel"     },
    mr: { female: "priya",   male: "rohan"    },
    ta: { female: "kavya",   male: "karthik"  },
    te: { female: "anushka", male: "vikram"   },
    kn: { female: "siya",    male: "tarun"    },
    bn: { female: "arya",    male: "abhilash" },
    ml: { female: "meera",   male: "arjun"    },
  };

  // ── ElevenLabs voice IDs ───────────────────────────────────────────────────
  const ELEVENLABS_VOICES = {
    female: "21m00Tcm4TlvDq8ikWAM", // Rachel — warm, clear
    male:   "VR6AewLTigWG4xSOukaG", // Arnold — confident
  };

  if (region === "indian") {
    const voices = SARVAM_VOICES[language] ?? SARVAM_VOICES["hi"];
    const cfg    = tier.indian;
    return {
      sttProvider:         cfg.sttProvider,
      sttModel:            cfg.sttModel,
      sttMode:             cfg.sttMode,
      ttsProvider:         cfg.ttsProvider,
      ttsModel:            cfg.ttsModel,
      ttsPace:             cfg.ttsPace,
      ttsLoudness:         cfg.ttsLoudness,
      voiceId:             voices[gender],
      llmModel:            cfg.llmModel,
      llmLabel:            cfg.llmLabel,
      voicePromptAddition: tier.voicePromptAddition,
      costPerMinUSD:       tier.costPerMinUSD,
      tierLabel:           tier.name,
    };
  } else {
    const cfg = tier.international;
    return {
      sttProvider:         cfg.sttProvider,
      sttModel:            "nova-3",   // Deepgram Nova-3
      sttMode:             "realtime",
      ttsProvider:         cfg.ttsProvider,
      ttsModel:            cfg.ttsModel,
      ttsPace:             1.0,
      ttsLoudness:         1.0,
      voiceId:             ELEVENLABS_VOICES[gender],
      llmModel:            cfg.llmModel,
      llmLabel:            cfg.llmLabel,
      voicePromptAddition: tier.voicePromptAddition,
      costPerMinUSD:       tier.costPerMinUSD,
      tierLabel:           tier.name,
    };
  }
}

/**
 * Builds the complete system prompt for an agent.
 * Combines: base persona + language instructions + tier voice rules.
 *
 * CALL THIS FUNCTION every time you build a system prompt for a call.
 * Do NOT manually concatenate prompts anywhere else.
 */
export function buildSystemPrompt(params: {
  personaPrompt: string;
  useCaseId?:    UseCaseId;
  tierId:        TierId;
  agentName:     string;
  language:      string;
  businessName?: string;
}): string {
  const tier    = VOICE_TIERS.find((t) => t.id === params.tierId) ?? VOICE_TIERS[1];
  const isIndian = INDIAN_LANGUAGE_CODES.has(params.language);

  // Replace template variables in persona
  const persona = params.personaPrompt
    .replace(/{agent_name}/g,    params.agentName)
    .replace(/{business_name}/g, params.businessName ?? "our company");

  // Language instruction
  const langInstruction = isIndian
    ? `\nYou are speaking with Indian callers. Respond in the SAME language the caller uses. If they use Hinglish (mixed Hindi-English), reply in Hinglish. If pure Hindi, reply in pure Hindi. If English, reply in English.\n`
    : `\nAlways respond in clear, natural ${
        params.language === "es" ? "Spanish"
        : params.language === "fr" ? "French"
        : "English"
      }.\n`;

  return `${persona}${langInstruction}${tier.voicePromptAddition}`;
}
