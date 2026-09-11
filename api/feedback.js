// backend/api/feedback.js
//
// Stores feedback/help messages in Upstash (same database already used
// for rate limiting and redeem codes) so you can review them later without
// needing email or a separate service. Each message is pushed onto a list;
// read them back with the "list" action using your ADMIN_SECRET.

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

  const { action, message, contact, adminSecret } = req.body || {};

  // ---- Anyone: submit feedback ----
  if(action === 'submit'){
    if(!message || typeof message !== 'string' || !message.trim()){
      return res.status(400).json({ error: 'Please write a message first.' });
    }
    try{
      const entry = JSON.stringify({
        message: message.trim().slice(0, 2000),
        contact: (contact || '').trim().slice(0, 200),
        time: new Date().toISOString(),
      });
      await upstash(`/lpush/nb-feedback/${encodeURIComponent(entry)}`);
      return res.status(200).json({ ok: true });
    } catch(err){
      return res.status(500).json({ error: err.message });
    }
  }

  // ---- Admin: read recent feedback ----
  if(action === 'list'){
    const expected = process.env.ADMIN_SECRET;
    if(!expected || adminSecret !== expected){
      return res.status(403).json({ error: 'Invalid admin secret.' });
    }
    try{
      const data = await upstash('/lrange/nb-feedback/0/49');
      const entries = (data.result || []).map(raw => {
        try{ return JSON.parse(raw); } catch(e){ return { message: raw }; }
      });
      return res.status(200).json({ entries });
    } catch(err){
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Request must include action: "submit" or "list".' });
}
