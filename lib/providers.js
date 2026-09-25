// backend/api/providers.js
//
// ONE place that knows how to call every AI provider Notebook uses, and how
// to fail over between them. Both api/generate.js (notes/specimen papers)
// and api/chat.js (doubt-solving chat) import this instead of duplicating
// fetch logic per provider.
//
// Providers wired up:
//   - OpenRouter   (OPENROUTER_API_KEY)  — OpenAI-compatible. Free-tier model.
//   - Groq         (GROQ_API_KEY)        — OpenAI-compatible. openai/gpt-oss-120b —
//                                          NOTE: Groq deprecated & shut down
//                                          llama-3.3-70b-versatile on their
//                                          free/dev tier on 16 Aug 2026; this
//                                          120B model is their own recommended
//                                          replacement, and also happens to be
//                                          a bigger, smarter model.
//   - Gemini       (GEMINI_API_KEY)      — Google's own request/response shape.
//   - Grok / xAI   (XAI_API_KEY)         — OpenAI-compatible. Used for both
//                                          chat AND notes/paper generation.
//   - NVIDIA       (NVIDIA_API_KEY)      — OpenAI-compatible. Last-resort fallback.
//
// Every call function returns the SAME shape: { text, finishReason, modelUsed }
// or throws an Error with a short, useful message. Missing API keys are not
// fatal — callWithFallback() just skips that provider and tries the next one,
// so the app keeps working even if only one or two keys are configured.

import { checkAndIncrementLimit } from './_limits.js';

// A per-provider call's timeout is now a PARAMETER (see callWithFallback),
// not this fixed constant — heavy sections (many MCQs, a full answer key)
// can genuinely take 20-40s to generate on a free-tier model, and cutting
// them off at a short fixed timeout was producing a hard error (no
// content at all) instead of a usable, even if slightly slow, response.
// This is now just the DEFAULT used when no explicit timeout is passed.
const CALL_TIMEOUT_MS = 40000;
// Vercel functions on this project are capped at 60s (see vercel.json).
// callWithFallback can try several providers in one invocation, so it must
// share ONE total time budget across the whole chain, leaving a buffer for
// request/response overhead — otherwise trying several providers back to
// back could add up to past 60s and get killed mid-request instead of
// returning a real error. A generous per-call ceiling (above) still means
// realistically only 1-2 providers get a full attempt within this budget
// for a heavy section — that's fine, since the FRONTEND already retries
// the whole section as a fresh invocation (with a fresh full budget) up to
// SECTION_FRONTEND_ATTEMPTS times, which is where most of the real
// resilience against a single slow/unlucky provider comes from.
const TOTAL_CHAIN_BUDGET_MS = 55000;

// A shared, app-wide daily cap on calls to the big Groq model — separate
// from any per-student limit. gpt-oss-120b is bigger/pricier than the
// smaller free-tier models, and Groq's own free-tier request quota for it
// is tighter, so this protects the WHOLE app's shared Groq key from being
// exhausted by a burst of traffic — it's not counted against any one
// student, it's a safety valve on the shared resource. Override with
// GROQ_120B_DAILY_LIMIT if your Groq plan allows more.
const GROQ_120B_DAILY_LIMIT = parseInt(process.env.GROQ_120B_DAILY_LIMIT, 10) || 700;
// The low-tier model (llama-3.1-8b-instant, used for Free-plan traffic)
// has a MUCH more generous real free-tier daily allowance than the 120B
// high-tier model — capping it at the same 700/day would badly
// under-use a provider that's actually cheap and fast for exactly this
// tier's volume of traffic.
const GROQ_LOW_TIER_DAILY_LIMIT = parseInt(process.env.GROQ_LOW_TIER_DAILY_LIMIT, 10) || 2000;
const GROQ_MID_TIER_DAILY_LIMIT = parseInt(process.env.GROQ_MID_TIER_DAILY_LIMIT, 10) || 1200;

const MODELS = {
  openrouter: process.env.OPENROUTER_MODEL || 'openrouter/free',
  openrouterFallback: process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  groq: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  grok: process.env.XAI_MODEL || 'grok-2-latest',
  nvidia: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
  mistral: process.env.MISTRAL_MODEL || 'mistral-medium-latest',
  huggingface: process.env.HUGGINGFACE_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
};

