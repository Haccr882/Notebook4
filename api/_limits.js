// backend/api/_limits.js
//
// Shared Upstash-backed helpers: premium-token verification and per-day,
// per-IP rate limiting. Used by both api/generate.js (PDF/notes generation)
// and api/chat.js (doubt-solving chat) — each with its OWN counter key
// prefix, so a student's 5 PDFs/day and 20 chat messages/day are tracked
// completely independently of each other.

export async function checkPremiumToken(premiumToken){
  if (!premiumToken) return false;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const res = await fetch(`${url}/get/nb-premium:${premiumToken}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result === 'active';
  } catch (err) {
    return false; // if the check itself fails, fall back to free-tier limits rather than blocking everyone
  }
}

/* keyPrefix lets callers keep separate counters — e.g. "nb" for PDF
   generations and "nb-chat" for doubt-chat messages — under the same
   Upstash database without them interfering with each other. */
export async function checkAndIncrementLimit(ip, limit, keyPrefix){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, configured: false };

  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `${keyPrefix || 'nb'}:${ip}:${dateKey}`;

  const incrRes = await fetch(`${url}/incr/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const incrData = await incrRes.json();
  const count = incrData.result;

  if (count === 1) {
    await fetch(`${url}/expire/${key}/86400`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  return { allowed: count <= limit, configured: true };
}

export function getClientIp(req){
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
