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

// ---- Google Sign-In (identity only — no client secret needed) ----
//
// This verifies a Google ID token (the JWT the "Sign in with Google"
// button on the frontend produces) by asking Google's own tokeninfo
// endpoint whether it's genuine. This is enough to know WHO the person is
// (their verified email) — it does NOT grant access to their Gmail,
// Drive, or anything else, so the client secret is never used or needed
// here. The client secret is only relevant for a full OAuth
// code-exchange flow (acting on a user's behalf against Google APIs),
// which this app doesn't do.
export async function verifyGoogleIdToken(idToken, expectedAudience){
  if (!idToken || !expectedAudience) return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.aud !== expectedAudience) return null; // token wasn't issued for THIS app
    if (!data.email || data.email_verified !== 'true') return null;
    return { email: data.email, name: data.name || '', picture: data.picture || '' };
  } catch (err) {
    return null; // any verification failure just means "not signed in", never a hard error
  }
}

/* Resolves WHO a request's daily limit should be tracked against: a
   verified Google account if the frontend sent a valid ID token, or the
   IP address otherwise. Verifying on every quota-relevant call (rather
   than trusting a client-supplied email) is what stops someone from just
   claiming a different email to reset their limit — only a genuine,
   Google-signed token for THIS app's client ID counts. */
export async function resolveIdentity(req, googleIdToken){
  if (googleIdToken && process.env.GOOGLE_CLIENT_ID) {
    const user = await verifyGoogleIdToken(googleIdToken, process.env.GOOGLE_CLIENT_ID);
    if (user) return { key: `g:${user.email}`, user };
  }
  return { key: `ip:${getClientIp(req)}`, user: null };
}
