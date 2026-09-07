// backend/api/chat.js
//
// DOUBT-SOLVING CHAT — deliberately separate from api/generate.js.
//
// generate.js's PLAN agent turns every request into a structured
// notes/specimen-paper document. That's wrong for a student who just wants
// to ask a quick doubt and keep talking — so this endpoint is a plain,
// stateful back-and-forth conversation with a tutor persona, and NEVER
// invokes the plan/section/PDF machinery at all.
//
// PROVIDER CHAIN for chat is optimized differently from document
// generation: Grok (xAI) first for a natural conversational feel, then
// Groq (fastest — good for snappy back-and-forth), then Gemini Flash
// (stable backup), then OpenRouter as the final safety net. If one fails,
// the next is tried automatically ("double fallback").
//
// RATE LIMIT: 20 chat messages/day on the free tier, tracked completely
// separately from the 5/day PDF-generation limit (different Upstash key
// prefix — see api/_limits.js).

import { callWithFallback } from './providers.js';
import { checkPremiumToken, checkAndIncrementLimit, getClientIp } from './_limits.js';

const DAILY_CHAT_LIMIT = 20;
const PREMIUM_DAILY_CHAT_LIMIT = 60;
const TOKENS_PER_REPLY = 1200;
const MAX_HISTORY_MESSAGES = 12; // keep the last few turns for context, not the whole thread

const CHAT_PROVIDER_CHAIN = ['grok', 'groq', 'gemini', 'openrouter'];

const CHAT_SYSTEM_PROMPT = `You are Notebook's doubt-solving tutor — a warm, patient school teacher having a real conversation with a student, not a document generator. You never produce structured notes, a specimen paper, or any JSON — just talk normally, like answering a question out loud.

Rules:
- Answer the actual doubt directly and clearly, in plain language a school student can follow. Explain the reasoning, not just the final answer.
- Use a concrete example or a simple analogy where it genuinely helps understanding.
- Keep replies focused and conversational — usually a short paragraph or a few, not an exhaustive essay, unless the student explicitly asks for a deep/detailed explanation.
- Math notation: NEVER use LaTeX (\\frac, \\sin, $...$). Use plain Unicode symbols instead: θ, π, √, °, ², ³, ×, ÷, ±, ≤, ≥, ∠, △.
- You may use **bold** for a key term or the final answer, sparingly.
- If the student's question is ambiguous, ask ONE short clarifying question instead of guessing.
- If asked something unrelated to studies, you can still answer briefly and helpfully — just stay a good, honest teacher.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { message, history, premiumToken } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Request must include a non-empty "message".' });
  }

  const isPremium = await checkPremiumToken(premiumToken);
  const limit = isPremium ? PREMIUM_DAILY_CHAT_LIMIT : DAILY_CHAT_LIMIT;
  const ip = getClientIp(req);
  const limitResult = await checkAndIncrementLimit(ip, limit, 'nb-chat');
  if (!limitResult.allowed) {
    return res.status(429).json({ error: `Daily chat limit reached (${limit} messages/day). ${isPremium ? '' : 'Upgrade to Premium for more, or '}try again after midnight.` });
  }

  // History comes from the frontend as [{role: "user"|"assistant", content}]
  // — trim to the last MAX_HISTORY_MESSAGES so context stays cheap and fast.
  const safeHistory = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
    : [];

  const chatMessages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...safeHistory,
    { role: 'user', content: message.trim().slice(0, 4000) },
  ];

  try {
    const { text, modelUsed, providerUsed } = await callWithFallback(CHAT_PROVIDER_CHAIN, chatMessages, TOKENS_PER_REPLY, req.headers.origin);
    return res.status(200).json({ reply: text, modelUsed, providerUsed });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
