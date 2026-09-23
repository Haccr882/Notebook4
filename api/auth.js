// backend/api/auth.js
//
// Called right after the "Sign in with Google" button produces an ID
// token. Verifies it once, then issues the app's OWN long-lived session
// token (see signSession in lib/_limits.js) — the frontend stores and
// re-sends THIS from now on instead of the raw Google credential, which
// is what fixes the old "signed out again within a day" behaviour (a
// Google ID token itself is only valid ~1hr; the session token is valid
// 30 days). Also awards the one-time 10-credit sign-up bonus the first
// time this email ever completes sign-in (see
// awardSignupBonusIfFirstLogin — safe to call every sign-in, it no-ops
// after the first time).

import { verifyGoogleIdToken, signSession, awardSignupBonusIfFirstLogin } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ error: 'Missing "credential".' });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(501).json({ error: 'Google sign-in is not configured on this server yet.' });
  }
  const user = await verifyGoogleIdToken(credential, process.env.GOOGLE_CLIENT_ID);
  if (!user) {
    return res.status(401).json({ error: 'That Google sign-in could not be verified — please try again.' });
  }
  const bonusAwarded = await awardSignupBonusIfFirstLogin(user.email);
  const sessionToken = signSession(user);
  return res.status(200).json({ user, sessionToken, bonusAwarded });
}
