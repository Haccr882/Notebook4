// backend/api/study-tools.js
//
// Flashcards and quiz generation — deliberately separate from
// generate.js's notes/specimen/project pipeline, since the OUTPUT shape
// is completely different (structured cards/questions, not
// heading+content sections) even though the underlying reliability
// techniques are the same ones proven out in generate.js:
//   - CHUNKING: ask for a handful of cards/questions per call, not the
//     whole deck at once, so one truncated call only costs a few items.
//   - VERIFY THE COUNT: check the actual array length came back right,
//     don't just trust the model said "done".
//   - RETRY per chunk, with backoff, using the full provider chain.
// This is a lighter-weight version of generate.js's full pipeline (no
// judge agent, no vision check, no multi-round final sweep) — a deck of
// flashcards or a quiz is lower-stakes than a full document, so 3
// attempts per chunk is a reasonable, fast, "good enough" bar rather than
// generate.js's much heavier guarantee.

import { callWithFallback } from '../lib/providers.js';
import { checkPremiumToken, checkAndIncrementLimit, resolveIdentity } from '../lib/_limits.js';

const DAILY_LIMIT = 5; // shares the SAME daily allowance as notes/paper/project generation — see api/generate.js
const PREMIUM_DAILY_LIMIT = 10;
const TOKENS_PER_CHUNK = 2500;
const CHUNK_SIZE = 6; // cards or questions per call
const CHUNK_ATTEMPTS = 3;

const PROVIDER_CHAIN = ['openrouter', 'grok', 'groq', 'gemini', 'nvidia', 'openrouterFallback'];

const FLASHCARD_PROMPT = `You are Notebook's flashcard-writing agent. Write EXACTLY the number of flashcards asked for, on the given topic, for a school student to memorize and self-test with.

Return ONLY valid JSON, no commentary:
{ "cards": [ { "front": "a short question, term, or prompt", "back": "the concise answer/explanation — 1-3 sentences, not a paragraph" } ] }

Rules:
- "front" is short — a term, a question, or a fill-in-the-blank, never a full sentence restating the whole concept.
- "back" is the direct answer, concise but complete enough to actually learn from — not just one word unless the front genuinely only needs one word.
- Cover genuinely distinct facts/concepts — never two cards asking near-identical things.
- Math notation: use plain Unicode symbols (θ, π, √, °, ², ×, ÷, ≤, ≥), never LaTeX.
- Return EXACTLY the requested count, nothing more, nothing less.`;

const QUIZ_PROMPT = `You are Notebook's quiz-writing agent. Write EXACTLY the number of multiple-choice questions asked for, on the given topic, at a genuine exam-standard difficulty for a school student.

Return ONLY valid JSON, no commentary:
{ "questions": [ { "question": "the question text", "options": ["option A", "option B", "option C", "option D"], "correctIndex": 0, "explanation": "1-2 sentences on why that's correct — mention the key concept, not just 'because it's right'" } ] }

Rules:
- Exactly 4 options per question, exactly one correct, "correctIndex" is 0-based.
- Distractor (wrong) options must be genuinely plausible — a common misconception or a near-miss value, never obviously silly.
- Vary which index is correct across questions — don't make every correct answer index 0.
- Math notation: use plain Unicode symbols (θ, π, √, °, ², ×, ÷, ≤, ≥), never LaTeX.
- Return EXACTLY the requested count, nothing more, nothing less.`;

function extractJSON(text){
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON object found in response.');
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

async function generateChunk(kind, userRequest, count, batchIndex, totalBatches){
  const isFlashcards = kind === 'flashcards';
  const systemPrompt = isFlashcards ? FLASHCARD_PROMPT : QUIZ_PROMPT;
  const arrayKey = isFlashcards ? 'cards' : 'questions';

  // Batches run in PARALLEL (see handler below) rather than sequentially —
  // sequential chunking here would risk stacking multiple 45s+ provider-
  // chain attempts back to back and blowing well past Vercel's 60s
  // function limit. Instead of literally showing each batch what earlier
  // ones wrote (which only works sequentially), each batch is told its
  // own slice index and asked to focus on a different angle/sub-topic —
  // a light-touch way to reduce overlap without needing to run in order.
  const batchHint = totalBatches > 1
    ? `\n\nThis is batch ${batchIndex + 1} of ${totalBatches} covering this topic overall — focus on a DIFFERENT sub-aspect or angle than the other batches likely would, to minimize overlap (you can't see the other batches, just aim for a different slice of the topic).`
    : '';
  const userMsg = `Topic/request: "${userRequest}"\nWrite EXACTLY ${count} ${isFlashcards ? 'flashcards' : 'quiz questions'}.${batchHint}`;

  let lastError;
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 600));
    try {
      const { text } = await callWithFallback(PROVIDER_CHAIN, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ], TOKENS_PER_CHUNK);
      const parsed = extractJSON(text);
      const items = parsed[arrayKey];
      if (Array.isArray(items) && items.length >= count) {
        return items.slice(0, count); // model sometimes over-delivers by one — trim to exactly what was asked
      }
      lastError = new Error(`Expected ${count} items, got ${Array.isArray(items) ? items.length : 0}.`);
    } catch (err) {
      lastError = err;
    }
  }
  return []; // this chunk genuinely failed after all attempts — caller just gets fewer items than asked, not a crash
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  const { kind, userRequest, count, isContinuation, premiumToken } = req.body || {};
  if (kind !== 'flashcards' && kind !== 'quiz') {
    return res.status(400).json({ error: 'Request must include kind: "flashcards" or "quiz".' });
  }
  if (!userRequest) {
    return res.status(400).json({ error: 'Request must include "userRequest".' });
  }
  const totalCount = Math.max(4, Math.min(40, parseInt(count, 10) || 12)); // sane bounds — a deck/quiz has no reason to exceed 40 items in one request

  if (!isContinuation) {
    const { key: identityKey, user } = await resolveIdentity(req, req.body?.googleIdToken);
    if (process.env.GOOGLE_CLIENT_ID && !user) {
      return res.status(401).json({ error: 'Please sign in with Google to continue.', requiresSignIn: true });
    }
    const isPremium = await checkPremiumToken(premiumToken);
    const limit = isPremium ? PREMIUM_DAILY_LIMIT : DAILY_LIMIT;
    const limitResult = await checkAndIncrementLimit(identityKey, limit, 'nb');
    if (!limitResult.allowed) {
      return res.status(429).json({ error: `Daily limit reached (${limit} per day). ${isPremium ? '' : 'Upgrade to Premium for more, or '}try again after midnight.` });
    }
  }

  const chunkSizes = [];
  for (let start = 0; start < totalCount; start += CHUNK_SIZE) {
    chunkSizes.push(Math.min(CHUNK_SIZE, totalCount - start));
  }

  try {
    // All batches run in parallel — see generateChunk's comment on why
    // (avoiding stacking several 45s+ provider-chain attempts sequentially
    // within Vercel's 60s function limit).
    const batches = await Promise.all(
      chunkSizes.map((size, i) => generateChunk(kind, userRequest, size, i, chunkSizes.length))
    );
    const results = batches.flat();
    if (results.length === 0) {
      return res.status(500).json({ error: 'Could not generate any items — please try again.' });
    }
    return res.status(200).json({ items: results, requested: totalCount, delivered: results.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
