// api/stats.js - read-only: the homepage trust counters (Notes Generated,
// Ebooks Created, Quiz Solved, Active Users). See lib/stats.js for the
// storage/caching/formatting details. No auth needed — these are public
// numbers shown to every visitor, signed in or not.
import { getStats } from '../lib/stats.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  const stats = await getStats();
  if (!stats) return res.status(200).json({ configured: false }); // Upstash not set up - frontend should just hide the counters, not show zeros
  return res.status(200).json({ configured: true, ...stats });
}
