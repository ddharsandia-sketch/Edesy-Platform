"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cerebrasClient = exports.groqClient = void 0;
exports.generateMagicPrompt = generateMagicPrompt;
exports.generateSchema = generateSchema;
const openai_1 = __importDefault(require("openai"));
// Groq (OpenAI-compatible) for Magic Prompt
exports.groqClient = new openai_1.default({
    apiKey: process.env.GLOBAL_GROQ_API_KEY || 'placeholder',
    baseURL: 'https://api.groq.com/openai/v1',
});
// Cerebras (OpenAI-compatible) for Schema Generation
exports.cerebrasClient = new openai_1.default({
    apiKey: process.env.GLOBAL_CEREBRAS_API_KEY || 'placeholder',
    baseURL: 'https://api.cerebras.ai/v1',
});
// Gemini REST API fallback (no SDK needed — uses googleapis key already in env)
async function callGemini(prompt) {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey)
        throw new Error('No Gemini API key set');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
        const errBody = await res.text();
        console.error('[AI] Gemini HTTP error:', res.status, errBody);
        throw new Error(`Gemini HTTP ${res.status}: ${errBody}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}
// ── Magic Prompt (Groq first, Gemini fallback) ───────────────────────────────
async function generateMagicPrompt(description) {
    const systemMsg = `You are an expert AI Voice Agent Prompt Engineer. 
Take the short description and expand it into a highly structured system prompt for a voice AI agent.
Include:
1. Identity & Persona (tone, style, name)
2. Primary Objective (what to accomplish in the call)
3. Core Constraints (what NOT to do)
4. Conversation Flow (step-by-step guidance)
5. Edge Cases (anger, off-topic, confusion)
Output the prompt directly. No intro text. No markdown headers.`;
    // Try Groq first
    if (process.env.GLOBAL_GROQ_API_KEY) {
        try {
            const res = await exports.groqClient.chat.completions.create({
                model: 'llama3-70b-8192',
                messages: [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: `Short description: ${description}` }
                ],
                temperature: 0.7,
                max_tokens: 1500,
            });
            const text = res.choices[0]?.message?.content?.trim();
            if (text)
                return text;
        }
        catch (e) {
            console.warn('[AI] Groq failed, using Gemini fallback:', e.message);
        }
    }
    // Gemini fallback
    return callGemini(`${systemMsg}\n\nShort description: ${description}`);
}
// ── Schema Generator (Cerebras first, Gemini fallback) ───────────────────────
async function generateSchema(description) {
    const systemMsg = `Generate a valid JSON Schema (Draft 7) for data extraction based on the user description.
Output ONLY the raw JSON object. No markdown fences, no explanatory text.`;
    let raw = '{}';
    // Try Cerebras first
    if (process.env.GLOBAL_CEREBRAS_API_KEY) {
        try {
            const res = await exports.cerebrasClient.chat.completions.create({
                model: 'llama3.1-8b',
                messages: [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: `Description: ${description}` }
                ],
                temperature: 0.1,
                max_tokens: 1000,
            });
            raw = res.choices[0]?.message?.content?.trim() || '{}';
        }
        catch (e) {
            console.warn('[AI] Cerebras failed, using Gemini fallback:', e.message);
            raw = await callGemini(`${systemMsg}\n\nDescription: ${description}`);
        }
    }
    else {
        raw = await callGemini(`${systemMsg}\n\nDescription: ${description}`);
    }
    // Strip markdown fences if the model added them
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    try {
        return JSON.parse(cleaned);
    }
    catch {
        console.error('[AI] Schema parse failed:', cleaned);
        return {};
    }
}
