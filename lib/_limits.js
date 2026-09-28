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

// ---- Credit system (backend ready, everything FREE for now) ----
//
// Every identity (signed-in email, or IP for anonymous use) has a record:
// { balance, lastTopup, plan }. There is ONE plan ("free") - premium was
// removed. Credits still exist in the backend so a paid/ads model can be
// switched on later without a rewrite.
//
// LIMIT SYSTEM: 3 credits/day (= 3 PDFs/day). 1 credit = 1 notes/paper/
// project. An ebook costs 2 credits. Extra credits can be earned by
// sharing (+1) or watching a rewarded ad in the app (+1).
export const PLANS = {
  free: { label: 'Free', dailyTopup: 3, priceINR: 0, oneTimeCredits: 0, tier: 'notes' },
};
export const DAILY_FREE_CREDITS = 3;
const CREDIT_STOCKPILE_CAP = 6; // unused credits carry over, but only up to 2 days' worth - stops hoarding/abuse

const AD_REWARD_CREDITS = 1;
const AD_REWARD_MAX_PER_DAY = 3;
const SHARE_REWARD_CREDITS = 1;
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
  const key = `nb-credit:${identityKey}`;
  try {
    const raw = await upstashGet(url, token, key);
    return raw ? JSON.parse(raw) : { balance: 0, lastTopup: '', plan: 'free' };
  } catch (err) {
    return { balance: 0, lastTopup: '', plan: 'free' };
  }
}
async function writeRecord(url, token, identityKey, record){
  try { await upstashSet(url, token, `nb-credit:${identityKey}`, JSON.stringify(record)); } catch (err) { /* best-effort */ }
}

/* Reads the credit record, applies the day's top-up (based on the
   identity's CURRENT plan) if it hasn't happened yet today, and returns
   { balance, plan, configured }. Does NOT spend anything. */
export async function getCreditBalance(identityKey){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { balance: Infinity, plan: 'free', configured: false }; // no Upstash configured — never block anyone
  const today = new Date().toISOString().slice(0, 10);
  let record = await readRecord(url, token, identityKey);
  if (!record.plan || !PLANS[record.plan]) record.plan = 'free';
  if (record.lastTopup !== today) {
    const topup = PLANS[record.plan].dailyTopup;
    record.balance = Math.min(record.balance + topup, CREDIT_STOCKPILE_CAP);
    record.lastTopup = today;
    await writeRecord(url, token, identityKey, record);
  }
  return { balance: record.balance, plan: record.plan, configured: true };
}

/* Spends `cost` credits (default 1) if the identity has enough available
   (applying the day's top-up first, same as getCreditBalance). Returns
   { allowed, balanceAfter, plan, configured }. Used with cost=1 for the
   initial "plan" call (a flat gate against spam), and again with a
   larger cost once the document's real size is known — see
   api/charge-plan-cost.js and the CREDIT COST table there. */
export async function spendCredit(identityKey, cost = 1){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, balanceAfter: Infinity, plan: 'free', configured: false };
  const { balance, plan } = await getCreditBalance(identityKey);
  if (balance < cost) return { allowed: false, balanceAfter: balance, plan, configured: true };
  const today = new Date().toISOString().slice(0, 10);
  const newBalance = balance - cost;
  await writeRecord(url, token, identityKey, { balance: newBalance, lastTopup: today, plan });
  return { allowed: true, balanceAfter: newBalance, plan, configured: true };
}

/* Gives a credit back - used when a generation FAILED before producing
   anything (all AI providers down), so a student never loses a credit for
   nothing. */
export async function refundCredit(identityKey, amount = 1){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    const { balance, plan } = await getCreditBalance(identityKey);
    const today = new Date().toISOString().slice(0, 10);
    await writeRecord(url, token, identityKey, { balance: Math.min(balance + amount, CREDIT_STOCKPILE_CAP), lastTopup: today, plan });
  } catch (err) { /* best-effort */ }
}

/* Bonus credits: kind = 'ad' (rewarded ad watched in the app) or 'share'
   (student shared the site). Each kind has its own small per-day cap. */
export async function awardBonusCredit(identityKey, kind){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: false, creditsAwarded: 0, reason: 'Credits are not configured on this server.' };
  const cfg = kind === 'share'
    ? { credits: SHARE_REWARD_CREDITS, max: SHARE_REWARD_MAX_PER_DAY, label: 'share' }
    : { credits: AD_REWARD_CREDITS, max: AD_REWARD_MAX_PER_DAY, label: 'ad' };
  const today = new Date().toISOString().slice(0, 10);
  const countKey = encodeURIComponent(`nb-bonus-${cfg.label}:${identityKey}:${today}`);
  const countResult = await fetch(`${url}/incr/${countKey}`, { headers: { Authorization: `Bearer ${token}` } });
  const count = (await countResult.json()).result;
  if (count === 1) await fetch(`${url}/expire/${countKey}/86400`, { headers: { Authorization: `Bearer ${token}` } });
  if (count > cfg.max) return { allowed: false, creditsAwarded: 0, reason: `Daily ${cfg.label}-bonus limit reached (${cfg.max}/day).` };
  const { balance, plan } = await getCreditBalance(identityKey);
  const newBalance = Math.min(balance + cfg.credits, CREDIT_STOCKPILE_CAP);
  await writeRecord(url, token, identityKey, { balance: newBalance, lastTopup: today, plan });
  return { allowed: true, creditsAwarded: cfg.credits, balanceAfter: newBalance };
}

/* One-time sign-up bonus, unchanged in mechanism from before — 2
   credits, still fires exactly once per email ever, regardless of plan. */
export const SIGNUP_BONUS_CREDITS = 2;
export async function awardSignupBonusIfFirstLogin(email){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !email) return false;
  const flagKey = `nb-firstlogin:${email}`; // encoded by upstashGet/Set
  try {
    const already = await upstashGet(url, token, flagKey);
    if (already) return false;
    await upstashSet(url, token, flagKey, '1');
    const { balance, plan } = await getCreditBalance(`g:${email}`);
    const today = new Date().toISOString().slice(0, 10);
    await writeRecord(url, token, `g:${email}`, { balance: Math.min(balance + SIGNUP_BONUS_CREDITS, CREDIT_STOCKPILE_CAP), lastTopup: today, plan });
    return true;
  } catch (err) {
    return false; // best-effort — sign-in itself must never fail because of this
  }
}
