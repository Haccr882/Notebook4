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
const GROQ_120B_DAILY_LIMIT = parseInt(process.env.GROQ_120B_DAILY_LIMIT, 10) || 1000;

const MODELS = {
  openrouter: process.env.OPENROUTER_MODEL || 'openrouter/free',
  openrouterFallback: process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  groq: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  grok: process.env.XAI_MODEL || 'grok-2-latest',
  nvidia: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
};

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
async function callGroqWithDailyCap(apiKey, messages, maxTokens, model, timeoutMs){
  const limitResult = await checkAndIncrementLimit('global', GROQ_120B_DAILY_LIMIT, 'nb-groq120b');
  if (!limitResult.allowed) {
    throw new Error(`Groq gpt-oss-120b daily call cap reached (${GROQ_120B_DAILY_LIMIT}/day) — protecting the shared API key, falling back to the next provider.`);
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

/* PROVIDER REGISTRY — maps a provider name to (apiKeyEnvVar, call function).
   Adding a new provider later means adding one entry here. */
const PROVIDER_CALLERS = {
  openrouter: (messages, maxTokens, origin, timeoutMs) => callOpenRouter(process.env.OPENROUTER_API_KEY, messages, origin, MODELS.openrouter, maxTokens, timeoutMs),
  openrouterFallback: (messages, maxTokens, origin, timeoutMs) => callOpenRouter(process.env.OPENROUTER_API_KEY, messages, origin, MODELS.openrouterFallback, maxTokens, timeoutMs),
  groq: (messages, maxTokens, origin, timeoutMs) => callGroqWithDailyCap(process.env.GROQ_API_KEY, messages, maxTokens, undefined, timeoutMs),
  gemini: (messages, maxTokens, origin, timeoutMs) => callGemini(process.env.GEMINI_API_KEY, messages, maxTokens, undefined, timeoutMs),
  grok: (messages, maxTokens, origin, timeoutMs) => callGrok(process.env.XAI_API_KEY, messages, maxTokens, undefined, timeoutMs),
  nvidia: (messages, maxTokens, origin, timeoutMs) => callNvidia(process.env.NVIDIA_API_KEY, messages, maxTokens, undefined, timeoutMs),
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
};

/* Tries each provider name in `chain`, IN ORDER, until one succeeds.
   A provider whose API key isn't configured is skipped silently (not
   counted as a "failure") so partial setups still work. Returns
   { text, finishReason, modelUsed, providerUsed } from the first success,
   or throws an Error listing every failure if the whole chain is exhausted —
   this is the "double fallback" system: if one AI fails, the next one is
   tried automatically, all the way down the chain. */
async function callWithFallback(chain, messages, maxTokens, origin){
  const errors = [];
  const deadline = Date.now() + TOTAL_CHAIN_BUDGET_MS;
  for (const providerName of chain) {
    const envVar = PROVIDER_KEY_ENV[providerName];
    if (envVar && !process.env[envVar]) {
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
      const result = await PROVIDER_CALLERS[providerName](messages, tokensForThisProvider, origin, timeoutMs);
      return { ...result, providerUsed: providerName };
    } catch (err) {
      errors.push(`${providerName}: ${err.message}`);
    }
  }
  throw new Error(`All AI providers failed.\n${errors.join('\n')}`);
}

export { callWithFallback, MODELS, PROVIDER_KEY_ENV };
