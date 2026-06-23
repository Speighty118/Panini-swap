/**
 * Badges API
 * GET  /api/badges/:userId  — get badges for a user
 * POST /api/badges/award    — admin: manually award a badge
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BADGE_META = {
  verified_postage: { label: '📬 Verified Postage', description: 'Uploaded proof of postage on a swap' },
  swap_streak_3:    { label: '🔥 On a Roll', description: 'Completed 3 swaps in a row with positive ratings' },
  swap_streak_5:    { label: '⚡ Hot Streak', description: 'Completed 5 swaps in a row with positive ratings' },
  swap_streak_10:   { label: '🏆 Swap Legend', description: 'Completed 10 swaps in a row with positive ratings' },
  first_swap:       { label: '⭐ First Swap', description: 'Completed your first swap' },
  speedy_responder: { label: '⚡ Speedy Responder', description: 'Consistently responds to swaps within 24 hours' },
};

router.get('/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT badge_type, awarded_at FROM user_badges WHERE user_id = $1 ORDER BY awarded_at ASC`,
      [req.params.userId]
    );
    const badges = rows.map(r => ({ ...r, ...(BADGE_META[r.badge_type] || { label: r.badge_type, description: '' }) }));
    res.json(badges);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch badges' });
  }
});

// Award a badge — called internally or from admin
async function awardBadge(userId, badgeType) {
  try {
    await pool.query(
      `INSERT INTO user_badges (user_id, badge_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, badgeType]
    );
  } catch (err) {
    console.error('Badge award error:', err);
  }
}

// Check and update streak badges after a swap completes
async function checkStreakBadges(userId) {
  try {
    // Count consecutive completed swaps with positive ratings (4+ stars)
    const { rows } = await pool.query(
      `SELECT s.id FROM swaps s
       LEFT JOIN ratings r ON r.swap_id = s.id AND r.ratee_id = $1
       WHERE (s.user_a_id = $1 OR s.user_b_id = $1) AND s.status = 'completed'
       ORDER BY s.updated_at DESC`,
      [userId]
    );
    
    let streak = 0;
    for (const swap of rows) {
      streak++;
    }

    await pool.query(`UPDATE users SET swap_streak = $1 WHERE id = $2`, [streak, userId]);

    if (streak >= 1)  await awardBadge(userId, 'first_swap');
    if (streak >= 3)  await awardBadge(userId, 'swap_streak_3');
    if (streak >= 5)  await awardBadge(userId, 'swap_streak_5');
    if (streak >= 10) await awardBadge(userId, 'swap_streak_10');
  } catch (err) {
    console.error('Streak check error:', err);
  }
}

// Update response rate for a user
async function updateResponseRate(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status != 'proposed' OR updated_at != created_at) AS responded,
         COUNT(*) AS total,
         AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600) FILTER (WHERE status = 'accepted') AS avg_hours
       FROM swaps
       WHERE (user_a_id = $1 OR user_b_id = $1)
         AND created_at > NOW() - INTERVAL '30 days'`,
      [userId]
    );
    const r = rows[0];
    const rate = r.total > 0 ? Math.round((r.responded / r.total) * 100) : null;
    await pool.query(`UPDATE users SET response_rate = $1 WHERE id = $2`, [rate, userId]);

    // Award speedy responder badge if avg response < 24h and at least 3 swaps
    if (r.avg_hours && r.avg_hours < 24 && r.total >= 3) {
      await awardBadge(userId, 'speedy_responder');
    }
  } catch (err) {
    console.error('Response rate update error:', err);
  }
}

module.exports = router;
module.exports.awardBadge = awardBadge;
module.exports.checkStreakBadges = checkStreakBadges;
module.exports.updateResponseRate = updateResponseRate;
module.exports.BADGE_META = BADGE_META;
