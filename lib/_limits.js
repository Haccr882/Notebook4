// backend/api/_limits.js
//
// Shared Upstash-backed helpers: premium-token verification and per-day,
// per-IP rate limiting. Used by both api/generate.js (PDF/notes generation)
// and api/chat.js (doubt-solving chat) — each with its OWN counter key
// prefix, so a student's 5 PDFs/day and 20 chat messages/day are tracked
// completely independently of each other.

import { createHmac, timingSafeEqual } from 'node:crypto';

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

// ---- Credit system ----
//
// Replaces the old flat "N PDFs/day" counter with a small persistent
// credit balance per identity (signed-in email, or IP for anonymous
// use): DAILY_CREDIT_TOPUP credits are added once per calendar day
// (unused credits carry over, up to a cap, rather than being wiped at
// midnight), and a signed-in student additionally gets a ONE-TIME
// SIGNUP_BONUS_CREDITS bonus the very first time they ever sign in with
// Google (tracked so it can never be re-triggered by signing out and
// back in). 1 credit = 1 document generation (matches the existing
// "only the plan call counts, not every section" rule below).
export const DAILY_CREDIT_TOPUP = 3;
export const SIGNUP_BONUS_CREDITS = 10;
const CREDIT_STOCKPILE_CAP = 30; // generous ceiling so unused credits can bank up, without growing unbounded forever

async function upstashGet(url, token, key){
  const res = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.result;
}
async function upstashSet(url, token, key, value){
  await fetch(`${url}/set/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: value });
}

/* Reads the credit record, applies the day's top-up if it hasn't
   happened yet today, and returns { balance, configured }. Does NOT
   spend anything — call spendCredit for that. */
export async function getCreditBalance(identityKey){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { balance: Infinity, configured: false }; // no Upstash configured — never block anyone
  const today = new Date().toISOString().slice(0, 10);
  const key = `nb-credit:${identityKey}`;
  let record;
  try {
    const raw = await upstashGet(url, token, key);
    record = raw ? JSON.parse(raw) : { balance: 0, lastTopup: '' };
  } catch (err) {
    record = { balance: 0, lastTopup: '' };
  }
  if (record.lastTopup !== today) {
    record.balance = Math.min(record.balance + DAILY_CREDIT_TOPUP, CREDIT_STOCKPILE_CAP);
    record.lastTopup = today;
    try { await upstashSet(url, token, key, JSON.stringify(record)); } catch (err) { /* best-effort */ }
  }
  return { balance: record.balance, configured: true };
}

/* Spends exactly 1 credit if the identity has at least 1 available
   (applying the day's top-up first, same as getCreditBalance). Returns
   { allowed, balanceAfter, configured }. */
export async function spendCredit(identityKey){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, balanceAfter: Infinity, configured: false };
  const { balance } = await getCreditBalance(identityKey);
  if (balance < 1) return { allowed: false, balanceAfter: balance, configured: true };
  const today = new Date().toISOString().slice(0, 10);
  const key = `nb-credit:${identityKey}`;
  const newBalance = balance - 1;
  try { await upstashSet(url, token, key, JSON.stringify({ balance: newBalance, lastTopup: today })); } catch (err) { /* best-effort */ }
  return { allowed: true, balanceAfter: newBalance, configured: true };
}

/* Awards the one-time sign-up bonus the FIRST time this email ever signs
   in — a persistent flag (no expiry) stops it from ever firing twice for
   the same email, even across sign-out/sign-in or a wiped browser. Call
   this from api/auth.js right after a Google credential is verified. */
export async function awardSignupBonusIfFirstLogin(email){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !email) return false;
  const flagKey = `nb-firstlogin:${email}`;
  try {
    const already = await upstashGet(url, token, flagKey);
    if (already) return false;
    await upstashSet(url, token, flagKey, '1');
    const { balance } = await getCreditBalance(`g:${email}`);
    const today = new Date().toISOString().slice(0, 10);
    await upstashSet(url, token, `nb-credit:g:${email}`, JSON.stringify({ balance: balance + SIGNUP_BONUS_CREDITS, lastTopup: today }));
    return true;
  } catch (err) {
    return false; // best-effort — sign-in itself must never fail because of this
  }
}
