# Notebook — AI Study Notes, Specimen Papers & Doubt Chat

## What's inside

```
notebook/
├── index.html                ← the website (Notes/Paper + Doubt Chat modes, PDF, help/feedback)
├── vercel.json                ← server timeout config (60s, Vercel's max on free plan)
├── api/
│   ├── providers.js              ← ONE shared module that calls every AI provider + fallback chain
│   ├── _limits.js                 ← shared rate-limit / premium-token helpers (not a route)
│   ├── generate.js                ← multi-agent notes/paper backend (plan → parallel sections)
│   ├── chat.js                     ← doubt-solving chat backend (separate from generate.js)
│   ├── redeem.js                    ← premium code redemption
│   └── feedback.js                   ← stores user feedback (readable via admin secret)
├── pages/
│   └── premium.html                ← premium redeem page
└── docs/
    └── UPSTASH-SETUP.md              ← real per-IP rate limiting setup
```

## Two separate modes

The app now has a mode switch at the top of the chat:

- **📝 Notes/Paper** — the original multi-agent pipeline: plans a document
  structure, then writes every section in parallel, then assembles &
  verifies it, ready to download as a PDF.
- **💬 Doubt Chat** — a plain, stateful conversation for quick questions.
  It NEVER touches the plan/section/PDF pipeline, so a doubt never
  accidentally turns into a document. Separate daily quota, separate
  backend endpoint (`api/chat.js`).

## Multi-provider AI with automatic fallback

`api/providers.js` is the one place that knows how to call every AI
provider. Both `generate.js` and `chat.js` hand it a **chain** of
provider names and it tries them in order until one succeeds — a provider
whose API key isn't set is skipped (not treated as a failure), so the app
works fine even with only 1-2 keys configured.

| Provider | Env var | Model (default, overridable) | Notes |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/free` | Primary, free tier |
| Grok (xAI) | `XAI_API_KEY` | `grok-2-latest` | Used for both notes/paper generation and chat |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` | Very fast; **Groq deprecated `llama-3.3-70b-versatile` on 16 Aug 2026** — this 120B model is their official replacement, and has its own daily call cap (see below) to protect the shared key |
| Gemini | `GEMINI_API_KEY` | `gemini-2.0-flash` | Stable backup; different request shape, handled internally |
| NVIDIA | `NVIDIA_API_KEY` | `nvidia/nemotron-3-ultra-550b-a55b` | Last-resort fallback |
| OpenRouter (fallback model) | (same key) | `meta-llama/llama-3.3-70b-instruct:free` | Final safety net for notes/paper generation |

Chains used:
- **Notes/Paper** (plan + each section): OpenRouter → Grok → Groq → Gemini → NVIDIA → OpenRouter-fallback.
- **Doubt Chat**: Grok → Groq → Gemini → OpenRouter.

All providers share ONE total time budget per request (`TOTAL_CHAIN_BUDGET_MS`
in `providers.js`) so trying several of them can never blow past Vercel's
60-second function limit.

### Groq gpt-oss-120b daily call cap

Because it's a bigger/pricier model with a tighter free-tier quota, calls to
it are also checked against a shared, app-wide daily counter
(`GROQ_120B_DAILY_LIMIT`, default 1000) — separate from any per-student
limit. If the app-wide cap is hit, that one call just falls through to the
next provider in the chain; it doesn't fail the request.

## How the notes/paper/project generation works (multi-agent)

1. **Plan agent** — one fast call decides the document's structure: how
   many sections it genuinely needs for the topic (no fixed page count —
   a narrow topic gets fewer, short sections; a broad one gets more), and
   for specimen papers, the exact mark scheme based on real CBSE/ICSE
   board patterns. Notes sections are limited to Overview, Key Concepts,
   Important Definitions, Formulas/Laws, Worked Examples, and Quick
   Revision Summary — no "Common Mistakes"/"Exam Tips" filler sections.
   A **school project** request gets a fixed skeleton — Certificate,
   Acknowledgement, Index, Introduction, 3-6 AI-chosen main-body sections
   on the actual subject, Conclusion, Bibliography.
