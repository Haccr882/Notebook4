// backend/api/charge-plan-cost.js
//
// CREDIT COST TABLE (per the actual size of what's being generated, not
// a flat 1-credit-per-document rate):
//   Notes                     1 credit  (same as the initial plan-call gate — no extra charge)
//   Paper/Project, ~3-5 pages 2 credits (proxied by total question count ≤ 10)
//   Paper/Project, ~6-10 pages 3 credits (total question count > 10)
//   Ebook chapter              5 credits EACH (Introduction/Conclusion count as chapters too)
//
// Why this is a SEPARATE call from the plan step: the "plan" call (see
// api/generate.js, mode:'plan') only knows the student's REQUEST text —
// it doesn't know the real section/chapter count until the AI actually
// plans the document, which happens as part of that same call but is
// only PARSED on the frontend. So the flow is: plan call spends 1 credit
// as a flat gate (protects against spam), the frontend parses the
// resulting structure, and THEN calls this endpoint with that structure
// to charge whatever's left of the real cost before generating any
// section content. If the student doesn't have enough credits for a
// document this size, generation stops here — before any section-writing
// calls are made — so nothing is wasted beyond the 1 credit already
// spent on planning (which is a fair cost for the planning step itself).

import { spendCredit, checkPremiumToken, resolveIdentity } from '../lib/_limits.js';

function computeAdditionalCost(planType, sections){
  const list = Array.isArray(sections) ? sections : [];
  let totalCost;
  if (planType === 'ebook') {
    totalCost = list.length * 5;
  } else if (planType === 'notes') {
    totalCost = 1;
  } else {
    // specimen / project — proxy "how many pages" by total question count
    const totalQuestions = list.reduce((sum, s) => sum + (typeof s === 'object' ? (s.questionCount || 0) : 0), 0);
    totalCost = totalQuestions <= 10 ? 2 : 3;
  }
  return Math.max(0, totalCost - 1); // 1 credit was already spent by the plan call itself
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  const { planType, sections, premiumToken, sessionToken, googleIdToken } = req.body || {};

  const isPremium = await checkPremiumToken(premiumToken);
  if (isPremium) {
    // Premium (legacy UPI+redeem-code) students already pay a flat daily
    // cap elsewhere (see PREMIUM_DAILY_LIMIT in api/generate.js) — size
    // doesn't cost them extra credits.
    return res.status(200).json({ charged: 0, allowed: true });
  }

  const additionalCost = computeAdditionalCost(planType, sections);
  if (additionalCost === 0) {
    return res.status(200).json({ charged: 0, allowed: true });
  }

  const { key: identityKey } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const spend = await spendCredit(identityKey, additionalCost);
  if (!spend.allowed) {
    return res.status(429).json({
      error: `This document needs ${additionalCost} more credit${additionalCost === 1 ? '' : 's'} than you have available — try a smaller request, or top up.`,
      outOfCredits: true,
      needed: additionalCost,
      balance: spend.balanceAfter,
    });
  }
  return res.status(200).json({ charged: additionalCost, allowed: true, balanceAfter: spend.balanceAfter });
}
