// api/reward.js - bonus coins: POST { kind: "share" }.
// "share" = student shared the site (+1 coin, max 2/day) - the INTERIM
// earn method while ads aren't live. "kind: ad" is accepted but returns a
// clear "not enabled yet" message rather than a coin, since the real
// ad-tier rewards (1 ad=+5, 3 ads=+20, 5 ads=+40 coins, per the Notebook4
// spec) need the actual AdMob/rewarded-ad SDK wired up first (Part 3) -
// this keeps the endpoint shape stable so that wiring is a drop-in later,
// not an API change.
import { awardBonusCoins, resolveIdentity } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  const { kind, sessionToken, googleIdToken } = req.body || {};
  if (kind !== 'share' && kind !== 'ad') return res.status(400).json({ error: 'kind must be "share" or "ad".' });
  if (kind === 'ad') {
    return res.status(503).json({ error: 'Ads aren\u2019t enabled yet \u2014 share the app instead for a coin bonus.', adsEnabled: false });
  }
  const { key } = await resolveIdentity(req, { sessionToken, googleIdToken });
  const result = await awardBonusCoins(key, kind);
  if (!result.allowed) return res.status(429).json({ error: result.reason || 'Bonus not available.' });
  return res.status(200).json(result);
}