2. **Section agents** — every section is written in **parallel**, not one
   after another. A section with a large number of questions (a big MCQ
   block, or a full answer key) is further split into small chunks of 5
   questions each, generated and verified independently — this is what
   fixes a whole section (or its answer key) coming back completely empty:
   one oversized call asking for 15+ full questions in one JSON blob had a
   real chance of getting cut off mid-string and becoming permanently
   unparseable; several small calls of 5 each almost never do, and a
   single failed chunk now only costs 5 questions instead of the whole
   section.
3. **Verification & retry** — each chunk/section is checked for actually
   containing every question it was assigned (specimen papers) or having
   real, complete content with no placeholder phrasing (notes/project).
   Up to 3 attempts per chunk, each running the FULL provider chain above,
   plus up to 2 document-level repair rounds afterward for anything still
   flagged.
4. **Judge agent** (new) — after the repair rounds, a separate AI call
   re-reads the WHOLE assembled document against the original topic and
   flags anything the mechanical checks above can't see: content that
   drifted off-topic, a section that trails off without truly finishing,
   a stray placeholder, or something inconsistent with the mark scheme.
   Flagged sections are rewritten with the judge's specific complaint as
   feedback, then the judge reviews again — up to `MAX_JUDGE_ROUNDS` (2)
   times, so it can't loop forever if a model is never satisfied.
5. **Final sweep** (new) — a genuine "keep trying until nothing is left
   blank" guarantee. Everything above runs sections concurrently, which is
   fast, but a burst of many simultaneous requests can also be exactly
   what causes several sections IN A ROW to fail together (they all land
   in the same free-tier rate-limit window at once, so even the retries
   keep colliding with each other). Section launches are now staggered by
   ~350ms each, and retries back off progressively instead of firing
   immediately — but if anything is STILL empty after all of that, this
   final pass regenerates each remaining broken section ONE AT A TIME
   (never in a burst) with several more dedicated attempts, so a genuinely
   broken section gets a clean shot at a provider that isn't being hit by
   five other requests at the same instant.
6. **Assembly** — numbering is assigned by the code, never trusted from
   the AI, eliminating numbering bugs entirely.

## School project generator

Ask for "a project on <topic>" / "school project report for <subject>" and
the plan agent switches to `type: "project"` instead of notes/specimen. The
resulting PDF always has, in order: a **Certificate** (with real blank
underscore lines for name/class/teacher, like a physical certificate),
**Acknowledgement**, **Index** (table of contents), **Introduction**, the
actual **main-body content** on the topic (AI-chosen sub-sections, written
as a proper researched report rather than exam-revision bullet points),
**Conclusion**, and a **Bibliography** (generic real source types —
NCERT/board textbook, Wikipedia, Byju's/Vedantu — never fabricated book
titles or ISBNs). The Certificate page renders with its own decorative
double-border, centred layout in the PDF instead of looking like a numbered
notes entry.

## Diagrams

Diagram instructions were strengthened: bigger canvas (500×320), arrowheads
drawn as small filled triangles (the allowed SVG tag set has no `<marker>`),
2-3 distinct colours to separate different parts of a diagram, and an
explicit instruction to fully label every part and use the whole canvas
rather than a token sketch.

## Topper-notes-style PDF formatting

Every section gets its own colour from a 7-colour palette (matched by
heading keyword first — Formulas is always purple, Worked Examples always
teal — falling back to cycling by position), a numbered badge in that
colour, and anchor sections (Overview, Quick Revision Summary) get a
bigger heading plus a soft highlighted box. Formula-looking lines get a
coloured box matching their section. A gradient strip across the top
samples every colour actually used in the document. The exact same markup
is used for the on-screen bubble and the downloaded PDF (via the browser's
native print-to-PDF), so what the student sees is exactly what they get.

## Deploy steps

1. **GitHub**: create a repo, upload this entire `notebook/` folder's
   contents to the repo ROOT (not inside a subfolder).
