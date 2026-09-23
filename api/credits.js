// backend/api/credits.js
//
// Read-only: returns the caller's current credit balance so the frontend
// can show "3 credits left today" etc. Never spends a credit itself —
// only api/generate.js and api/study-tools.js do that, via spendCredit.

import { getCreditBalance, resolveIdentity, checkPremiumToken } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }
  const sessionToken = req.query?.sessionToken;
  const googleIdToken = req.query?.googleIdToken;
  const premiumToken = req.query?.premiumToken;

  const { key: identityKey, user } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const isPremium = await checkPremiumToken(premiumToken);
  if (isPremium) {
    return res.status(200).json({ premium: true, signedIn: !!user });
  }
  const { balance, configured } = await getCreditBalance(identityKey);
  return res.status(200).json({
    premium: false,
    signedIn: !!user,
    credits: configured ? balance : null, // null = credit tracking isn't configured on this server (no Upstash)
  });
}