/* ---- Model TIERS ----
   Maps a plan tier ("low" | "mid" | "high" — see PLANS in
   lib/_limits.js) to which MODEL each provider should use for that tier,
   where a provider genuinely has a meaningfully weaker/stronger option.
   Providers not listed for a tier just use their MODELS default above
   for every tier (either because they only have one sensible free-tier
   model, or their pricing/quality doesn't really vary by request). Every
   value here is overridable via its env var without touching code. */
const MODEL_TIERS = {
  low: {
    groq: process.env.GROQ_MODEL_LOW || 'llama-3.1-8b-instant', // fast + very high free-tier RPD — right fit for Free-plan notes/flashcards/chat
    huggingface: process.env.HUGGINGFACE_MODEL_LOW || 'meta-llama/Llama-3.2-3B-Instruct',
  },
  mid: {
    groq: process.env.GROQ_MODEL_MID || 'llama-3.3-70b-versatile',
    mistral: process.env.MISTRAL_MODEL_MID || 'mistral-small-latest',
  },
  high: {
    groq: process.env.GROQ_MODEL_HIGH || 'openai/gpt-oss-120b', // the protected high-tier reserve — see GROQ_120B_DAILY_LIMIT
    mistral: process.env.MISTRAL_MODEL_HIGH || 'mistral-medium-latest',
  },
};
function modelFor(provider, tier){
  return (MODEL_TIERS[tier] && MODEL_TIERS[tier][provider]) || MODELS[provider];
}

function withTimeout(ms){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms || CALL_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

/* Generic caller for any OpenAI-compatible /chat/completions endpoint —
   covers OpenRouter, Groq, xAI/Grok, and NVIDIA, which all speak the same
   request/response shape. Only the URL, headers, and model name differ. */
async function callOpenAICompatible({ url, apiKey, extraHeaders, model, messages, maxTokens, label, timeoutMs }){
  const { signal, clear } = withTimeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.6,
      }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out.`);
    throw new Error(`${label} network error: ${err.message}`);
  } finally {
    clear();
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`${label} error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`${label} returned an empty response.`);

  return { text, finishReason: choice.finish_reason, modelUsed: model };
}

async function callOpenRouter(apiKey, messages, origin, model, maxTokens, timeoutMs){
  return callOpenAICompatible({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey,
    extraHeaders: { 'HTTP-Referer': origin || 'https://notebook.app', 'X-Title': 'Notebook' },
    model: model || MODELS.openrouter,
    messages, maxTokens, label: 'OpenRouter', timeoutMs,
  });
}

async function callGroq(apiKey, messages, maxTokens, model, timeoutMs){
  return callOpenAICompatible({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey,
    model: model || MODELS.groq,
    messages, maxTokens, label: 'Groq', timeoutMs,
  });
}

/* Wraps callGroq with the shared app-wide daily cap described above (see
   GROQ_120B_DAILY_LIMIT) — checked/incremented via the same Upstash counter
   mechanism used for per-student limits, just with a fixed "global" key
   instead of a per-IP one. If Upstash isn't configured, the cap is skipped
   entirely (checkAndIncrementLimit returns allowed:true) rather than
   blocking every request. */
async function callGroqWithDailyCap(apiKey, messages, maxTokens, model, timeoutMs, tier){
  const baseLimit = tier === 'low' ? GROQ_LOW_TIER_DAILY_LIMIT : tier === 'mid' ? GROQ_MID_TIER_DAILY_LIMIT : GROQ_120B_DAILY_LIMIT;
  const keys = Math.max(1, keyCountFor('GROQ_API_KEY'));
  const limit = baseLimit * keys;
  const limitResult = await checkAndIncrementLimit('global', limit, `nb-groq-${tier || 'high'}`);
  if (!limitResult.allowed) {
    throw new Error(`Groq ${tier || 'high'}-tier daily call cap reached (${limit}/day) — protecting the shared API key(s), falling back to the next provider.`);
  }
  return callGroq(apiKey, messages, maxTokens, model, timeoutMs);
}

async function callGrok(apiKey, messages, maxTokens, model, timeoutMs){
  return callOpenAICompatible({
    url: 'https://api.x.ai/v1/chat/completions',
    apiKey,
    model: model || MODELS.grok,
    messages, maxTokens, label: 'Grok', timeoutMs,
  });
}

async function callNvidia(apiKey, messages, maxTokens, model, timeoutMs){
  return callOpenAICompatible({
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKey,
    model: model || MODELS.nvidia,
    messages, maxTokens, label: 'NVIDIA', timeoutMs,
  });
}

