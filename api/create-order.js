// backend/api/create-order.js
//
// Step 1 of the Razorpay flow: the frontend calls this with a plan name
// ("basic" | "pro" | "premium"), we create a Razorpay Order for that
// plan's price, and hand back the order_id + amount + our public Key ID
// so the frontend can open Razorpay's checkout popup. No credits or plan
// upgrade happen here — that only happens in api/verify-payment.js AFTER
// Razorpay confirms the payment actually succeeded.
//
// Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET set in Vercel's
// environment variables (from Razorpay Dashboard → Settings → API Keys).
// Without them, this endpoint returns a clear "not configured" error
// rather than a confusing failure.

import { PLANS } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return res.status(501).json({ error: 'Payments are not configured on this server yet (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET).' });
  }

  const { plan: planKey } = req.body || {};
  const plan = PLANS[planKey];
  if (!plan || plan.priceINR <= 0) {
    return res.status(400).json({ error: 'Invalid plan. Must be one of: basic, pro, premium.' });
  }

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: plan.priceINR * 100, // Razorpay wants paise, not rupees
        currency: 'INR',
        notes: { plan: planKey, app: 'notebook' },
      }),
    });
    const order = await orderRes.json();
    if (!orderRes.ok) {
      return res.status(502).json({ error: order.error?.description || 'Razorpay order creation failed.' });
    }
    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId, // Key ID is public by design — safe to send to the frontend (unlike the Key Secret, which never leaves this file)
      plan: planKey,
      planLabel: plan.label,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not reach Razorpay — please try again.' });
  }
}
