// api/charge-plan-cost.js
//
// CREDIT COST TABLE (free, 3 credits/day):
//   Notes / Paper / Project = 1 credit (already taken by the "plan" call)
//   Ebook (whole book)      = 2 credits (1 taken by plan call + 1 here)
// The old table charged 5 credits PER CHAPTER for ebooks - impossible with a
// 3-credit daily allowance, so every ebook request failed. Fixed.

import { spendCredit, resolveIdentity } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  const { planType, sessionToken, googleIdToken } = req.body || {};
  const additionalCost = planType === 'ebook' ? 1 : 0;
  if (additionalCost === 0) return res.status(200).json({ charged: 0, allowed: true });

  const { key: identityKey } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const spend = await spendCredit(identityKey, additionalCost);
  if (!spend.allowed) {
    return res.status(429).json({
      error: 'An ebook needs 2 credits. Come back tomorrow, or share the app / watch an ad for +1.',
      outOfCredits: true, needed: additionalCost, balance: spend.balanceAfter,
    });
  }
  return res.status(200).json({ charged: additionalCost, allowed: true, balanceAfter: spend.balanceAfter });
}
