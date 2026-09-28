// api/reward.js - bonus credits: POST { kind: "share" | "ad" }.
// "share" = student shared the site (+1, max 2/day). "ad" = rewarded ad
// finished inside the Android app (+1, max 3/day). Trust-based but capped.
import { awardBonusCredit, resolveIdentity } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  const { kind, sessionToken, googleIdToken } = req.body || {};
  if (kind !== 'share' && kind !== 'ad') return res.status(400).json({ error: 'kind must be "share" or "ad".' });
  const { key } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const result = await awardBonusCredit(key, kind);
  if (!result.allowed) return res.status(429).json({ error: result.reason || 'Bonus not available.' });
  return res.status(200).json(result);
}
