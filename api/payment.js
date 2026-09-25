// backend/api/payment.js
//
// The full Razorpay flow, merged into ONE file (was two — create-order.js
// + verify-payment.js — merged specifically to stay under Vercel Hobby's
// 12-serverless-function-per-deployment limit; this project is right at
// that ceiling with all its other features). Pick the step via the
// "action" field in the request body:
//
//   action: "create-order" — Step 1. Frontend sends a plan name
//   ("basic" | "pro" | "premium"); we create a Razorpay Order for that
//   plan's price and hand back the order_id + amount + our public Key ID
//   so the frontend can open Razorpay's checkout popup. No credits or
//   plan upgrade happen here.
//
//   action: "verify" — Step 2. After the checkout popup succeeds,
//   Razorpay hands the frontend a payment_id, order_id, and a SIGNATURE
//   (HMAC-SHA256 of `${order_id}|${payment_id}` using the Key Secret —
//   nobody who doesn't have the Key Secret can forge a valid one). We
//   recompute it here, server-side, and only if it matches do we ever
//   call applyPlanPurchase — this is what makes a student unable to just
//   call this endpoint with a fake order_id and claim they paid.
//
// Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET set in Vercel's
// environment variables (from Razorpay Dashboard → Settings → API Keys).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { PLANS, resolveIdentity, applyPlanPurchase } from '../lib/_limits.js';

async function createOrder(req, res) {
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

async function verifyPayment(req, res) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return res.status(501).json({ error: 'Payments are not configured on this server yet.' });
  }

  const {
    razorpay_order_id, razorpay_payment_id, razorpay_signature,
    plan: planKey,
    sessionToken, googleIdToken,
  } = req.body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !PLANS[planKey]) {
    return res.status(400).json({ error: 'Missing or invalid payment details.' });
  }

  const expectedSignature = createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const a = Buffer.from(razorpay_signature);
  const b = Buffer.from(expectedSignature);
  const signatureValid = a.length === b.length && timingSafeEqual(a, b);
  if (!signatureValid) {
    // This is the case that matters most: someone trying to claim a
    // purchase without having actually paid. Log-worthy in a real setup;
    // here we just refuse cleanly.
    return res.status(400).json({ error: 'Payment verification failed — signature mismatch.' });
  }

  // Signature is genuine — this payment really did succeed. Figure out
  // WHOSE account to credit: prefer a signed-in identity (so the credits
  // land on their account permanently, synced across devices); fall back
  // to IP only if they paid without signing in.
  const { key: identityKey } = await resolveIdentity(req, { sessionToken, googleIdToken });

  const result = await applyPlanPurchase(identityKey, planKey);
  if (!result.applied) {
    return res.status(500).json({ error: 'Payment verified but crediting the account failed — please contact support with your payment ID: ' + razorpay_payment_id });
  }

  return res.status(200).json({
    success: true,
    plan: result.plan,
    balance: result.balance,
    paymentId: razorpay_payment_id,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
  const { action } = req.body || {};
  if (action === 'create-order') return createOrder(req, res);
  if (action === 'verify') return verifyPayment(req, res);
  return res.status(400).json({ error: 'Missing or invalid "action" — must be "create-order" or "verify".' });
}
