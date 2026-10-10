# Notebook4 — AI Notes, Ebooks & Quizzes

A free-to-use (for now), coin-metered AI study app for students: Notes/Paper, Ebook, Quiz, and a Doubt Chat — built as a step-by-step wizard (topic → options → cost → generate), not a chat-bubble interface. Deploy on Vercel; Upstash powers coins, daily free-use limits, and the live homepage counters.

## Product flow (per the Notebook4 spec)
- **Home**: 4 feature buttons (Notes/Paper, Ebook, Quiz, Doubt Chat), a coin balance + Google sign-in in the top bar, 4 live counters (Notes/Ebooks/Quizzes/Students), and a rotating "recent activity" ticker.
- **Notes/Ebook flow**: topic → options (**Quality**: Basic/Standard/Premium, **Pages**: 5/10/15, **Style**: Exam-focused/Detailed/Topper Notes, **Images**: Off/Pexels/AI — images are UI-ready but not wired yet, see Part 3 below) → cost preview → generate → result (styled document, PDF export, 5 switchable visual themes, Summarize, Generate Promotion, and ➕ Continue for ebooks).
- **Quiz flow**: topic + question count → cost preview → generate → interactive quiz.
- **Doubt Chat**: direct conversational view, separate from the wizard.

## Coins (see `PRICING`/`DAILY_FREE` in `lib/_limits.js`)
No daily top-up — only a small per-feature **daily free allowance**, then coins:

| Feature | Free/day | Coin price |
|---|---|---|
| Notes/Paper | 1×, **only at 5 pages** | 5 / 10 / 15 coins (by chosen page count) |
| Ebook | never free | 15 / 30 / 45 coins (5/10/15 pages) |
| Quiz | 1× | 3 coins |
| Doubt Chat | 5 messages | 1 coin/message |
| AI image | never free | 2 coins each (not wired yet — Part 3) |

Coins only come from the **Share bonus** (+1, max 2/day) right now — ads are intentionally **not wired in yet** (`api/reward.js`'s `kind:"ad"` returns a clear "not enabled yet" response on purpose). A failed plan/chat/quiz call refunds its coin(s). Coin balance caps at 200 (`COIN_STOCKPILE_CAP`).

## Model routing (see top of `lib/providers.js`)
| Step | Provider |
|---|---|
| Planning | Mistral |
| Fast generation | Groq — Llama 8B (`llama-3.1-8b-instant`) |
| Premium quality | Gemini |
| Backup | Qwen, on Groq (`qwen/qwen3.8-27b`, Preview) |
| Fallback | OpenRouter |
| Last fallback | HuggingFace |

The **Quality** option (Basic/Standard/Premium, chosen in Step 2) reorders the chain for section-writing: Basic skips Gemini entirely (cheapest/fastest); Premium tries Gemini first. Planning always uses the same Mistral-first chain regardless of Quality. If Groq's configured model 404s/is inaccessible, `callGroq()` auto-retries ONCE on `GROQ_MODEL_FALLBACK` (`openai/gpt-oss-20b`, confirmed Production-tier) in the same request — this is the fix for the "all providers failed" crash from a bad/retired model ID breaking the whole app.

## Live counters (see `lib/stats.js`, `api/stats.js`)
Homepage trust counters — Notes Generated, Ebooks Created, Quizzes Solved, Active Users — seeded at 120/40/300/80, bumped by +1 on each real event (never faked), formatted per spec (`123` → `120+`, `1540` → `1.5K+`), 45s read-cache. **Currently stored in Upstash** (not Supabase — no Supabase project/keys were available when this was built); swap `lib/stats.js`'s storage calls for Supabase ones whenever that's connected — every caller stays the same.

## Part 3 — Images, Supabase, Firebase
All built and tested against mocked versions of each service's documented API (I don't have your real accounts to test against live — see the per-service setup docs below for the exact checks to run once you deploy with real keys).

