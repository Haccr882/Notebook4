// backend/api/config.js
//
// Serves non-secret public config to the frontend — currently just the
// Google OAuth Client ID. A Client ID is meant to be public (it's baked
// into every Google sign-in button on every site that uses one); this
// endpoint just avoids hardcoding it directly into index.html so it can
// be changed via an environment variable without editing code.

// Firebase web config (apiKey/authDomain/projectId/...) is ALSO meant to
// be public — same deal as the Google Client ID above. Security for
// Firebase comes from your project's Security Rules, not from hiding
// these values (they're visible in every Firebase web app's network tab
// regardless). Only sent to the frontend when FIREBASE_API_KEY is set, so
// Analytics/Remote Config simply stay off until you configure a project.
function firebaseConfig(){
  if (!process.env.FIREBASE_API_KEY) return null;
  return {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || null,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
    appId: process.env.FIREBASE_APP_ID || null,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || null, // Analytics specifically needs this one
  };
}

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
    firebase: firebaseConfig(), // null until FIREBASE_API_KEY is set — see docs/FIREBASE-SETUP.md
    images: {
      pexels: !!process.env.PEXELS_API_KEY,
      ai: !!(process.env.REPLICATE_API_TOKEN || process.env.HUGGINGFACE_API_KEY),
    },
  });
}
