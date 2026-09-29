// api/promote.js - "Generate Promotion": reel script, hook, caption, hashtags.
// Uses the cheap/fast 8B-class model (Mistral ministral-8b-latest) - the
// 'promo' tier in lib/providers.js. Limited to 5/day per identity (no credit cost).

import { callWithFallback } from '../lib/providers.js';
import { checkAndIncrementLimit, resolveIdentity } from '../lib/_limits.js';

const DAILY_PROMO_LIMIT = 5;
const PROMO_CHAIN = ['mistral', 'groq', 'huggingface', 'openrouter'];

const PROMO_PROMPT = `Create a viral Instagram reel promotion for a student notes website called "Notebook" (AI study notes, PDFs, ebooks - free).

Return ONLY valid JSON, no commentary:
{
  "hook": "the first 3 seconds - one punchy line that stops the scroll",
  "problem": "1-2 lines: the relatable student problem",
  "solution": "1-2 lines: how Notebook solves it",
  "cta": "one clear call to action",
  "reelScript": "the full reel script, scene by scene, short lines, spoken in simple Hinglish",
  "caption": "an engaging Instagram caption with 2-3 emojis",
  "hashtags": ["exactly 10 hashtags, each starting with #"]
}`;

function extractJSON(text){
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  const { topic, planPromo, sessionToken, googleIdToken } = req.body || {};
  const { key } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const limit = await checkAndIncrementLimit(key, DAILY_PROMO_LIMIT, 'nb-promo');
  if (!limit.allowed) return res.status(429).json({ error: `Promotion limit reached (${DAILY_PROMO_LIMIT}/day). Try tomorrow.` });

  const topicLine = topic ? `\nFocus this reel on notes for: ${String(topic).slice(0, 120)}` : '';
  // planPromo (optional) is the planner's own topic-specific mini-teaser,
  // generated for free alongside the document's plan (see "promo" in
  // PLAN_PROMPT, api/generate.js). Passing it forward keeps the full reel/
  // caption CONSISTENT with what the plan already committed to, instead of
  // this call inventing a different angle from scratch.
  const planLine = (planPromo && planPromo.hook)
    ? `\nThe planning stage already came up with this angle for this exact document — build on it, keep the SAME hook idea (you may sharpen the wording), and stay consistent with it rather than inventing a different angle:\nHook: ${String(planPromo.hook).slice(0, 200)}\nCaption idea: ${String(planPromo.caption || '').slice(0, 200)}`
    : '';
  try {
    const { text, modelUsed } = await callWithFallback(PROMO_CHAIN, [
      { role: 'system', content: PROMO_PROMPT },
      { role: 'user', content: `Write the promotion now.${topicLine}${planLine}` },
    ], 1200, req.headers.origin, 'promo');
    const promo = extractJSON(text);
    if (!promo || !promo.hook) return res.status(502).json({ error: 'Could not build the promotion - please try again.' });
    return res.status(200).json({ promo, modelUsed });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
