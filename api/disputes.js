
/**
 * Disputes API endpoints.
 * Mount under /api/disputes.
 *
 * Lets either party in a swap flag a problem (no-show, wrong item,
 * never received, etc). Notifies the other party by email and
 * surfaces the dispute for admin review.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');
const { sendDisputeNotification } = require('./email');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

router.use(requireAuth);

const VALID_REASONS = ['never_posted', 'never_received', 'wrong_item', 'no_response', 'other'];

// ----------------------------------------------------------------
// POST /api/disputes
// Body: { swapId, reason, details }
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { swapId, reason, details } = req.body;

  if (!swapId || !VALID_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${VALID_REASONS.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: swapRows } = await client.query('SELECT * FROM swaps WHERE id = $1', [swapId]);
    const swap = swapRows[0];
    if (!swap) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap not found' });
    }
    if (swap.user_a_id !== userId && swap.user_b_id !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your swap' });
    }

    const againstId = swap.user_a_id === userId ? swap.user_b_id : swap.user_a_id;

    const { rows: disputeRows } = await client.query(
      `INSERT INTO disputes (swap_id, raised_by_id, against_id, reason, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [swapId, userId, againstId, reason, details || null]
    );

    await client.query(
      `UPDATE users SET times_reported = times_reported + 1 WHERE id = $1`,
      [againstId]
    );

    await client.query(`UPDATE swaps SET status = 'disputed', updated_at = NOW() WHERE id = $1`, [swapId]);

    await client.query('COMMIT');

    // Notify the other party — best-effort, don't fail the request if email fails
    try {
      const { rows: againstUserRows } = await pool.query('SELECT name, email FROM users WHERE id = $1', [againstId]);
      const againstUser = againstUserRows[0];
      if (againstUser) {
        await sendDisputeNotification(againstUser.email, againstUser.name, swapId, reason);
      }
    } catch (emailErr) {
      console.error('Failed to send dispute notification:', emailErr);
    }

    res.status(201).json(disputeRows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to file dispute' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/disputes/me
// List disputes the logged-in user is involved in (either side).
// ----------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, 
              raiser.name AS raised_by_name,
              against.name AS against_name
       FROM disputes d
       JOIN users raiser ON raiser.id = d.raised_by_id
       JOIN users against ON against.id = d.against_id
       WHERE d.raised_by_id = $1 OR d.against_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

module.exports = router;
