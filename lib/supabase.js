// backend/lib/supabase.js
//
// Thin REST client for Supabase (PostgREST under the hood — no SDK
// dependency needed, same philosophy as lib/_limits.js's Upstash calls).
// Every function here is env-var gated and fails SOFT (returns null /
// false, never throws) — a Supabase hiccup must never break the actual
// feature that triggered it (generating notes, answering a quiz, etc).
//
// REQUIRED SETUP (you must create these yourself — this file only reads/
// writes rows, it can't create tables): see docs/SUPABASE-SETUP.md for the
// exact SQL to run in your Supabase project's SQL Editor (tables: stats,
// generations, usage_logs; plus one Postgres function for atomic counter
// increments).
//
// Env vars: SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY (server-side only —
// NEVER the anon/public key here, since these calls bypass RLS on purpose
// to write usage logs for any visitor, signed in or not).

function supabaseConfigured(){
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function headers(){
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

/* Low-level REST call against {SUPABASE_URL}/rest/v1/{path}. Returns the
   parsed JSON body, or null on any failure (bad table, network error, RLS
   rejection, etc) — callers treat null exactly like "not configured". */
async function restCall(path, opts = {}){
  if (!supabaseConfigured()) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: { ...headers(), ...(opts.headers || {}) },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  } catch (err) {
    return null;
  }
}

export { supabaseConfigured };

/* ---- stats table (notes_count/ebook_count/quiz_count/user_count) ---- */
export async function supabaseGetStats(){
  const rows = await restCall('stats?id=eq.1&select=*', { headers: { Prefer: 'return=representation' } });
  return rows && rows[0] ? rows[0] : null;
}
export async function supabaseSeedStats(seed){
  // "upsert" via POST + Prefer: resolution=ignore-duplicates — only inserts
  // if id=1 doesn't already exist; a second call is always a safe no-op.
  await restCall('stats', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ id: 1, ...seed, updated_at: new Date().toISOString() }),
  });
}
/* Atomic +1 via the increment_stat(field_name) Postgres function (see
   docs/SUPABASE-SETUP.md) — a plain PATCH can't do "set x = x + 1" safely
   under concurrent requests, which is exactly why this is an RPC call
   instead. field: 'notes_count' | 'ebook_count' | 'quiz_count' | 'user_count' */
export async function supabaseBumpStat(field){
  await restCall('rpc/increment_stat', {
    method: 'POST',
    body: JSON.stringify({ field_name: field }),
  });
}

/* ---- generations table (one row per successful Notes/Ebook/Quiz) ---- */
export async function supabaseLogGeneration({ userId, type, topic, pages }){
  if (!supabaseConfigured()) return;
  await restCall('generations', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId || null, type, topic: String(topic || '').slice(0, 300),
      pages: pages || null, created_at: new Date().toISOString(),
    }),
  });
}

/* ---- usage_logs table (one row per API call that touches coins/limits) ---- */
export async function supabaseLogUsage({ userId, apiUsed, coinsUsed, status }){
  if (!supabaseConfigured()) return;
  await restCall('usage_logs', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId || null, api_used: apiUsed, coins_used: coinsUsed || 0,
      status: status || 'ok', created_at: new Date().toISOString(),
    }),
  });
}

/* ---- users table (upsert on sign-in: id, email, coins, streak) ----
   Mirrors the coin balance that actually lives in Upstash (lib/_limits.js
   is still the source of truth for spending/refunding) — this copy is for
   your own SQL analytics/dashboards, not read back by the app. */
export async function supabaseUpsertUser({ email, coins }){
  if (!supabaseConfigured() || !email) return;
  await restCall('users', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' }, // upsert on the email unique constraint
    body: JSON.stringify({ email, coins: typeof coins === 'number' ? coins : undefined }),
  });
}
