// backend/api/generate.js
//
// MULTI-AGENT ARCHITECTURE:
//   1. PLAN — one small, fast call decides the document's structure: how
//      many sections it genuinely needs for THIS topic (no fixed page
//      target — see PLAN_PROMPT) and what each section covers. No content
//      yet.
//   2. SECTIONS — the frontend then calls this endpoint ONCE PER SECTION,
//      IN PARALLEL (Promise.all — see index.html), each one a small,
//      independent call that writes just that one section in full.
//   3. ASSEMBLE — the frontend numbers and assembles the sections itself
//      (never trusting the AI to number correctly), and retries any single
//      section that comes back broken or incomplete against the plan.
//
// MULTI-PROVIDER FALLBACK: every plan/section call tries a CHAIN of AI
// providers in order (see api/providers.js) — OpenRouter's free model,
// then Groq (fast Llama 3.3 70B), then Gemini Flash, then NVIDIA, then
// OpenRouter's fallback model — and uses whichever one answers first
// successfully. A provider whose API key isn't configured is skipped, not
// treated as a failure, so the app keeps working with a partial setup.
//
// RATE LIMITING: the daily limit counts once per user-initiated document
// (the "plan" call), not once per section — see isContinuation below.

import { callWithFallback } from './providers.js';
import { checkPremiumToken, checkAndIncrementLimit, getClientIp } from './_limits.js';

const DAILY_LIMIT = 5;
const PREMIUM_DAILY_LIMIT = 10;
const TOKENS_PER_CALL = 4000; // just under the smallest chain model's hard cap
const HEAVY_SECTION_TOKENS = 6500;

// Order matters: fastest/cheapest first, most-different-infrastructure last
// (so a single provider outage or shared-quota exhaustion doesn't take out
// more than one link in the chain at a time). Grok (xAI) and Groq's
// gpt-oss-120b are both in the mix now, not just OpenRouter/NVIDIA.
const SECTION_PROVIDER_CHAIN = ['openrouter', 'grok', 'groq', 'gemini', 'nvidia', 'openrouterFallback'];
const PLAN_PROVIDER_CHAIN = ['openrouter', 'grok', 'groq', 'gemini', 'nvidia', 'openrouterFallback'];
const JUDGE_PROVIDER_CHAIN = ['openrouter', 'grok', 'groq', 'gemini', 'nvidia', 'openrouterFallback'];
const JUDGE_TOKENS = 2000;

// A strict, independent inspector pass over the WHOLE assembled document —
// separate from the per-section completeness checks in index.html (which
// only catch missing question numbers / obviously-thin notes). This one
// actually reads the content and checks it against the topic itself: did
// any section drift off-topic, contradict another section, or quietly
// leave something out that a human reviewer would notice. The frontend
// calls this mode after its own repair rounds and, if it comes back
// unclear, regenerates exactly the flagged sections and asks again — see
// index.html's judge loop.
const JUDGE_PROMPT = `You are Notebook's strict quality-inspector agent. A document has already been generated section by section. Your ONLY job is to review it and report problems — you do NOT rewrite anything yourself.

For EACH section given, check:
- "incomplete": does it look cut off, thin, or does it gesture at more content without writing it (e.g. "and so on", trailing off mid-sentence, an answer key missing some question numbers)?
- "off_topic": does its content genuinely belong to a DIFFERENT topic than what was requested, or wander into unrelated material?
- "placeholder": is any part of it literally a placeholder like "(This section couldn't be generated)", "[TODO]", "[continue similarly]"?
- "inconsistent": does it contradict the mark scheme or another section (specimen papers only)?

Be a fair but genuinely strict reviewer — a section that is simply CONCISE (short bullet points, to the point) is NOT a problem by itself; only flag it if it is actually missing real substance a student would need, not just because it's brief.

Return ONLY valid JSON, no commentary:
{
  "clear": true or false,
  "issues": [
    { "index": 0, "problem": "incomplete" | "off_topic" | "placeholder" | "inconsistent", "note": "one short, specific sentence — exactly what's wrong and what to fix" }
  ]
}
"clear" is true only if "issues" is empty. Use the exact 0-based "index" of the section in the list given to you.`;

