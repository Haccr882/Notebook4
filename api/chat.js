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
// PROVIDER CHAIN for chat ("fast" task per the Notebook4 model routing):
// Groq (Llama 8B) first, then Gemini, then Qwen-on-Groq (backup), then
// OpenRouter, then HuggingFace as the guaranteed last fallback.
//
// COST: 5 messages/day free, then 1 coin per message after that (see
// PRICING/DAILY_FREE in lib/_limits.js). A failed reply (every provider
// down) refunds the coin, if one was actually spent.

import { callWithFallback } from '../lib/providers.js';
import { chargeForFeature, refundCoins, resolveIdentity } from '../lib/_limits.js';
import { supabaseLogUsage } from '../lib/supabase.js';

const TOKENS_PER_REPLY = 1200;
const MAX_HISTORY_MESSAGES = 12; // keep the last few turns for context, not the whole thread

// Doubt chat is a "fast" task per the Notebook4 spec's model routing.
const CHAT_PROVIDER_CHAIN = ['groq', 'gemini', 'groqBackup', 'openrouterFallback', 'huggingface'];

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

  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Request must include a non-empty "message".' });
  }

  // Same mandatory-once-configured rule as generate.js — see the comment
  // there for why this has to be enforced server-side, not just via a
  // hidden/shown button on the frontend.
  const { key: identityKey, user } = await resolveIdentity(req, {
    sessionToken: req.body?.sessionToken,
    googleIdToken: req.body?.googleIdToken,
  });
  if (process.env.REQUIRE_SIGN_IN === 'true' && !user) {
    return res.status(401).json({ error: 'Please sign in with Google to continue.', requiresSignIn: true });
  }

  const charge = await chargeForFeature(identityKey, 'chat');
  if (!charge.allowed) {
    return res.status(429).json({ error: charge.reason || 'Out of coins for today \u{1F614} Share the app for a bonus, or come back once you have more.', outOfCredits: true });
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
    const { text, modelUsed, providerUsed } = await callWithFallback(CHAT_PROVIDER_CHAIN, chatMessages, TOKENS_PER_REPLY, req.headers.origin, 'notes');
    await supabaseLogUsage({ userId: user?.email || null, apiUsed: 'chat', coinsUsed: charge.usedFree ? 0 : 1, status: charge.usedFree ? 'free' : 'ok' });
    return res.status(200).json({ reply: text, modelUsed, providerUsed });
  } catch (err) {
    // Every provider failed — the student got nothing, so give the coin back
    // (only if this message actually spent one, not if it was a free use).
    if (charge.configured && !charge.usedFree) await refundCoins(identityKey, 1);
    await supabaseLogUsage({ userId: user?.email || null, apiUsed: 'chat', coinsUsed: 0, status: 'error' });
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
