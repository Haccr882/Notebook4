// api/credits.js - read-only: returns the caller's credit balance.
import { getCreditBalance, resolveIdentity, PLANS } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  const { key: identityKey, user } = await resolveIdentity(req, {
    sessionToken: req.query?.sessionToken,
    googleIdToken: req.query?.googleIdToken,
  });
  const { balance, plan, configured } = await getCreditBalance(identityKey);
  return res.status(200).json({
    plan,
    planLabel: PLANS[plan]?.label || 'Free',
    signedIn: !!user,
    credits: configured ? balance : null, // null = credits not configured on this server (no Upstash)
  });
}
