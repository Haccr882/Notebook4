// backend/api/sync.js
//
// Cloud sync for a signed-in student's chats — GET restores them on a new
// device/browser, POST saves the current set. Requires a verified Google
// ID token on every call (never a client-supplied email — see
// verifyGoogleIdToken in _limits.js), and stores the data in the SAME
// Upstash database already used for rate limiting, just under a
// different key prefix. No new infrastructure needed.
//
// This is deliberately simple last-write-wins sync, not real-time
// collaboration or conflict resolution: whichever device saves last wins.
// For a single student using their own notes across a couple of devices,
// that's a reasonable, honest tradeoff — real conflict resolution would
// be a much bigger feature.

import { verifyGoogleIdToken } from './_limits.js';

const MAX_PAYLOAD_BYTES = 900 * 1024; // Upstash free tier caps request/value size — stay comfortably under it

async function requireUser(req){
  const { googleIdToken } = req.body || {};
  const idToken = googleIdToken || (req.query && req.query.googleIdToken);
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  return verifyGoogleIdToken(idToken, process.env.GOOGLE_CLIENT_ID);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(501).json({ error: 'Cloud sync is not configured on this server (Upstash not set up).' });
  }

  const user = await requireUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in with Google to use cloud sync.', requiresSignIn: true });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `nb-sync:${user.email}`;

  if (req.method === 'GET') {
    try {
      const upstashRes = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await upstashRes.json();
      if (!data.result) return res.status(200).json({ chats: null }); // nothing saved yet — not an error
      return res.status(200).json({ chats: JSON.parse(data.result) });
    } catch (err) {
      return res.status(500).json({ error: 'Could not load cloud data — your local chats are unaffected.' });
    }
  }

  // POST — save
  const { chats } = req.body || {};
  if (!Array.isArray(chats)) {
    return res.status(400).json({ error: 'Request must include a "chats" array.' });
  }
  const serialized = JSON.stringify(chats);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ error: 'Too much saved chat history to sync — older local chats will stay local-only.' });
  }
  try {
    // Upstash's REST API for SET takes the value as the raw request body
    // (like `curl -d "value"`) — NOT JSON-wrapped again, which would
    // double-encode the string and corrupt what gets read back.
    await fetch(`${url}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: serialized,
    });
    return res.status(200).json({ saved: true });
  } catch (err) {
    return res.status(500).json({ error: 'Could not save to cloud — your local copy is still safe.' });
  }
}
