// backend/api/redeem.js
//
// REDEEM CODE SYSTEM — lets premium be unlocked without a full login system.
//
// How it works:
//   1. YOU (the admin) generate a code after confirming a FamPay payment,
//      by calling this endpoint with your ADMIN_SECRET. This creates a
//      code in Upstash that's valid but not yet used.
//   2. You send that code to the student (WhatsApp, etc).
//   3. The student enters it on the premium page. This endpoint marks the
//      code "used" and returns a premiumToken — a random secret saved in
//      their browser (localStorage). That token is what index.html sends
//      with every generation request from then on, proving they're
//      premium, without needing an email/password account.
//
// Requires Upstash (same one already used for rate limiting). Set
// ADMIN_SECRET in Vercel env vars — pick any long random string, keep it
// private, never share it with students (only the codes it generates).

const PREMIUM_DAYS = 30;

function randomCode(length){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
  let out = '';
  for(let i = 0; i < length; i++){
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function upstash(path){
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url || !token) throw new Error('Upstash is not configured — see docs/UPSTASH-SETUP.md.');
  const res = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

export default async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { action, adminSecret, code } = req.body || {};

  // ---- ADMIN: generate a new, unused code ----
  if(action === 'generate'){
    const expected = process.env.ADMIN_SECRET;
    if(!expected){
      return res.status(500).json({ error: 'Server is missing ADMIN_SECRET. Add it in Vercel → Settings → Environment Variables.' });
    }
    if(adminSecret !== expected){
      return res.status(403).json({ error: 'Invalid admin secret.' });
    }
    try{
      const newCode = randomCode(8);
      // Store as unused. No expiry on the CODE itself (only on redeemed
      // premium status) — an unused code stays valid until redeemed.
      await upstash(`/set/nb-code:${newCode}/unused`);
      return res.status(200).json({ code: newCode });
    } catch(err){
      return res.status(500).json({ error: err.message });
    }
  }

  // ---- STUDENT: redeem a code ----
  if(action === 'redeem'){
    if(!code || typeof code !== 'string'){
      return res.status(400).json({ error: 'Please enter a code.' });
    }
    const cleanCode = code.trim().toUpperCase();
    try{
      const existing = await upstash(`/get/nb-code:${cleanCode}`);
      if(!existing.result){
        return res.status(404).json({ error: 'That code is not valid.' });
      }
      if(existing.result === 'used'){
        return res.status(409).json({ error: 'That code has already been used.' });
      }

      // Mark the code used, and issue a premium token valid for PREMIUM_DAYS.
      await upstash(`/set/nb-code:${cleanCode}/used`);
      const premiumToken = randomCode(24);
      const seconds = PREMIUM_DAYS * 86400;
      await upstash(`/set/nb-premium:${premiumToken}/active/EX/${seconds}`);

      return res.status(200).json({ premiumToken, days: PREMIUM_DAYS });
    } catch(err){
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Request must include action: "generate" or "redeem".' });
}
