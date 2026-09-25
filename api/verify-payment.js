// backend/api/verify-payment.js
//
// Step 2 of the Razorpay flow: after the checkout popup succeeds,
// Razorpay hands the frontend a payment_id, order_id, and a SIGNATURE.
// That signature is an HMAC-SHA256 of `${order_id}|${payment_id}` using
// YOUR Key Secret — nobody who doesn't have the Key Secret can forge a
// valid one. We recompute it here, server-side, and only if it matches
// do we ever call applyPlanPurchase. This is what makes the whole flow
// safe: a student can't just call this endpoint directly with a fake
// order_id and claim they paid — the signature check would fail.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveIdentity, applyPlanPurchase, PLANS } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
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
  // to IP only if they paid without signing in (works, but that plan is
  // then tied to this IP/device, not portable — the frontend should
  // encourage signing in before paying to avoid this).
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