const SHARED_RULES = `Math notation: NEVER use LaTeX commands like \\frac, \\sin, $...$, \\theta. Instead write math in plain readable text using Unicode symbols: θ, π, √, °, ², ³, ×, ÷, ±, ≤, ≥, ∠, △.

Use **double asterisks** to bold: question labels (e.g. **Q1.**), part labels (e.g. **(a)**, **(b)**), and short key terms/final answers. Don't bold whole sentences.

"content" must ALWAYS be a single plain text string — flowing prose. NEVER put nested JSON or extra key-value sub-fields inside "content".

QUALITY: Write like a genuinely excellent teacher, not a generic AI summary. Use specific, concrete numbers, named examples, and real formulas — never vague filler like "various factors" or "several examples exist" where an actual example belongs. For a worked numerical, show every calculation step with real numbers, not just the method described in words.

COMPLETENESS: If you were given a questionCount, you MUST write exactly that many fully numbered questions (or answers) — never fewer. Do not stop early, skip a question number, or summarize "and so on" — every single question/answer in your assigned range must be fully written out. Never write a placeholder like "[continue similarly]" — every section must be finished, real, complete content.`;

const PLAN_PROMPT = `You are Notebook's planning agent. A student has made a request for study notes, a specimen/exam paper, or a school PROJECT REPORT. Your ONLY job right now is to decide the document's structure — NOT write any content yet.

Return ONLY valid JSON, no commentary, matching exactly:
{
  "type": "notes" or "specimen" or "project",
  "title": "a clear title for the whole document",
  "markScheme": "for a specimen paper: one precise paragraph stating the EXACT structure — e.g. 'Section A: 5 MCQs, 1 mark each = 5 marks. Section B: 4 VSA, 2 marks each = 8 marks. Section C: 3 SA, 3 marks each = 9 marks. Section D: 2 LA, 4 marks each = 8 marks. Total = 30 marks, matching the requested total.' For notes/project, leave this as an empty string.",
  "sections": [
    { "heading": "Section heading", "questionCount": 0 }
  ]
}

"questionCount" = how many numbered questions THIS section contains (0 for non-question sections like an overview, notes topic, or any project section).

WHICH type to pick: "project" is for "make me a project on X" / "school project report" / "project file for [subject]" style requests — a complete school project REPORT document, not exam notes or a test paper. If the request just asks to explain/summarize/revise a topic, that's "notes"; if it asks for a test/exam/MCQs, that's "specimen".

If type is "project", the "sections" array MUST be, in this exact order:
1. { "heading": "Certificate", "questionCount": 0 }
2. { "heading": "Acknowledgement", "questionCount": 0 }
3. { "heading": "Index", "questionCount": 0 }
4. { "heading": "Introduction", "questionCount": 0 }
5. Then 3-6 MAIN BODY sections you choose, each a genuinely distinct sub-topic of the project subject (e.g. for "Project on Solar System": "The Sun and Its Structure", "The Eight Planets", "Other Bodies — Comets, Asteroids, Moons", "Space Exploration Missions" — headings must be specific to THIS subject, never generic like "Main Body" or "Details").
6. { "heading": "Conclusion", "questionCount": 0 }
7. { "heading": "Bibliography", "questionCount": 0 }
Do not add, remove, or reorder the Certificate/Acknowledgement/Index/Introduction/Conclusion/Bibliography anchor sections — only the main-body sections in between are yours to choose, sized to the subject's real breadth (a narrow subject needs fewer, a broad one needs more — same no-fixed-length rule as notes).

LENGTH: there is NO fixed page count to hit. Size the document ENTIRELY by how much a genuinely thorough treatment of THIS topic needs — a narrow, single-concept topic may only need 3-4 short sections; a broad chapter may need many more. Never pad with generic filler sections just to make it longer, and never cut a topic short to save space. Go only as deep and as wide as the topic itself genuinely requires — nothing more, nothing less.

Rules for deciding sections:
- If this is STUDY NOTES: pick from Overview, Key Concepts, Important Definitions, Formulas/Laws, Worked Examples, Quick Revision Summary — use ONLY as many of these as genuinely fit the topic's breadth (skip any that don't add real value for this specific topic). Keep it tight and exam-focused like a genuine topper's revision notes — no filler sections, no "Common Mistakes" or "Exam Tips" padding sections. questionCount is 0 for all of these. markScheme is "".
- If this is a SPECIMEN/EXAM PAPER: base the structure on how THIS SPECIFIC board, class, and subject's REAL exams are genuinely structured — not a generic template. Work out the EXACT mark arithmetic for your chosen structure and write it precisely into "markScheme" — this exact text is shown to every section-writer so they all agree with each other and the Overview. Verified real current patterns to match (adapt the marks proportionally if the student asks for a different total, but keep the same section SHAPE):
  - CBSE Class 10 Maths/Science-style papers (80 marks, 3 hours): FIVE sections A-E. Section A = MCQs incl. Assertion-Reason, 1 mark each (largest question count). Section B = Very Short Answer, 2 marks each. Section C = Short Answer, 3 marks each. Section D = Long Answer, 5 marks each. Section E = 3-4 Case-Study questions, 4-5 marks each with sub-parts (e.g. 1+1+2 marks). Internal choice in 2 questions each of B/C/D and in the case-study sub-parts of E. No internal choice in A. This is the current real structure — do NOT use an old-style 4-section "A-D, no case study" layout for CBSE Maths/core subjects.
  - CBSE Class 10 Science is additionally sectioned by SUBJECT: Section A = Biology, B = Chemistry, C = Physics, each internally containing a mix of question types.
  - CBSE Class 10 Social Science: Section A = History, B = Geography, C = Political Science, D = Economics.
  - ICSE Class 10 (e.g. Physics/Chemistry/Biology, 80 theory marks, 2 hours): only TWO sections. Section A = 40 marks, compulsory, short-form questions covering the entire syllabus (definitions, short numericals, conceptual reasoning — no choice). Section B = 40 marks, the student answers 4 out of 6 longer application/numerical questions with diagrams. Do NOT invent a CBSE-style A-E structure for ICSE — this 2-section shape is correct and different on purpose.
  - If the student doesn't specify a board, default to the CBSE-style structure above (most common), but state the assumption briefly in the Overview section.
  - If you're unsure of the exact modern convention for a board/subject not covered above, reason from what's realistic and common for that level rather than defaulting to one fixed template — and keep the section count/shape simple and plausible rather than guessing an elaborate structure you're not confident in.
  - Start with "Paper Overview & Instructions" (questionCount: 0) — restating the markScheme you decided.
  - CRITICAL: do NOT create one single "Answer Key" section for the whole paper — a full answer key in one chunk is too large to generate reliably. Instead create ONE SEPARATE answer-key section immediately after each question section, named like "Answer Key — Section A", "Answer Key — Section B", etc. Each answer-key section's questionCount should match the question section it answers.
- If the student specifies a page count or total marks, size sections/questionCounts so the total genuinely adds up to that target — this must be arithmetically exact, not approximate.
- Each heading must be specific enough that another AI could write that ONE section well without seeing the others.
- Hard technical safety limit: never propose more than 40 sections total (this exists only to keep the request from timing out — almost no real request should ever get near it; do not treat it as a target).`;

