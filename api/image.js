// api/image.js
//
// POST { mode: "pexels" | "ai", query, sessionToken?, googleIdToken? }
//
//   mode: "pexels" -> free stock photo search, never costs a coin.
//   mode: "ai"     -> 2 coins (see PRICING.aiImage in lib/_limits.js),
//                     Replicate first, HuggingFace fallback; refunds the
//                     coin if BOTH fail (student got nothing).
//
// Used for: the Ebook image flow (Pexels first, AI if nothing relevant
// found — see lib/images.js's module comment) and the Notes "Pexels only"
// rule from the spec (api/image.js itself doesn't enforce that distinction;
// the frontend simply never sends mode:"ai" from the Notes flow).

import { searchPexelsImage, generateAIImage } from '../lib/images.js';
import { chargeForFeature, refundCoins, resolveIdentity } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  const { mode, query, sessionToken, googleIdToken } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Request must include a non-empty "query".' });
  }
  const prompt = query.trim().slice(0, 300);

  if (mode === 'pexels') {
    const photo = await searchPexelsImage(prompt);
    if (!photo) return res.status(404).json({ error: 'No relevant Pexels photo found for this.', configured: !!process.env.PEXELS_API_KEY });
    return res.status(200).json({ image: photo, source: 'pexels' });
  }

  if (mode === 'ai') {
    const { key: identityKey, user } = await resolveIdentity(req, { sessionToken, googleIdToken });
    if (process.env.REQUIRE_SIGN_IN === 'true' && !user) {
      return res.status(401).json({ error: 'Please sign in with Google to continue.', requiresSignIn: true });
    }
    const charge = await chargeForFeature(identityKey, 'aiImage');
    if (!charge.allowed) {
      return res.status(429).json({ error: charge.reason || 'Out of coins for an AI image.', outOfCredits: true });
    }
    try {
      const image = await generateAIImage(prompt);
      if (!image) {
        if (charge.configured && !charge.usedFree) await refundCoins(identityKey, 2);
        return res.status(502).json({ error: 'AI image generation is not available right now \u2014 your coin was refunded. Try Pexels instead, or try again shortly.' });
      }
      return res.status(200).json({ image, source: image.provider });
    } catch (err) {
      if (charge.configured && !charge.usedFree) await refundCoins(identityKey, 2);
      return res.status(500).json({ error: err.message || 'Unexpected server error.' });
    }
  }

  return res.status(400).json({ error: 'mode must be "pexels" or "ai".' });
}
