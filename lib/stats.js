// backend/lib/stats.js
//
// LIVE COUNTER SYSTEM (homepage trust counters: Notes Generated, Ebooks
// Created, Quiz Solved, Active Users).
//
// STORAGE: Supabase's "stats" table (see docs/SUPABASE-SETUP.md for the
// exact SQL to create it) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// are configured. Falls back to Upstash (same shape, one JSON record)
// when Supabase isn't set up — nothing breaks either way. Every CALLER
// (api/generate.js, api/study-tools.js, api/auth.js, api/stats.js) stays
// exactly the same regardless of which backend is actually active.
import { supabaseConfigured, supabaseGetStats, supabaseSeedStats, supabaseBumpStat } from './supabase.js';

// SEED VALUES — set once, only if the record doesn't exist yet:
const SEED = { notes_count: 120, ebook_count: 40, quiz_count: 300, user_count: 80 };

const STATS_KEY = 'nb-stats';

async function upstashGet(url, token, key){
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.result;
}
async function upstashSet(url, token, key, value){
  await fetch(`${url}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: value });
}

/* Reads the stats record, seeding it with SEED (once, ever) if it doesn't
   exist yet. Tries Supabase first, Upstash as fallback. Returns null if
   NEITHER is configured. */
async function readStatsRecord(){
  if (supabaseConfigured()) {
    try {
      const row = await supabaseGetStats();
      if (row) return row;
      await supabaseSeedStats(SEED);
      return { ...SEED, updated_at: new Date().toISOString() };
    } catch (err) { /* fall through to Upstash below */ }
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const raw = await upstashGet(url, token, STATS_KEY);
    if (raw) return JSON.parse(raw);
    const seeded = { ...SEED, updated_at: new Date().toISOString() };
    await upstashSet(url, token, STATS_KEY, JSON.stringify(seeded));
    return seeded;
  } catch (err) {
    return null;
  }
}

// ---- In-memory read cache (30-60s per the spec's "reduce DB load" rule) ----
// Lives only for as long as one serverless instance stays warm — a cold
// start just re-reads once, which is cheap and fine. This is ONLY for
// READS (api/stats.js); bumpStat() below always writes straight through,
// so a real action is never lost or delayed because of this cache.
const CACHE_TTL_MS = 45000;
let _cache = null; // { data, fetchedAt }
async function readStatsCached(){
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.data;
  const record = await readStatsRecord();
  if (record) _cache = { data: record, fetchedAt: Date.now() };
  return record;
}

/* Bumps ONE counter by +1 — real increments only (per the spec's "DO NOT
   fake spikes" rule): call this exactly once per genuine notes/ebook/quiz
   generation or first-time signup, never speculatively, never on retries.
   field: 'notes_count' | 'ebook_count' | 'quiz_count' | 'user_count' */
export async function bumpStat(field){
  if (supabaseConfigured()) {
    try {
      await supabaseBumpStat(field); // atomic `+1` via the increment_stat() Postgres function — see docs/SUPABASE-SETUP.md
      // Keep the read-cache fresh so THIS instance reflects the bump
      // immediately, without an extra round-trip read.
      const current = _cache ? _cache.data : (await readStatsRecord()) || { ...SEED };
      const updated = { ...current, [field]: (current[field] || 0) + 1, updated_at: new Date().toISOString() };
      _cache = { data: updated, fetchedAt: Date.now() };
      return;
    } catch (err) { /* fall through to Upstash below */ }
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return; // best-effort — a missing DB should never break the actual feature that triggered this
  try {
    const record = (await readStatsRecord()) || { ...SEED };
    record[field] = (record[field] || 0) + 1;
    record.updated_at = new Date().toISOString();
    await upstashSet(url, token, STATS_KEY, JSON.stringify(record));
    _cache = { data: record, fetchedAt: Date.now() };
  } catch (err) { /* best-effort — never let a counter failure break the real feature */ }
}

/* Formats a raw count for display, per the spec's rules:
   <1000  → round down to nearest 10, "120+"
   >=1000 → "1.5K+" style, one decimal place */
export function formatCount(n){
  if (n >= 1000) return `${(Math.floor(n / 100) / 10).toFixed(1)}K+`;
  return `${Math.floor(n / 10) * 10}+`;
}

/* Reads all four counters (cached, see above). Returns both raw numbers
   and pre-formatted display strings so the frontend doesn't have to
   duplicate the formatting rule. Returns null if not configured. */
export async function getStats(){
  const record = await readStatsCached();
  if (!record) return null;
  const raw = {
    notes: record.notes_count || 0,
    ebooks: record.ebook_count || 0,
    quiz: record.quiz_count || 0,
    users: record.user_count || 0,
  };
  return {
    raw,
    formatted: {
      notes: formatCount(raw.notes),
      ebooks: formatCount(raw.ebooks),
      quiz: formatCount(raw.quiz),
      users: formatCount(raw.users),
    },
    updatedAt: record.updated_at,
  };
}