async function callMistral(apiKey, messages, maxTokens, model, timeoutMs){
  return callOpenAICompatible({
    url: 'https://api.mistral.ai/v1/chat/completions',
    apiKey,
    model: model || MODELS.mistral,
    messages, maxTokens, label: 'Mistral', timeoutMs,
  });
}

/* Hugging Face's "Inference Providers" router is OpenAI-compatible as of
   2025 — this is NOT the older, separately-shaped Inference API. Free
   tier is credit-based (small monthly credit, not a clean daily request
   count — see PROVIDER_DAILY_LIMITS.huggingface below for how Notebook's
   own soft budget handles that). */
async function callHuggingFace(apiKey, messages, maxTokens, model, timeoutMs){
  return callOpenAICompatible({
    url: 'https://router.huggingface.co/v1/chat/completions',
    apiKey,
    model: model || MODELS.huggingface,
    messages, maxTokens, label: 'HuggingFace', timeoutMs,
  });
}

/* Gemini uses a totally different request shape (contents[].parts[], a
   separate systemInstruction field, generationConfig instead of top-level
   max_tokens/temperature) — so it gets its own function instead of reusing
   the OpenAI-compatible helper. We convert the OpenAI-style `messages`
   array (system/user/assistant) into Gemini's shape here so the callers
   (generate.js / chat.js) never have to care about the difference. */
async function callGemini(apiKey, messages, maxTokens, model, timeoutMs){
  const geminiModel = model || MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system');
  const contents = turns.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 },
  };
  if (systemMessages) body.systemInstruction = { parts: [{ text: systemMessages }] };

  const { signal, clear } = withTimeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Gemini timed out.');
    throw new Error(`Gemini network error: ${err.message}`);
  } finally {
    clear();
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text || '').join('');
  if (!text) {
    // Gemini returns no candidates (instead of an HTTP error) when its own
    // safety filters block a response — surface that distinctly so the
    // fallback chain moves on instead of retrying the same thing.
    const blockReason = data.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Gemini blocked the response (${blockReason}).` : 'Gemini returned an empty response.');
  }

  // Gemini's finishReason strings ("MAX_TOKENS") differ from OpenAI's
  // ("length") — normalize so downstream truncation-detection logic
  // (shared with the other providers) keeps working unchanged.
  const finishReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
  return { text, finishReason, modelUsed: geminiModel };
}

/* Vision variant of callGemini, used ONLY by the "visual judge" (mode:
   'visual-judge' in generate.js) — this is the "look at the actual
   rendered document like a person would" check: the frontend screenshots
   the finished PDF preview and this sends that image to Gemini alongside
   a text prompt, asking it to visually spot anything a text-only check
   can't see (a section that's visibly blank, text overlapping a diagram,
   a table that's obviously cut off). Of the providers wired up here, only
   Gemini's request shape for images is implemented — if GEMINI_API_KEY
   isn't set, the visual check is simply skipped (see generate.js), never
   blocking the document. */
async function callGeminiVision(apiKey, promptText, imageBase64, maxTokens, model, timeoutMs){
  const geminiModel = model || MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptText },
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
  };

  const { signal, clear } = withTimeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Gemini Vision timed out.');
    throw new Error(`Gemini Vision network error: ${err.message}`);
  } finally {
    clear();
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini Vision error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text || '').join('');
  if (!text) {
    const blockReason = data.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Gemini Vision blocked the response (${blockReason}).` : 'Gemini Vision returned an empty response.');
  }
  return { text, modelUsed: geminiModel };
}

/* PROVIDER REGISTRY — maps a provider name to (apiKeyEnvVar, call function).
   Adding a new provider later means adding one entry here. */