function sectionPrompt(type){
  let typeRules;
  if(type === 'specimen'){
    typeRules = `This is one section of a specimen/exam paper. The paper's exact mark scheme (decided already, shared with every section so they all agree) is given below as "markScheme" — follow it exactly, do not invent different question counts or mark values. If this section is a question section (MCQ/VSA/SA/LA), write the actual questions with marks shown, and internal "OR" choices where realistic — number them starting from the "startingQuestionNumber" given below (e.g. if it's 6, your questions are Q6, Q7, Q8...). If this section is an Answer Key for a specific earlier section, give the full worked solution for exactly the question numbers in that section's range (matching startingQuestionNumber and questionCount), nothing else. If this section is the Paper Overview, restate the markScheme accurately as part of your content.`;
  } else if(type === 'project'){
    typeRules = `This is one section of a school PROJECT REPORT (the kind submitted as a physical/PDF project file, not exam notes). Match the heading EXACTLY to how a real student project handles it:
- "Certificate": a short, formal certificate-of-completion text — e.g. "This is to certify that ______________________ of Class ______________ has successfully completed the project on '<the actual project topic>' during the academic year ______________ under the guidance of ______________." Include blank underscore placeholders for name/class/teacher/date exactly like a real printed certificate has blank lines to fill in by hand — do NOT invent a specific student/teacher name.
- "Acknowledgement": a short (4-6 sentence), warm, genuine-sounding paragraph thanking teacher, parents, and school for support — written in first person as the student, generic enough to apply to anyone (no invented specific names beyond generic placeholders like "my [Subject] teacher").
- "Index": a clean numbered list of every OTHER section's title in this project, in order (Acknowledgement, Introduction, then each main-body section by its real title, then Conclusion, Bibliography) — like a real table of contents. One line per entry, nothing else.
- "Introduction": a genuine, engaging introduction to the project's subject — what it is, why it's studied, what the project will cover — written as real prose (this one section may be a short paragraph or two, not bullet points, since it's an introduction).
- Any MAIN BODY section (the actual topic sub-sections chosen in the plan): this is the real substance of the project — thorough, accurate, well-organized content on that specific sub-topic, with a diagram wherever the topic is visual (see DIAGRAM rules). This can and should be more developed than exam-revision notes — a project report is meant to read as a genuine researched write-up, not bullet-point cram notes.
- "Conclusion": a short, reflective wrap-up (4-8 sentences) — what was learned, why the topic matters, restated in the student's own voice.
- "Bibliography": a numbered list of 4-6 GENERIC, realistic source types Indian students actually cite for projects — the relevant NCERT/board textbook for this subject, Wikipedia, and 2-3 well-known general educational sites (e.g. Byju's, Vedantu) named generically by site, not fabricated specific book titles, authors, editions, or ISBNs.`;
  } else {
    typeRules = `This is one section of a student's study notes. Write it EXACTLY like a topper's handwritten revision notes, or how the best teacher writes on the board: short, crisp, and 100% to the point — never like a textbook paragraph or a generic AI summary. Requirements:
- Write in short lines/bullet-style points, not long flowing paragraphs. Every sentence should earn its place — if a word can be cut without losing meaning, cut it.
- Give the definition/point in ONE crisp line, then (only if it genuinely helps) ONE short line on why it matters or how it's tested — never a paragraph of elaboration. Depth comes from covering the concept's real sub-points precisely, not from writing more words per point.
- Write at a genuinely sharp, advanced level, not a childish/oversimplified one — use the correct technical term first, then clarify briefly if needed. A topper's notes read as confident and precise, never dumbed down. Concise is about word count, not about depth or sophistication — a short point can still show real insight.
- For a "Worked Examples" section, include at least TWO fully solved examples of different difficulty (one straightforward, one that combines concepts) — show every step, but keep each step to one short line.
- For "Key Concepts" or "Formulas" sections, add ONE short memory aid per genuinely tricky concept (a mnemonic, a one-line comparison, or a one-line "X vs Y" distinction) — only where it truly helps, not on every point.
- Never use vague hedge phrases like "there are many factors" or "in various situations" — always name the actual factors/situations, briefly.
- Stay tightly on-topic — cover exactly what this heading covers and nothing else; don't wander into adjacent topics that belong in a different section.
- NEVER write a placeholder like "and so on", "etc.", "[continue similarly]", or "(remaining points similarly)" — if there are more points, write every single one out, briefly, don't gesture at them.
- Short does NOT mean incomplete: cover every genuinely important sub-point of this heading. Being concise means cutting words, never cutting content.`;
  }

  return `You are Notebook's writing agent, an experienced school teacher. You're writing ONE section of a larger document. Stay focused only on the section you're asked for.

Return ONLY valid JSON, no commentary, matching exactly:
{
  "heading": "the section heading (repeat exactly as given)",
  "explanation": "1-2 plain-language sentences on what this section covers",
  "content": "the FULL content of this section — thorough and complete, written like a teacher explaining on a board, not robotic",
  "diagram": "OPTIONAL raw SVG string — see DIAGRAM rules below. Omit this key entirely if no diagram is needed."
}

DIAGRAM rules: include a "diagram" whenever the section is ABOUT something a real teacher would draw — ray/light diagrams (refraction, reflection, lenses), circuit diagrams, geometry figures (triangles, circles with labelled parts), force/vector diagrams, labelled biological structures/cycles, process flowcharts, bar/line graphs of a relationship, a labelled map-style sketch. If the content mentions "draw a diagram" or describes a physical setup, cycle, or process, you MUST include one — don't just describe it in words and skip the visual. Make it a REAL, clear, well-labelled diagram, not a token decoration — use the full canvas, label every part, and use arrows/polygons to show direction or flow where relevant. Format requirements (follow EXACTLY, this is validated and stripped if wrong):
- Must start with <svg viewBox="0 0 500 320"> and end with </svg> — no width/height attributes on the svg tag itself.
- Only these child tags: <line> <path> <circle> <rect> <polygon> <text> <g>. No <script>, no event handler attributes (onclick etc), no <image>, no external references, no <marker>/<defs>.
- Draw arrowheads with a small filled <polygon> triangle (3 points) at the line's end instead of relying on markers — this is the only way to show direction with the allowed tags.
- Use 2-3 distinct stroke colours to separate different elements/parts (e.g. "#23301F" for structure lines, "#B8722E" for the highlighted/active path, "#4C7A5E" for a third element) — fill="none" unless deliberately filling a shape — and <text font-size="13" fill="#23301F"> for every label (never leave a part unlabelled).
Example of a valid diagram (a ray bending at a boundary, with an arrowhead and two colours):
"diagram": "<svg viewBox=\\"0 0 500 320\\"><line x1=\\"0\\" y1=\\"160\\" x2=\\"500\\" y2=\\"160\\" stroke=\\"#23301F\\" stroke-width=\\"1\\"/><line x1=\\"250\\" y1=\\"30\\" x2=\\"250\\" y2=\\"290\\" stroke=\\"#23301F\\" stroke-width=\\"1\\" stroke-dasharray=\\"4\\"/><line x1=\\"100\\" y1=\\"60\\" x2=\\"250\\" y2=\\"160\\" stroke=\\"#B8722E\\" stroke-width=\\"2\\"/><polygon points=\\"250,160 238,150 238,162\\" fill=\\"#B8722E\\"/><line x1=\\"250\\" y1=\\"160\\" x2=\\"330\\" y2=\\"290\\" stroke=\\"#B8722E\\" stroke-width=\\"2\\"/><polygon points=\\"330,290 320,278 310,286\\" fill=\\"#B8722E\\"/><text x=\\"90\\" y=\\"48\\" font-size=\\"13\\" fill=\\"#23301F\\">Incident ray</text><text x=\\"255\\" y=\\"25\\" font-size=\\"13\\" fill=\\"#23301F\\">Normal</text><text x=\\"335\\" y=\\"300\\" font-size=\\"13\\" fill=\\"#23301F\\">Refracted ray</text></svg>"

${typeRules}

${SHARED_RULES}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { mode, userRequest, sectionHeading, type, isContinuation, startingQuestionNumber, questionCount, markScheme, premiumToken, continueFrom, sections } = req.body || {};
  if (mode !== 'plan' && mode !== 'section' && mode !== 'judge') {
    return res.status(400).json({ error: 'Request must include mode: "plan", "section", or "judge".' });
  }
  if (mode !== 'judge' && !userRequest) {
    return res.status(400).json({ error: 'Request must include "userRequest".' });
  }
  if (mode === 'judge' && (!Array.isArray(sections) || sections.length === 0)) {
    return res.status(400).json({ error: 'Judge mode requires a non-empty "sections" array.' });
  }

  // The daily limit counts once per document (the plan call). All section
  // AND judge calls that follow it are part of the SAME user-initiated
  // generation — only the very first "plan" call counts against the quota.
  if (!isContinuation) {
    const isPremium = await checkPremiumToken(premiumToken);
    const limit = isPremium ? PREMIUM_DAILY_LIMIT : DAILY_LIMIT;
    const ip = getClientIp(req);
    const limitResult = await checkAndIncrementLimit(ip, limit, 'nb');
    if (!limitResult.allowed) {
      return res.status(429).json({ error: `Daily limit reached (${limit} per day). ${isPremium ? '' : 'Upgrade to Premium for more, or '}try again after midnight.` });
    }
  }

  let chatMessages;
  if (mode === 'plan') {
    chatMessages = [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: userRequest },
    ];
  } else if (mode === 'judge') {
    // Cap what's sent per section — this is a review pass, not a rewrite,
    // and doesn't need the full text of a long section to spot an
    // off-topic drift, a placeholder, or an obviously unfinished ending.
    const listing = sections.map((s, i) => `[${i}] "${s.heading}"\n${(s.content || '').slice(0, 700)}`).join('\n\n');
    chatMessages = [
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: `Original request/topic: "${userRequest}"${markScheme ? `\nAgreed mark scheme: ${markScheme}` : ''}\n\nSections to review:\n\n${listing}` },
    ];
  } else {
    if (!sectionHeading) {
      return res.status(400).json({ error: 'Section mode requires "sectionHeading".' });
    }
    chatMessages = [
      { role: 'system', content: sectionPrompt(type) },
      { role: 'user', content: `Overall document request: "${userRequest}"${markScheme ? `\nAgreed mark scheme (follow exactly, all sections must match this): ${markScheme}` : ''}\n\nWrite ONLY this section: "${sectionHeading}"${questionCount ? `\nstartingQuestionNumber: ${startingQuestionNumber}\nquestionCount: ${questionCount}` : ''}` },
    ];
    // If this section got cut off last time, ask the model to continue the
    // SAME raw JSON text exactly where it stopped, instead of starting over
    // — this is what fixes truncated content, dropped answer-key entries,
    // and questions that silently went missing near the end of a section.
    if (continueFrom) {
      chatMessages.push({ role: 'assistant', content: continueFrom });
      chatMessages.push({ role: 'user', content: 'Continue exactly where you left off. Output only the next raw chunk of the same JSON — no repetition, no restarting, no commentary. Make sure every question up to questionCount is still fully written.' });
    }
  }

  // Heavy sections (many questions, or an Answer Key with full worked
  // solutions) need more room than a short Overview section.
  const isHeavySection = mode === 'section' && (questionCount > 3 || /answer key/i.test(sectionHeading || ''));
  const dynamicTokens = mode === 'judge' ? JUDGE_TOKENS : (isHeavySection ? HEAVY_SECTION_TOKENS : TOKENS_PER_CALL);
  const chain = mode === 'plan' ? PLAN_PROVIDER_CHAIN : mode === 'judge' ? JUDGE_PROVIDER_CHAIN : SECTION_PROVIDER_CHAIN;

  try {
    const { text, finishReason, modelUsed, providerUsed } = await callWithFallback(chain, chatMessages, dynamicTokens, req.headers.origin);
    return res.status(200).json({ content: text, finishReason, modelUsed, providerUsed });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
