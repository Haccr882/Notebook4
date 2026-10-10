// backend/api/_limits.js
//
// Shared Upstash-backed helpers: premium-token verification and per-day,
// per-IP rate limiting. Used by both api/generate.js (PDF/notes generation)
// and api/chat.js (doubt-solving chat) — each with its OWN counter key
// prefix, so a student's 5 PDFs/day and 20 chat messages/day are tracked
// completely independently of each other.

import { createHmac, timingSafeEqual } from 'node:crypto';

/* keyPrefix lets callers keep separate counters — e.g. "nb" for PDF
   generations and "nb-chat" for doubt-chat messages — under the same
   Upstash database without them interfering with each other. */
export async function checkAndIncrementLimit(ip, limit, keyPrefix){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, configured: false };

  const dateKey = new Date().toISOString().slice(0, 10);
  const key = encodeURIComponent(`${keyPrefix || 'nb'}:${ip}:${dateKey}`);

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

  return { allowed: count <= limit, configured: true, count };
}

/* Read-only peek at the SAME counter checkAndIncrementLimit uses, WITHOUT
   incrementing it — for display purposes (e.g. "1 of 5 free chats used
   today") where actually consuming a use would be wrong. */
export async function peekDailyCount(ip, keyPrefix){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { count: 0, configured: false };
  const dateKey = new Date().toISOString().slice(0, 10);
  // BUG FIX: upstashGet() already encodeURIComponent()s whatever key it's
  // given (see its definition below) - encoding it here TOO meant every
  // peek request double-encoded the key (":" -> "%3A" -> "%253A"), so it
  // could never find the counter checkAndIncrementLimit had actually
  // written, and freeToday always reported the FULL daily allowance as
  // unused even after it had been spent. Pass the PLAIN key through.
  const key = `${keyPrefix || 'nb'}:${ip}:${dateKey}`;
  const count = await upstashGet(url, token, key);
  return { count: parseInt(count, 10) || 0, configured: true };
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

// ---- App session tokens ----
//
// THE FIX for "signs out every day": Google's ID token (the raw
// credential the Sign-In button hands back) is a short-lived
// authentication proof, NOT a session — it's only ever meant to be
// verified ONCE and then exchanged for the app's OWN session. This app
// used to skip that step and just keep re-sending the raw Google token
// as if it were a session, so the moment it expired (Google sets ~1hr),
// the frontend wiped the whole signed-in state and the person looked
// "signed out" — often well within the same day.
//
// Fix: after verifying the Google token ONCE (in api/auth.js), the
// server signs its OWN long-lived session token (HMAC-SHA256, using
// SESSION_SECRET — set this to any long random string in Vercel's
// environment variables, e.g. via `openssl rand -hex 32`). The frontend
// stores and sends THIS token everywhere instead of the raw Google
// credential. Verifying it is a fast local HMAC check — no Google API
// call, no ~1hr ceiling — and it's valid for SESSION_TTL_SECONDS (30
// days), so a person genuinely stays signed in across days/weeks, the
// way "stay signed in" is expected to behave.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function base64url(input){
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input){
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function signSession(user){
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null; // not configured — caller falls back to the old short-lived-token behaviour
  const payload = {
    email: user.email,
    name: user.name || '',
    picture: user.picture || '',
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(sessionToken){
  const secret = process.env.SESSION_SECRET;
  if (!secret || !sessionToken) return null;
  const parts = sessionToken.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const expectedSig = base64url(createHmac('sha256', secret).update(body).digest());
    // Constant-time compare — a plain === here would let an attacker
    // learn the correct signature one byte at a time via response timing.
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(base64urlDecode(body));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null; // expired — sign in again
    return { email: payload.email, name: payload.name, picture: payload.picture };
  } catch (err) {
    return null;
  }
}

/* Resolves WHO a request's daily limit should be tracked against: a
   verified session (preferred — see signSession/verifySession above) or
   a verified Google ID token for backward compatibility, or the IP
   address otherwise. Verifying on every quota-relevant call (rather than
   trusting a client-supplied email) is what stops someone from just
   claiming a different email to reset their limit — only a genuine,
   server-signed session or a genuine Google-signed token counts. */
export async function resolveIdentity(req, credentials){
  const { sessionToken, googleIdToken } = credentials || {};
  if (sessionToken) {
    const user = verifySession(sessionToken);
    if (user) return { key: `g:${user.email}`, user };
  }
  if (googleIdToken && process.env.GOOGLE_CLIENT_ID) {
    const user = await verifyGoogleIdToken(googleIdToken, process.env.GOOGLE_CLIENT_ID);
    if (user) return { key: `g:${user.email}`, user };
  }
  return { key: `ip:${getClientIp(req)}`, user: null };
}

// ---- Coin system (Notebook4 spec) ----
//
// Two SEPARATE things, per identity (signed-in email, or IP if anonymous):
//   1. A small per-FEATURE daily FREE allowance (DAILY_FREE below) — resets
//      at midnight, tracked with the same checkAndIncrementLimit() counter
//      mechanism used elsewhere in this file, one counter per feature.
//   2. A persistent COIN balance (PRICING below) for anything beyond that
//      free allowance, or for a feature with no free allowance at all
//      (Ebook, AI images always cost coins — there is no daily coin top-up
//      anymore). Coins never expire/reset; they only come from the bonuses
//      at the bottom of this section (ads aren't wired in yet — see
//      awardBonusCoins — so until then "share" is the only way to earn any).
//
// DAILY FREE (no coins spent):
//   Notes  → 1 per day, ONLY at the 5-page size
//   Chat   → 5 messages per day
//   Quiz   → 1 per day
//   Ebook, AI images → none, ever (always cost coins)
//
// COIN PRICING (charged once the free allowance above is used up, or for
// a feature/size that was never free):
//   Notes:  5 pages=5, 10 pages=10, 15 pages=15 coins
//   Ebook:  5 pages=15, 10 pages=30, 15 pages=45 coins
//   Quiz:   3 coins (flat, per generation, once the 1 free/day is used)
//   Chat:   1 coin (flat, per message, once the 5 free/day are used)
//   AI image: 2 coins each (Pexels images are always free, not from coins)
export const PRICING = {
  notes: { 5: 5, 10: 10, 15: 15 },
  ebook: { 5: 15, 10: 30, 15: 45 },
  quiz: 3,
  chat: 1,
  aiImage: 2,
};
export const DAILY_FREE = {
  notes: { count: 1, pages: 5 },
  chat: 5,
  quiz: 1,
};
const COIN_STOCKPILE_CAP = 200; // coins only grow via bonuses right now (no daily top-up) - generous ceiling, not a meaningful limiter yet

// Interim earn method while ads aren't live (see "abhi ads wala mat lagana"
// — this whole section gets replaced by the real ad-tier rewards (1 ad=+5,
// 3 ads=+20, 5 ads=+40 coins) once ads are switched on).
const SHARE_REWARD_COINS = 1;
const SHARE_REWARD_MAX_PER_DAY = 2;

async function upstashGet(url, token, key){
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.result;
}
async function upstashSet(url, token, key, value){
  await fetch(`${url}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: value });
}

async function readRecord(url, token, identityKey){
  const key = `nb-coins:${identityKey}`;
  try {
    const raw = await upstashGet(url, token, key);
    return raw ? JSON.parse(raw) : { balance: 0 };
  } catch (err) {
    return { balance: 0 };
  }
}
async function writeRecord(url, token, identityKey, record){
  try { await upstashSet(url, token, `nb-coins:${identityKey}`, JSON.stringify(record)); } catch (err) { /* best-effort */ }
}

/* Reads the identity's persistent coin balance. There is no daily top-up
   anymore (see the big comment above) - this just reads what's there. */
export async function getCoinBalance(identityKey){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { balance: Infinity, configured: false }; // no Upstash configured — never block anyone
  const record = await readRecord(url, token, identityKey);
  return { balance: record.balance || 0, configured: true };
}

/* Spends `cost` coins if the identity has enough. Returns
   { allowed, balanceAfter, configured }. */
export async function spendCoins(identityKey, cost = 1){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, balanceAfter: Infinity, configured: false };
  const { balance } = await getCoinBalance(identityKey);
  if (balance < cost) return { allowed: false, balanceAfter: balance, configured: true };
  const newBalance = balance - cost;
  await writeRecord(url, token, identityKey, { balance: newBalance });
  return { allowed: true, balanceAfter: newBalance, configured: true };
}

/* Gives coins back - used when a generation FAILED before producing
   anything (all AI providers down), so a student never loses coins for
   nothing. */
export async function refundCoins(identityKey, amount = 1){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    const { balance } = await getCoinBalance(identityKey);
    await writeRecord(url, token, identityKey, { balance: Math.min(balance + amount, COIN_STOCKPILE_CAP) });
  } catch (err) { /* best-effort */ }
}

/* THE central gate for every coin-or-free-charged feature.
   feature: 'notes' | 'ebook' | 'quiz' | 'chat'
   opts.pages: the page size chosen, for notes/ebook (5/10/15)
   Tries the daily FREE allowance for that exact feature/size first (see
   DAILY_FREE above); if that's used up (or the feature/size has none —
   ebook always, notes at 10/15 pages), falls through to spending coins at
   the PRICING rate. Returns:
   { allowed, usedFree, coinsCharged, balanceAfter, configured, reason } */
export async function chargeForFeature(identityKey, feature, opts = {}){
  const configured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!configured) return { allowed: true, usedFree: true, coinsCharged: 0, balanceAfter: Infinity, configured: false };

  let freeEligible = false;
  if (feature === 'notes' && opts.pages === DAILY_FREE.notes.pages) {
    freeEligible = (await checkAndIncrementLimit(identityKey, DAILY_FREE.notes.count, 'nb-free-notes')).allowed;
  } else if (feature === 'quiz') {
    freeEligible = (await checkAndIncrementLimit(identityKey, DAILY_FREE.quiz, 'nb-free-quiz')).allowed;
  } else if (feature === 'chat') {
    freeEligible = (await checkAndIncrementLimit(identityKey, DAILY_FREE.chat, 'nb-free-chat')).allowed;
  }
  // (ebook and aiImage have no DAILY_FREE entry — freeEligible stays false, straight to coins)

  if (freeEligible) {
    return { allowed: true, usedFree: true, coinsCharged: 0, balanceAfter: null, configured: true };
  }

  const cost = priceForFeature(feature, opts);
  const spend = await spendCoins(identityKey, cost);
  return {
    allowed: spend.allowed, usedFree: false, coinsCharged: cost, balanceAfter: spend.balanceAfter, configured: true,
    reason: spend.allowed ? undefined : `Needs ${cost} coins \u2014 you have ${spend.balanceAfter}.`,
  };
}

export function priceForFeature(feature, opts = {}){
  if (feature === 'notes') return PRICING.notes[opts.pages] ?? PRICING.notes[5];
  if (feature === 'ebook') return PRICING.ebook[opts.pages] ?? PRICING.ebook[10];
  if (feature === 'quiz') return PRICING.quiz;
  if (feature === 'chat') return PRICING.chat;
  if (feature === 'aiImage') return PRICING.aiImage;
  return 0;
}

/* Bonus coins — interim earn method while ads aren't live yet (kind is
   always 'share' for now; see the comment on SHARE_REWARD_COINS above). */
export async function awardBonusCoins(identityKey, kind){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: false, coinsAwarded: 0, reason: 'Coins are not configured on this server.' };
  const cfg = { coins: SHARE_REWARD_COINS, max: SHARE_REWARD_MAX_PER_DAY, label: 'share' };
  const limitResult = await checkAndIncrementLimit(identityKey, cfg.max, `nb-bonus-${cfg.label}`);
  if (!limitResult.allowed) return { allowed: false, coinsAwarded: 0, reason: `Daily ${cfg.label}-bonus limit reached (${cfg.max}/day).` };
  const { balance } = await getCoinBalance(identityKey);
  const newBalance = Math.min(balance + cfg.coins, COIN_STOCKPILE_CAP);
  await writeRecord(url, token, identityKey, { balance: newBalance });
  return { allowed: true, coinsAwarded: cfg.coins, balanceAfter: newBalance };
}

/* One-time sign-up bonus — 2 coins, fires exactly once per email ever. */
export const SIGNUP_BONUS_COINS = 2;
export async function awardSignupBonusIfFirstLogin(email){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !email) return false;
  const flagKey = `nb-firstlogin:${email}`; // encoded by upstashGet/Set
  try {
    const already = await upstashGet(url, token, flagKey);
    if (already) return false;
    await upstashSet(url, token, flagKey, '1');
    const { balance } = await getCoinBalance(`g:${email}`);
    await writeRecord(url, token, `g:${email}`, { balance: Math.min(balance + SIGNUP_BONUS_COINS, COIN_STOCKPILE_CAP) });
    return true;
  } catch (err) {
    return false; // best-effort — sign-in itself must never fail because of this
  }
}