2. **Vercel**: New Project → connect the repo → Deploy.
3. **Environment variables** (Vercel → Settings → Environment Variables):
   - `OPENROUTER_API_KEY` — from openrouter.ai/keys
   - `XAI_API_KEY` — from console.x.ai (Grok)
   - `GROQ_API_KEY` — from console.groq.com
   - `GEMINI_API_KEY` — from aistudio.google.com/apikey
   - `NVIDIA_API_KEY` — from build.nvidia.com (optional but recommended)
   - `GOOGLE_CLIENT_ID` — optional; from Google Cloud Console → Credentials,
     enables the "Sign in with Google" button. Do NOT set a Client Secret
     anywhere — it isn't used.
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — optional, for
     real per-IP daily limits (see docs/UPSTASH-SETUP.md) and the Groq
     120B daily cap; without these, limits still "work" but are easier to
     bypass and the 120B cap is skipped entirely
   - `ADMIN_SECRET` — only needed for redeem.js/feedback.js's admin actions
   - Optional overrides: `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`,
     `GROQ_MODEL`, `GEMINI_MODEL`, `XAI_MODEL`, `NVIDIA_MODEL`,
     `GROQ_120B_DAILY_LIMIT`
   - None of these are required for the app to run — any missing key just
     means that provider is skipped in the fallback chain. At minimum,
     set `OPENROUTER_API_KEY` to have a working app.
4. Redeploy after adding environment variables (they only apply to new
   deployments).

## Daily limits

- **Notes/Paper**: 5/day free, 10/day Premium.
- **Doubt Chat**: 20/day free, 60/day Premium.
- These are tracked completely separately (different Upstash key prefixes),
  so using up one doesn't affect the other.

## Turning on Premium later

The redeem-code system (`api/redeem.js`, `pages/premium.html`) is fully
built but not linked from the main site — everything above is free for
now, as requested. To turn it on:
1. Add `ADMIN_SECRET` to Vercel if not already there.
2. Generate a code by POSTing `{"action":"generate","adminSecret":"..."}`
   to `/api/redeem`.
3. Send the code to whoever paid; they redeem it at `/pages/premium.html`.
4. Link to `/pages/premium.html` from the main site's sidebar when ready.

## Google Sign-In (identity only)

A "Sign in with Google" button appears in the sidebar once `GOOGLE_CLIENT_ID`
is set. It's **identity-only** — Notebook never asks for access to Gmail,
Drive, or anything else, so the **Client Secret is never used anywhere in
this code**. What it enables:

- A signed-in student's daily quota follows their verified Google account
  across devices, instead of resetting per-IP/per-browser.
- The ID token is verified server-side on every quota-relevant call
  (`api/_limits.js`'s `resolveIdentity`) — a client can't just claim a
  different email to reset their limit; only a genuinely Google-signed
  token for this app's Client ID counts.
- Signing in is entirely optional. If `GOOGLE_CLIENT_ID` isn't set, the
  button simply never appears and everything works exactly as before
  (IP-based limits).

**Setup**: put your OAuth Client ID (the `xxxx.apps.googleusercontent.com`
string) in the `GOOGLE_CLIENT_ID` environment variable on Vercel. Do **not**
add the Client Secret anywhere — it isn't used for this. In Google Cloud
Console → Credentials, make sure your deployed domain is listed under
"Authorized JavaScript origins" for that OAuth Client ID, or the button
won't work.

## Vision-based final check

On top of every text-based check described above, a genuine **vision**
step now looks at the document the way a person actually would: the
finished preview is rendered off-screen, screenshotted (via html2canvas),
and sent to Gemini's vision model with a simple question — does anything
look visibly blank, cut off, overlapping, or broken? This catches problems
the text-only checks structurally can't see (a section whose JSON
"had content" but renders as an empty box, a diagram overlapping text).
If it finds a problem it can attribute to a specific section, that
section is regenerated with the vision feedback as context and the page
is re-checked — up to 2 rounds. This step is best-effort and fails open:
if html2canvas fails to load, the screenshot fails, or `GEMINI_API_KEY`
isn't set, it's silently skipped and the document is still delivered — it
can only make things better, never block delivery.

## Turning on ads later

`index.html` already has an ad slot ready (`#adSlot`, currently hidden).
Once you have an AdSense account, paste your ad unit code inside that div
and change its CSS `display: none` to `display: block`.

## Testing note

This sandbox has no live internet access, so the multi-provider fallback
logic, rate limiting, both API endpoints, the chunked question generation,
and the new judge/project modes were verified with syntax checks and
mocked HTTP responses (missing-key skip, provider failure → fallback,
Gemini's different request/response shape, the Groq 120B daily cap falling
through, a chunk permanently failing while its siblings still recover most
of the section's questions, the judge endpoint's request/response shape,
and the project plan/section prompts) rather than real calls to
Grok/Groq/Gemini. Do one real end-to-end test after adding your API keys
to Vercel.
