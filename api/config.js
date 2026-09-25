// backend/api/config.js
//
// Serves non-secret public config to the frontend — currently just the
// Google OAuth Client ID. A Client ID is meant to be public (it's baked
// into every Google sign-in button on every site that uses one); this
// endpoint just avoids hardcoding it directly into index.html so it can
// be changed via an environment variable without editing code.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }
  return res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    // Sign-in itself (the button, credits sync, sign-up bonus) stays
    // available whenever GOOGLE_CLIENT_ID is set — but it's no longer
    // MANDATORY just because that's set. Mandatory enforcement now needs
    // its own explicit opt-in: set REQUIRE_SIGN_IN=true in Vercel's
    // environment variables once Google Cloud Console's "Authorized
    // JavaScript origins" is confirmed working for this domain. Until
    // then, the app stays fully usable for anonymous/IP-based students.
    requireSignIn: process.env.REQUIRE_SIGN_IN === 'true',
  });
}