- **Images** (`lib/images.js`, `api/image.js`): Notes = Pexels only; Ebook = Pexels first, AI (Replicate → HuggingFace fallback) only when nothing relevant is found. AI images cost 2 coins each, charged only on an actual AI fallback, refunded if generation fails. Up to 5 images per document, spread evenly, 2 fetches in flight at once. Env: `PEXELS_API_KEY`, `REPLICATE_API_TOKEN`, `HUGGINGFACE_API_KEY` (any/all optional — `api/config.js` tells the frontend which are actually configured, and the Images option pills enable themselves accordingly).
- **Supabase** (`lib/supabase.js`): `stats` (live counters — now the PRIMARY store when configured, Upstash is the fallback), `generations` (one row per Notes/Ebook/Quiz), `usage_logs` (one row per coin-touching API call), `users` (mirror row on sign-in, for your own dashboards — Upstash stays the real coin-balance source of truth). **You must run the SQL in `docs/SUPABASE-SETUP.md` yourself** — this code only reads/writes rows, it can't create tables for you. Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Firebase** (wired directly in `index.html`): Analytics (feature_selected / generation_started / generation_completed / generation_failed / chat_message_sent / app_exception events) + Remote Config (one `maintenance_message` flag to start). "Crash reporting" from the spec is mobile-only on Firebase (Crashlytics) — the web equivalent here is a `window.onerror`/`unhandledrejection` catcher that logs to Supabase's `usage_logs` and, when configured, also fires a Firebase Analytics event. See `docs/FIREBASE-SETUP.md` for the 7 env vars (`FIREBASE_API_KEY` etc — these are meant to be public, unlike the Supabase/service-role keys above).

## What's still deferred
- **Ads** (AdMob rewarded/interstitial, the real 1 ad=+5 / 3 ads=+20 / 5 ads=+40 coin tiers) — intentionally deferred per your instruction; `api/reward.js` and the Sketchware guide are both written to make this a clean drop-in later.
- Flashcards — not one of the Notebook4 spec's 4 home buttons, so it isn't in the new UI; the backend (`api/study-tools.js`) still supports `kind:"flashcards"` at Quiz's price/free-allowance if you want to re-add a button for it.
- PDF upload to Supabase Storage (`generations.pdf_url` in the schema) — PDFs are currently generated entirely client-side (browser print, nothing uploaded anywhere); wiring server-side PDF generation + Storage upload is a separate, sizeable piece not yet built.

## Deploy
1. Push this folder's contents to a GitHub repo root → import in Vercel.
2. Env vars (see `.env.example`): at least `GROQ_API_KEY`; add `MISTRAL_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY` as fallbacks.
3. **Upstash** (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`) — needed for real coins/limits, and for live counters if Supabase isn't set up. Without it the app still runs, but limits are local-only (easy to bypass) and counters stay hidden.
4. Optional: `GOOGLE_CLIENT_ID` + `SESSION_SECRET` (sign-in), `SERPER_API_KEY`.
5. Optional (Part 3): `PEXELS_API_KEY`, `REPLICATE_API_TOKEN`, `HUGGINGFACE_API_KEY` (images) · `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (database — run `docs/SUPABASE-SETUP.md`'s SQL first) · `FIREBASE_API_KEY` + 6 more (see `docs/FIREBASE-SETUP.md`).
6. Redeploy after changing env vars.

## Files
`index.html` (whole app — Home/Wizard/Result/Chat) · `api/generate.js` (plan/section/judge) · `api/chat.js` · `api/study-tools.js` (quiz) · `api/image.js` (Pexels/AI images) · `api/promote.js` · `api/reward.js` · `api/credits.js` · `api/stats.js` · `api/auth.js` · `api/config.js` · `api/feedback.js` (+ client-error logging) · `lib/providers.js` (AI routing) · `lib/_limits.js` (coins/limits/sessions) · `lib/stats.js` (live counters) · `lib/images.js` (Pexels/Replicate/HuggingFace) · `lib/supabase.js` (REST client) · `pages/*.html` (About/Privacy/Terms/Contact) · `docs/*-SETUP.md` (Upstash/Supabase/Firebase setup)

Vercel Hobby allows 12 serverless functions; this project uses 11.

## Android (Sketchware Pro)
See `SKETCHWARE-APK-GUIDE.md` — WebView + AdMob banner/interstitial + native PDF "Save as PDF". The rewarded-ad step is deferred until ads are turned on (see above).
