# Firebase setup — Notebook4

Used for: **Analytics** (page views, feature usage, generation events) and **Remote Config** (change a value like a feature flag without redeploying). Both are optional — the app works identically without Firebase configured, just without these two things.

Note on "Crash reporting" from the spec: Firebase **Crashlytics** is mobile-only (Android/iOS SDKs) — there's no direct Firebase web equivalent. Instead, this app catches browser JS errors itself and logs them to Supabase's `usage_logs` table (see `api/feedback.js`'s `client-error` action) and, when Firebase Analytics is configured, also fires an `app_exception` Analytics event. That's the practical equivalent for a web app.

## 1. Create a Firebase project
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it, Analytics on (keep it enabled when asked).
2. Inside the project → ⚙️ **Project settings** → scroll to **Your apps** → **Add app** → the `</>` (Web) icon.
3. Register the app (nickname only, no hosting needed) → it shows a `firebaseConfig` object like:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "yourproject.firebaseapp.com",
     projectId: "yourproject",
     storageBucket: "yourproject.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef",
     measurementId: "G-XXXXXXX"
   };
   ```

## 2. Vercel env vars
Copy each value from that object into Vercel → your project → Settings → Environment Variables:

| Vercel env var | from `firebaseConfig.` |
|---|---|
| `FIREBASE_API_KEY` | `apiKey` |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `FIREBASE_PROJECT_ID` | `projectId` |
| `FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `FIREBASE_APP_ID` | `appId` |
| `FIREBASE_MEASUREMENT_ID` | `measurementId` |

⚠️ These are **meant to be public** (every Firebase web app ships them visibly in its JS) — real security comes from Firebase's own Security Rules, not from hiding this config. Still fine to keep them as env vars rather than hardcoded, just so you can change projects without editing code.

Redeploy after adding them. `api/config.js` only sends `firebase: {...}` to the frontend once `FIREBASE_API_KEY` is set — until then Analytics/Remote Config both silently stay off.

## 3. Remote Config (optional)
In Firebase console → **Remote Config** → **Add parameter**. This app reads one parameter by default:

| Parameter | Type | Default | Used for |
|---|---|---|---|
| `maintenance_message` | String | *(empty)* | If non-empty, shown as a banner across the top of the app — for a planned-downtime notice without a redeploy |

Add more parameters and read them the same way in `index.html`'s `initFirebase()` function (`remoteConfig.getValue("your_param").asString()`) if you want more flags later (e.g. a kill-switch for a specific feature).

## Checking it worked
After deploying with the env vars set and opening the live site: Firebase console → **Analytics** → **Realtime** should show you as an active user within a minute, and clicking a feature card should show a `feature_selected` event there shortly after (Analytics events can take a few hours to appear in the main reports, but **Realtime** is near-instant — use that to verify).
