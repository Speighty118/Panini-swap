/**
 * Ratings API endpoint.
 * Mount under /api/ratings in your main Express app.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ----------------------------------------------------------------
// POST /api/ratings
// Submit a rating after a swap is completed.
// Body: { swapId, stars, comment }
// Recomputes the ratee's rating_avg/rating_count.
// ----------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { swapId, stars, comment } = req.body;

  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'Stars must be an integer between 1 and 5' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: swapRows } = await client.query(`SELECT * FROM swaps WHERE id = $1`, [swapId]);
    const swap = swapRows[0];
    if (!swap) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap not found' });
    }
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your swap' });
    }
    if (swap.status !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Can only rate completed swaps' });
    }

    const rateeId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;

    await client.query(
      `INSERT INTO ratings (swap_id, rater_id, ratee_id, stars, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (swap_id, rater_id) DO UPDATE SET stars = $4, comment = $5`,
      [swapId, userId, rateeId, stars, comment || null]
    );

    // Recompute aggregate rating for the ratee
    const { rows: aggRows } = await client.query(
      `SELECT AVG(stars)::NUMERIC(3,2) AS avg_stars, COUNT(*) AS cnt
       FROM ratings WHERE ratee_id = $1`,
      [rateeId]
    );
    const { avg_stars, cnt } = aggRows[0];

    await client.query(
      `UPDATE users SET rating_avg = $1, rating_count = $2 WHERE id = $3`,
      [avg_stars, cnt, rateeId]
    );

    await client.query('COMMIT');

    // Let the person know they've been rated — fires after commit,
    // fire-and-forget so a notification hiccup can't undo the rating.
    try {
      const { createNotification } = require('./notifications');
      const { rows: raterRows } = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      const raterName = raterRows[0]?.name || 'Someone';
      const stars_display = '⭐'.repeat(stars);
      await createNotification(pool, {
        userId: rateeId,
        type: 'rating_received',
        title: `${stars_display} New rating from ${raterName}`,
        body: comment ? `"${comment.slice(0, 120)}"` : `${raterName} rated your swap ${stars} star${stars !== 1 ? 's' : ''}.`,
        swapId,
      });
    } catch (notifyErr) {
      console.error('Rating notification error:', notifyErr);
    }

    res.status(201).json({ success: true, newRatingAvg: avg_stars, newRatingCount: cnt });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to submit rating' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/ratings/user/:userId
// Public rating summary + recent comments for a user's profile.
// ----------------------------------------------------------------
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const { rows: userRows } = await pool.query(
      `SELECT id, name, rating_avg, rating_count FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRows[0]) return res.status(404).json({ error: 'User not found' });

    const { rows: recentRatings } = await pool.query(
      `SELECT r.stars, r.comment, r.created_at, u.name AS rater_name
       FROM ratings r
       JOIN users u ON u.id = r.rater_id
       WHERE r.ratee_id = $1
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [userId]
    );

    res.json({ ...userRows[0], recentRatings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

module.exports = router;
