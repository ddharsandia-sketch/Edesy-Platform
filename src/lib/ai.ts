import OpenAI from 'openai';
import { prisma } from './prisma';

// Groq (OpenAI-compatible) for Magic Prompt
export const groqClient = new OpenAI({
  apiKey: process.env.GLOBAL_GROQ_API_KEY || 'placeholder',
  baseURL: 'https://api.groq.com/openai/v1',
});

// Cerebras (OpenAI-compatible) for Schema Generation
export const cerebrasClient = new OpenAI({
  apiKey: process.env.GLOBAL_CEREBRAS_API_KEY || 'placeholder',
  baseURL: 'https://api.cerebras.ai/v1',
});

// Gemini REST API fallback
async function callGemini(prompt: string, apiKey?: string | null): Promise<string> {
  const finalKey = apiKey || process.env.GOOGLE_GEMINI_API_KEY;
  if (!finalKey) throw new Error('No Gemini API key set (global or workspace)');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${finalKey}`;
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
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ── Magic Prompt ─────────────────────────────────────────────────────────────
export async function generateMagicPrompt(description: string, workspaceId?: string): Promise<string> {
  try {
  const systemMsg = `You are an expert AI Voice Agent Prompt Engineer. 
Take the short description and expand it into a highly structured system prompt for a voice AI agent.
Include:
1. Identity & Persona (tone, style, name)
2. Primary Objective (what to accomplish in the call)
3. Core Constraints (what NOT to do)
4. Conversation Flow (step-by-step guidance)
5. Edge Cases (anger, off-topic, confusion)
Output the prompt directly. No intro text. No markdown headers.`;

  let groqKey = process.env.GLOBAL_GROQ_API_KEY;
  let geminiKey = process.env.GOOGLE_GEMINI_API_KEY;

  if (workspaceId) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws?.groqApiKey) groqKey = ws.groqApiKey;
    if (ws?.geminiApiKey) geminiKey = ws.geminiApiKey;
  }

  // Try Groq first
  if (groqKey && groqKey !== 'placeholder') {
    try {
      const client = new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
      const res = await client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: `Short description: ${description}` }
        ],
        temperature: 0.7,
        max_tokens: 1500,
      });
      const text = res.choices[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      console.warn('[AI] Groq failed, using Gemini fallback:', (e as Error).message.replace(/key=\w+/g, 'key=***'));
    }
  }

  // Gemini fallback
  return await callGemini(`${systemMsg}\n\nShort description: ${description}`, geminiKey);
  } catch (error) {
    console.error('[AI] All providers failed for magic prompt:', (error as Error).message.replace(/key=\w+/g, 'key=***'))
    return `You are an AI voice agent. ${description}. Respond naturally and helpfully.`
  }
}

// ── Schema Generator ─────────────────────────────────────────────────────────
export async function generateSchema(description: string, workspaceId?: string): Promise<any> {
  try {
  const systemMsg = `Generate a valid JSON Schema (Draft 7) for data extraction based on the user description.
The schema should capture the 4-6 most important pieces of information.
Output ONLY the raw JSON object. No markdown fences, no explanatory text.`;

  let cerebrasKey = process.env.GLOBAL_CEREBRAS_API_KEY;
  let geminiKey = process.env.GOOGLE_GEMINI_API_KEY;

  if (workspaceId) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws?.cerebrasApiKey) cerebrasKey = ws.cerebrasApiKey;
    if (ws?.geminiApiKey) geminiKey = ws.geminiApiKey;
  }

  let raw = '{}';

  // Try Cerebras first
  if (cerebrasKey && cerebrasKey !== 'placeholder') {
    try {
      const client = new OpenAI({
        apiKey: cerebrasKey,
        baseURL: 'https://api.cerebras.ai/v1',
      });
      const res = await client.chat.completions.create({
        model: 'llama3.1-8b',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: `Description: ${description}` }
        ],
        temperature: 0.1,
        max_tokens: 1000,
      });
      raw = res.choices[0]?.message?.content?.trim() || '{}';
    } catch (e) {
      console.warn('[AI] Cerebras failed, using Gemini fallback:', (e as Error).message.replace(/key=\w+/g, 'key=***'));
      raw = await callGemini(`${systemMsg}\n\nDescription: ${description}`, geminiKey);
    }
  } else {
    raw = await callGemini(`${systemMsg}\n\nDescription: ${description}`, geminiKey);
  }

  // Strip markdown fences
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('[AI] Schema parse failed:', cleaned);
    return {};
  }
  } catch (error) {
    console.error('[AI] All providers failed for schema generation:', (error as Error).message.replace(/key=\w+/g, 'key=***'))
    return { type: 'object', properties: {} }
  }
}
