# Optional: Real Per-IP Rate Limiting (Upstash)

Without this, the site still works, but the "3 free generations/day" limit
is easier to bypass (clearing browser data resets it). Upstash makes the
limit real, tracked on the server by IP address.

## Setup (5 minutes, free)

1. Go to upstash.com → Sign up (Gmail works) → Create Database
   (any name, pick the region closest to your users)
2. On the database page, find the **REST API** section
3. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
4. Add both to Vercel → Settings → Environment Variables
5. Redeploy

## Free tier limits

Upstash's free tier gives far more requests/day than a small tool like
this needs. No cost expected unless usage grows a lot.
