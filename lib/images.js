// backend/lib/images.js
//
// IMAGE SYSTEM (per the Notebook4 spec):
//   Notes  -> Pexels only (free stock photos)
//   Ebook  -> Pexels first, AI-generated if nothing relevant is found
//   AI image providers, in order: Replicate (stability-ai/sdxl) -> HuggingFace
//
// Every function here is env-var gated and returns null (never throws) when
// its key isn't configured, so the rest of the app degrades gracefully —
// exactly like every other optional provider in lib/providers.js.

const PEXELS_TIMEOUT_MS = 8000;
const REPLICATE_POLL_INTERVAL_MS = 1200;
const REPLICATE_POLL_BUDGET_MS = 25000; // Vercel Hobby functions get 10s by default, Pro/paid up to 60s — keep this under your plan's limit (see vercel.json's `maxDuration` for the image function)
const HF_TIMEOUT_MS = 20000;

function withTimeout(ms){
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/* ---------- Pexels (free stock photo search) ---------- */
/* Returns { url, width, height, photographer, photographerUrl, alt } or null
   (not configured, or no relevant result). Never costs a coin. */
export async function searchPexelsImage(query){
  const key = process.env.PEXELS_API_KEY;
  if (!key || !query) return null;
  const { signal, clear } = withTimeout(PEXELS_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`, {
      headers: { Authorization: key }, // Pexels wants the raw key, NOT "Bearer <key>"
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const photo = data.photos && data.photos[0];
    if (!photo) return null;
    return {
      url: photo.src.large || photo.src.medium || photo.src.original,
      width: photo.width, height: photo.height,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      alt: photo.alt || query,
      sourcePage: photo.url, // Pexels requires linking back to the photo page when you credit the photographer
    };
  } catch (err) {
    return null; // timeout, network error, bad key — caller just gets "no image", never a crash
  } finally {
    clear();
  }
}

/* ---------- Replicate (AI image, primary) ---------- */
/* Returns { url } or null. Uses the model-name endpoint (not a pinned
   version hash) so it always runs the model owner's current default
   version — no hardcoded version ID to go stale. */
async function generateWithReplicate(prompt){
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;
  const { signal, clear } = withTimeout(REPLICATE_POLL_BUDGET_MS);
  try {
    const createRes = await fetch('https://api.replicate.com/v1/models/stability-ai/sdxl/predictions', {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { prompt, width: 1024, height: 1024, num_outputs: 1 } }),
      signal,
    });
    if (!createRes.ok) return null;
    let prediction = await createRes.json();

    const deadline = Date.now() + REPLICATE_POLL_BUDGET_MS;
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, REPLICATE_POLL_INTERVAL_MS));
      const pollRes = await fetch(prediction.urls.get, { headers: { Authorization: `Token ${token}` }, signal });
      if (!pollRes.ok) return null;
      prediction = await pollRes.json();
    }
    if (prediction.status !== 'succeeded') return null; // failed, canceled, or we ran out of poll budget
    const out = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    return out ? { url: out } : null;
  } catch (err) {
    return null;
  } finally {
    clear();
  }
}

/* ---------- HuggingFace (AI image, fallback) ---------- */
/* Returns { url } where url is a data: URI (HF's Inference API returns raw
   image bytes, not a hosted URL, so there's nothing else to link to). */
async function generateWithHuggingFace(prompt){
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) return null;
  const model = process.env.HUGGINGFACE_IMAGE_MODEL || 'stabilityai/stable-diffusion-xl-base-1.0';
  const { signal, clear } = withTimeout(HF_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: prompt }),
      signal,
    });
    if (!res.ok) return null; // model loading (503), rate-limited, bad key, etc — caller falls through
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null; // HF returns JSON (not an image) on most error paths
    const buf = Buffer.from(await res.arrayBuffer());
    return { url: `data:${contentType};base64,${buf.toString('base64')}` };
  } catch (err) {
    return null;
  } finally {
    clear();
  }
}

/* Tries Replicate first, then HuggingFace. Returns { url, provider } or null
   if NEITHER is configured/working — caller (api/image.js) must refund the
   coin it charged if this returns null, since the student got nothing. */
export async function generateAIImage(prompt){
  const r = await generateWithReplicate(prompt);
  if (r) return { ...r, provider: 'replicate' };
  const h = await generateWithHuggingFace(prompt);
  if (h) return { ...h, provider: 'huggingface' };
  return null;
}
