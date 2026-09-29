# Notebook v3 — Free AI Study Notes, PDFs, Ebooks

Everything is **free** (premium/payments removed). Deploy on Vercel; optional Upstash for credits.

## What's new in v3
- **Notes**: Short (2–3 pages) / Full (4–6 pages) + **🎯 Exam-focused** toggle
- **📘 Ebook mode**: chapter-wise, big model only, **Short (~5 pages)** or **Full (~100 pages)** length option, **➕ Continue** (finish a failed chapter or add a chapter)
- **5 PDF styles**: Classic White, Topper Notes, Blue Academic, Dark Mode, Quick Revision (switchable after generation)
- **📣 Generate Promotion**: hook, problem, solution, CTA, reel script, caption, hashtags (Mistral 8B), 5/day — and the PLANNER itself now also writes a small topic-specific teaser (hook/caption/5 hashtags) for every document for free, which the promotion button builds on for consistency
- **Coins**: 5 free coins/day, shared across everything — 1 coin for doubt chat / flashcards / quiz, 10 coins for notes/paper/project (capped ~10 pages), 10 coins for a short ebook (~5 pages) or 15 for a full ebook (~100 pages). Coins carry over up to 30.
- **Limit popup** with **Share = +1** and **Watch ad = +1** (Android app)
- **Auto retry + 2-round review**: failed sections are retried; a judge agent reviews the finished document for up to 2 rounds and rewrites anything flagged
- **Concurrency-limited generation**: sections/chunks still generate in parallel, but throttled to at most 2 AI calls in flight at once (gentler on free-tier rate limits)
- A failed plan/chat/quiz call **refunds** its coin(s)
- Pages: About, Privacy, Terms, Contact (`/pages/*.html`) — needed for AdSense/AdMob
- Android: see `SKETCHWARE-APK-GUIDE.md`

## Model routing
| Task | Model (Groq unless noted) |
|---|---|
| Notes, Doubt chat, Flashcards/Quiz, Ebook | `qwen/qwen3.6-27b` — **TEMPORARY universal model**, see note below |
| Promotion | Mistral `ministral-8b-latest`, fallback Groq (same universal model) |

**Why one universal Groq model for now?** Per request, Groq uses ONE model everywhere until a proper per-task list is sent — change it in one place with the `GROQ_MODEL_UNIVERSAL` env var (see `.env.example`). Per-task overrides (`GROQ_MODEL_NOTES`/`_EBOOK`/`_PROMO`) still work if you want to split them again later.

**Why not the actual 32B model?** Groq shut down `qwen/qwen3-32b` — their real 32B model — on 17 Jul 2026; calling that ID now errors. There is no 32B model left on Groq's free tier, so `qwen/qwen3.6-27b` (confirmed live, Groq's own recommended replacement) is used as the closest stand-in. Groq's published free-plan sample limits for this model (checked 14 Sep 2026, console.groq.com/docs/rate-limits — your account's real number is on that console page): **30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day**, per API key. OpenRouter is the guaranteed last-resort fallback in every chain if Groq (or anything else) fails.

## Bugs fixed vs the old version
1. Retired Groq models (see above).
2. `renderQuota()` threw `ReferenceError: used is not defined` once credits loaded.
3. Credit balance was never loaded on page open (only after Google sign-in).
4. Ebook cost 5 credits **per chapter** but daily top-up was 3 → every ebook failed.
5. Credit was lost when all AI providers failed → now refunded.
6. Daily limit wasn't enforced when Upstash was missing (frontend now counts locally).
7. Display said 5/day in some places, 3 in others, 5 on server → unified to 3.
8. Redis keys with `@`/`+` (emails) weren't URL-encoded.
9. Reasoning models' `<think>…</think>` text could leak into notes → stripped.
10. `window.open` / `window.print` don't work in Android WebView → in-app PDF overlay + native print.

## Deploy
1. Upload this folder's contents to a GitHub repo root → import in Vercel.
2. Env vars (see `.env.example`): at least `GROQ_API_KEY`; add `MISTRAL_API_KEY` (promotion), `OPENROUTER_API_KEY`, `GEMINI_API_KEY` as fallbacks.
3. **Upstash** (`UPSTASH_REDIS_REST_URL/TOKEN`) is needed for real limits, credits, share/ad bonus, feedback (see `docs/UPSTASH-SETUP.md`). Without it the app runs but limits are only local (easy to bypass).
4. Optional: `GOOGLE_CLIENT_ID` + `SESSION_SECRET` (sign-in), `SERPER_API_KEY`.
5. Redeploy after changing env vars.

## Ads
- **Web (AdSense)**: needs custom domain, pages above, some content/traffic. Paste the ad code into `#adSlot` in `index.html` and set it to `display:block`.
- **App (AdMob)**: via Sketchware Pro — `SKETCHWARE-APK-GUIDE.md`. The web `#adSlot` is auto-hidden inside the app.

## Files
`index.html` (app) · `api/generate.js` (notes/ebook) · `api/chat.js` · `api/study-tools.js` · `api/promote.js` · `api/reward.js` · `api/credits.js` · `api/charge-plan-cost.js` · `api/auth.js` `sync.js` `config.js` `feedback.js` · `lib/providers.js` · `lib/_limits.js` · `pages/*.html`

Vercel Hobby allows 12 functions; this project uses 11 (helpers live in `lib/`, not `api/`).
