// api/credits.js - read-only: returns the caller's coin balance plus how
// much of today's free allowance (Notes/Chat/Quiz) is left.
import { getCoinBalance, peekDailyCount, resolveIdentity, DAILY_FREE } from '../lib/_limits.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  const { key: identityKey, user } = await resolveIdentity(req, {
    sessionToken: req.query?.sessionToken,
    googleIdToken: req.query?.googleIdToken,
  });
  const { balance, configured } = await getCoinBalance(identityKey);
  if (!configured) {
    return res.status(200).json({ signedIn: !!user, coins: null, freeToday: null });
  }
  const [notesUsed, chatUsed, quizUsed] = await Promise.all([
    peekDailyCount(identityKey, 'nb-free-notes'),
    peekDailyCount(identityKey, 'nb-free-chat'),
    peekDailyCount(identityKey, 'nb-free-quiz'),
  ]);
  return res.status(200).json({
    signedIn: !!user,
    coins: balance,
    freeToday: {
      notes: Math.max(0, DAILY_FREE.notes.count - notesUsed.count), // only counts toward the 5-page size - see chargeForFeature
      chat: Math.max(0, DAILY_FREE.chat - chatUsed.count),
      quiz: Math.max(0, DAILY_FREE.quiz - quizUsed.count),
    },
  });
}
