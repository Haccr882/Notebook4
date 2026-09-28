# Notebook v3 — Free AI Study Notes, PDFs, Ebooks

Everything is **free** (premium/payments removed). Deploy on Vercel; optional Upstash for credits.

## What's new in v3
- **Notes**: Short (2–3 pages) / Full (4–6 pages) + **🎯 Exam-focused** toggle
- **📘 Ebook mode**: chapter-wise, big model only, **➕ Continue** (finish a failed chapter or add a chapter)
- **5 PDF styles**: Classic White, Topper Notes, Blue Academic, Dark Mode, Quick Revision (switchable after generation)
- **📣 Generate Promotion**: hook, problem, solution, CTA, reel script, caption, 10 hashtags (Mistral 8B), 5/day
- **Limits**: 3 credits/day (1 PDF = 1 credit, ebook = 2); credits carry over up to 6; sign-up bonus 2
- **Limit popup** with **Share = +1** and **Watch ad = +1** (Android app)
- **Auto retry**: failed sections are retried (chain of providers + repair rounds); a failed plan **refunds** its credit
- Pages: About, Privacy, Terms, Contact (`/pages/*.html`) — needed for AdSense/AdMob
- Android: see `SKETCHWARE-APK-GUIDE.md`

## Model routing
| Task | Model (Groq unless noted) |
|---|---|
| Notes, Doubt chat, Flashcards/Quiz | `qwen/qwen3.6-27b` (~30B class), fallbacks Mistral Small / OpenRouter / Gemini |
| Ebook | `openai/gpt-oss-120b`, fallbacks Llama 70B (OpenRouter), Mistral Medium, Gemini |
| Promotion | Mistral `ministral-8b-latest`, fallback Groq `gpt-oss-20b` |

**Why not 32B / 70B by name?** Groq shut down `qwen/qwen3-32b` (17 Jul 2026) and `llama-3.3-70b-versatile` + `llama-3.1-8b-instant` (16 Aug 2026). The old code still called them → errors. Replacements above; override with `GROQ_MODEL_NOTES`, `GROQ_MODEL_EBOOK`, `MISTRAL_MODEL_PROMO` if a provider renames a model again.

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