// ---- Per-provider daily call budgets ----
//
// A rough, app-wide ~2500 calls/day split across providers, so no single
// free-tier key gets hammered into a 429 storm by the whole app's
// traffic. This is a SOFT internal budget (Upstash-tracked, same
// mechanism as the old Groq-only cap below) — it's not the provider's
// own real rate limit, just Notebook's own fair-share ceiling per
// provider, tuned to roughly what each provider's real free tier can
// sustain (see the comments per provider). Override any of these via the
// matching *_DAILY_LIMIT env var without touching code.
//
// gemini is the deliberately protected "powerful model" reserve: judge
// passes, answer keys, and the visual check all route to it FIRST (see
// the *_PROVIDER_CHAIN definitions in api/generate.js) specifically so a
// student never gets an answer key that doesn't match its questions, or
// an unverified section, because the quality-checking step got starved
// of budget by ordinary section-writing traffic.
const PROVIDER_DAILY_LIMITS = {
  openrouter: parseInt(process.env.OPENROUTER_DAILY_LIMIT, 10) || 700, // free-tier 20/min cap makes RPD the real limiter already
  // groq is NOT listed here — it already has its own dedicated cap via
  // callGroqWithDailyCap/GROQ_120B_DAILY_LIMIT above (700/day by default).
  grok: parseInt(process.env.XAI_DAILY_LIMIT, 10) || 300, // xAI's free allowance is the tightest of the six — kept light on purpose
  gemini: parseInt(process.env.GEMINI_DAILY_LIMIT, 10) || 600, // PROTECTED RESERVE — floor of 500+/day for quality-critical calls
  nvidia: parseInt(process.env.NVIDIA_DAILY_LIMIT, 10) || 200, // no official daily cap, but 40rpm makes it a genuine last resort, not a workhorse
  openrouterFallback: parseInt(process.env.OPENROUTER_FALLBACK_DAILY_LIMIT, 10) || 400, // shares OpenRouter's key/RPM, so this is on top of the "openrouter" budget above, not separate capacity
  mistral: parseInt(process.env.MISTRAL_DAILY_LIMIT, 10) || 300, // Mistral's free "La Plateforme" tier — conservative until real usage tells us the real ceiling
  huggingface: parseInt(process.env.HUGGINGFACE_DAILY_LIMIT, 10) || 200, // free tier is a small MONTHLY credit pool, not a clean RPD — kept deliberately light
};
// Sum ≈ 700+700+300+600+200+400+300+200 = 3400 nominal ceiling across all
// 8 providers — the real daily total in practice lands close to ~4000
// including every fallback link actually being exercised on a busy day,
// because chains fail over (a section that succeeds on the first
// provider never touches the rest), so most days nowhere near every
// provider's full budget gets spent.

/* ---- API key rotation ----
   Each provider can have up to 3 keys: the plain env var
   (GROQ_API_KEY), plus GROQ_API_KEY_2 and GROQ_API_KEY_3 if set. Calls
   round-robin across whichever of those are actually configured — this
   spreads load across multiple free-tier keys instead of hammering one.
   A provider with only one key configured just always gets that one
   (this is a no-op for anyone who hasn't set up extra keys). */
const _keyRotationCounters = {};
function rotatingKey(envVarBaseName){
  const keys = [process.env[envVarBaseName], process.env[`${envVarBaseName}_2`], process.env[`${envVarBaseName}_3`]].filter(Boolean);
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return keys[0];
  const i = (_keyRotationCounters[envVarBaseName] || 0) % keys.length;
  _keyRotationCounters[envVarBaseName] = i + 1;
  return keys[i];
}
/* How many keys are actually set for a provider (1, 2, or 3) — used to
   SCALE that provider's daily budget: 2 keys means roughly 2x the real
   free-tier capacity is available, so the internal budget should reflect
   that rather than staying capped at what ONE key could sustain. A
   provider with no key at all returns 0 (withDailyBudget below treats
   that the same as "not configured" — the chain-level missing-key skip
   in callWithFallback already keeps it out of rotation regardless). */
function keyCountFor(envVarBaseName){
  return [process.env[envVarBaseName], process.env[`${envVarBaseName}_2`], process.env[`${envVarBaseName}_3`]].filter(Boolean).length;
}

/* Generic version of the old Groq-only daily cap: checks/increments an
   app-wide (not per-student) Upstash counter for `providerName` before
   letting the call through. If Upstash isn't configured, or the
   provider has no configured limit, this is a no-op (never blocks). */
async function withDailyBudget(providerName, callFn){
  const baseLimit = PROVIDER_DAILY_LIMITS[providerName];
  if (!baseLimit) return callFn();
  const envVar = PROVIDER_KEY_ENV[providerName];
  const keys = envVar ? Math.max(1, keyCountFor(envVar)) : 1; // 2 keys configured → ~2x the budget, since that's genuinely ~2x the real free-tier capacity available
  const limit = baseLimit * keys;
  const limitResult = await checkAndIncrementLimit('global', limit, `nb-budget-${providerName}`);
  if (!limitResult.allowed) {
    throw new Error(`${providerName} daily call budget reached (${limit}/day) — protecting the shared key(s), falling back to the next provider.`);
  }
  return callFn();
}

