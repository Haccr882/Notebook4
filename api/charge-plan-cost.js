// api/charge-plan-cost.js
//
// COIN COST TABLE (5 free coins/day - see PLANS/DAILY_FREE_CREDITS in
// lib/_limits.js):
//   Notes / Paper / Project    10 coins  (capped ~10 printed pages, see PLAN_PROMPT)
//   Ebook, short (~5 pages)    10 coins
//   Ebook, full (~100 pages)   15 coins
// The "plan" call (api/generate.js) already takes 1 coin as a flat spam
// gate before the real size is known - this endpoint charges whatever is
// left of the true cost once the plan/length choice is known, BEFORE any
// section-writing call, so a student who can't afford it finds out here,
// not after several sections have already been generated.

import { spendCredit, resolveIdentity } from '../lib/_limits.js';

const PLAN_GATE_COST = 1; // already spent by the "plan" call itself

function totalCost(planType, ebookLength){
  if (planType === 'ebook') return ebookLength === 'short' ? 10 : 15; // default to the bigger "full" cost if not specified
  return 10; // notes / specimen / project
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  const { planType, ebookLength, sessionToken, googleIdToken } = req.body || {};
  const additionalCost = Math.max(0, totalCost(planType, ebookLength) - PLAN_GATE_COST);
  if (additionalCost === 0) return res.status(200).json({ charged: 0, allowed: true });

  const { key: identityKey } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const spend = await spendCredit(identityKey, additionalCost);
  if (!spend.allowed) {
    return res.status(429).json({
      error: `This needs ${totalCost(planType, ebookLength)} coins total — you have ${spend.balanceAfter}. Come back tomorrow, or share the app / watch an ad for +1.`,
      outOfCredits: true, needed: additionalCost, balance: spend.balanceAfter,
    });
  }
  return res.status(200).json({ charged: additionalCost, allowed: true, balanceAfter: spend.balanceAfter });
}
