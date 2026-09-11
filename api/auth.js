// backend/api/auth.js
//
// Called right after the "Sign in with Google" button produces an ID
// token, purely to give the frontend an immediate "you're signed in as
// X" confirmation. The verified identity is re-checked independently on
// every quota-relevant call in generate.js/chat.js (see
// _limits.js's resolveIdentity) — this endpoint doesn't create a session
// or store anything server-side, it's just a verify-and-echo.

import { verifyGoogleIdToken } from '../lib/_limits.js';

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
  return res.status(200).json({ user });
}