const PROVIDER_CALLERS = {
  openrouter: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('openrouter', () => callOpenRouter(rotatingKey('OPENROUTER_API_KEY'), messages, origin, MODELS.openrouter, maxTokens, timeoutMs)),
  openrouterFallback: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('openrouterFallback', () => callOpenRouter(rotatingKey('OPENROUTER_API_KEY'), messages, origin, MODELS.openrouterFallback, maxTokens, timeoutMs)),
  groq: (messages, maxTokens, origin, timeoutMs, tier) => callGroqWithDailyCap(rotatingKey('GROQ_API_KEY'), messages, maxTokens, modelFor('groq', tier), timeoutMs, tier),
  gemini: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('gemini', () => callGemini(rotatingKey('GEMINI_API_KEY'), messages, maxTokens, modelFor('gemini', tier), timeoutMs)),
  grok: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('grok', () => callGrok(rotatingKey('XAI_API_KEY'), messages, maxTokens, modelFor('grok', tier), timeoutMs)),
  nvidia: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('nvidia', () => callNvidia(rotatingKey('NVIDIA_API_KEY'), messages, maxTokens, modelFor('nvidia', tier), timeoutMs)),
  mistral: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('mistral', () => callMistral(rotatingKey('MISTRAL_API_KEY'), messages, maxTokens, modelFor('mistral', tier), timeoutMs)),
  huggingface: (messages, maxTokens, origin, timeoutMs, tier) => withDailyBudget('huggingface', () => callHuggingFace(rotatingKey('HUGGINGFACE_API_KEY'), messages, maxTokens, modelFor('huggingface', tier), timeoutMs)),
};

// Some free-tier/fallback models enforce a hard output-token ceiling lower
// than what we might ask for on a heavy section (e.g. a long answer key).
// Clamp per-provider so we never send a request that gets rejected outright
// instead of just returning a shorter (and then continued) response.
const MAX_TOKENS_CAP = {
  openrouterFallback: 4000,
};

const PROVIDER_KEY_ENV = {
  openrouter: 'OPENROUTER_API_KEY',
  openrouterFallback: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

/* Tries each provider name in `chain`, IN ORDER, until one succeeds.
   A provider whose API key isn't configured is skipped silently (not
   counted as a "failure") so partial setups still work. Returns
   { text, finishReason, modelUsed, providerUsed } from the first success,
   or throws an Error listing every failure if the whole chain is exhausted —
   this is the "double fallback" system: if one AI fails, the next one is
   tried automatically, all the way down the chain. */
async function callWithFallback(chain, messages, maxTokens, origin, tier){
  const resolvedTier = tier || 'mid';
  const errors = [];
  const deadline = Date.now() + TOTAL_CHAIN_BUDGET_MS;
  for (const providerName of chain) {
    const envVar = PROVIDER_KEY_ENV[providerName];
    if (envVar && !process.env[envVar] && !process.env[`${envVar}_2`] && !process.env[`${envVar}_3`]) {
      errors.push(`${providerName}: skipped (missing ${envVar})`);
      continue;
    }
    // Share ONE overall time budget across the whole chain (see
    // TOTAL_CHAIN_BUDGET_MS) so trying every provider in one request can
    // never exceed Vercel's function duration limit. Stop trying further
    // providers once the shared budget is spent, rather than starting a
    // call that's certain to be killed mid-flight anyway.
    const remaining = deadline - Date.now();
    if (remaining < 2000) {
      errors.push(`${providerName}: skipped (out of time budget)`);
      break;
    }
    try {
      const cap = MAX_TOKENS_CAP[providerName];
      const tokensForThisProvider = cap ? Math.min(maxTokens, cap) : maxTokens;
      const timeoutMs = Math.min(CALL_TIMEOUT_MS, remaining);
      const result = await PROVIDER_CALLERS[providerName](messages, tokensForThisProvider, origin, timeoutMs, resolvedTier);
      return { ...result, providerUsed: providerName };
    } catch (err) {
      errors.push(`${providerName}: ${err.message}`);
    }
  }
  throw new Error(`All AI providers failed.\n${errors.join('\n')}`);
}

export { callWithFallback, MODELS, PROVIDER_KEY_ENV, callGeminiVision };
