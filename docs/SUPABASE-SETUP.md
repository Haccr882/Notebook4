# Supabase setup — Notebook4

Run this ONCE in your Supabase project → **SQL Editor** → New query → paste → Run. This creates the three tables from the spec plus one small function the app needs for safe (concurrency-proof) counter increments.

```sql
-- ============================================================
-- stats — the 4 homepage live counters (one row, id=1)
-- ============================================================
create table if not exists stats (
  id integer primary key default 1,
  notes_count integer not null default 0,
  ebook_count integer not null default 0,
  quiz_count integer not null default 0,
  user_count integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into stats (id, notes_count, ebook_count, quiz_count, user_count)
values (1, 120, 40, 300, 80)
on conflict (id) do nothing;

-- Atomic "+1 to one column" — a plain UPDATE from the app can't safely do
-- `set x = x + 1` under concurrent requests without this.
create or replace function increment_stat(field_name text)
returns void as $$
begin
  if field_name not in ('notes_count','ebook_count','quiz_count','user_count') then
    raise exception 'invalid field_name: %', field_name;
  end if;
  execute format('update stats set %I = %I + 1, updated_at = now() where id = 1', field_name, field_name);
end;
$$ language plpgsql security definer;

-- ============================================================
-- generations — one row per successful Notes/Ebook/Quiz
-- ============================================================
create table if not exists generations (
  id bigint generated always as identity primary key,
  user_id text,                 -- the signed-in email, or null for anonymous
  type text not null,           -- 'notes' | 'specimen' | 'project' | 'ebook' | 'quiz'
  topic text,
  pages integer,
  pdf_url text,                 -- filled in later if/when you wire up Supabase Storage for PDFs
  created_at timestamptz not null default now()
);

-- ============================================================
-- usage_logs — one row per API call that touched coins/limits
-- ============================================================
create table if not exists usage_logs (
  id bigint generated always as identity primary key,
  user_id text,
  api_used text not null,       -- 'generate' | 'chat' | 'study-tools' | 'image' | ...
  coins_used integer not null default 0,
  status text not null default 'ok',  -- 'ok' | 'free' | 'refunded' | 'error'
  created_at timestamptz not null default now()
);

-- ============================================================
-- users — mirror of coin balance for your own SQL dashboards
-- (Upstash stays the real source of truth for spending/refunding -
-- see lib/_limits.js. This table is written to on sign-in, not read
-- back by the app, so if it ever drifts it doesn't affect anyone's
-- actual balance.)
-- ============================================================
create table if not exists users (
  id bigint generated always as identity primary key,
  email text unique not null,
  coins integer,
  streak integer default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security — the app writes with the SERVICE ROLE key
-- (bypasses RLS entirely), so these policies only matter if you also
-- want to read this data from the Supabase dashboard's "anon" API
-- browser or a future admin UI using the anon/public key. Safe defaults:
-- nobody can read/write via the anon key; only the service role (server)
-- can touch these tables.
-- ============================================================
alter table stats enable row level security;
alter table generations enable row level security;
alter table usage_logs enable row level security;
alter table users enable row level security;
-- (no policies added = anon key gets zero access by default, which is what we want)
```

## Vercel env vars

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Project Settings → API → "Project URL" |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → "service_role" key (⚠️ **secret** — never put this in frontend code or a public repo; it bypasses Row Level Security on purpose, which is exactly why only the server uses it) |

Add both in Vercel → your project → Settings → Environment Variables, then redeploy.

## What happens without Supabase configured

Nothing breaks. `lib/stats.js` (the live homepage counters) automatically falls back to Upstash, exactly as it did before Supabase was wired in — Supabase is additive, not a hard requirement. `generations`/`usage_logs` logging simply becomes a silent no-op until these env vars are set.

## Checking it worked

After deploying with both env vars set, generate one set of Notes on the live site, then in Supabase → Table Editor:
- `stats.notes_count` should have gone up by 1
- `generations` should have one new row (`type = 'notes'`)
- `usage_logs` should have at least one new row for `api_used = 'generate'`
