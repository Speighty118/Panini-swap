/**
 * Ambassador badge API.
 * Users submit a Facebook post link for review.
 * Admin can approve or reject from the dashboard.
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/ambassador/status — current user's ambassador status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.status, s.submitted_at, u.ambassador_badge
       FROM users u
       LEFT JOIN ambassador_submissions s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const row = rows[0];
    res.json({
      status: row?.ambassador_badge ? 'approved' : (row?.status || null),
      submittedAt: row?.submitted_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// POST /api/ambassador/submit — submit for review
router.post('/submit', requireAuth, async (req, res) => {
  const { swapId } = req.body;
  try {
    // Check not already submitted
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM ambassador_submissions WHERE user_id = $1`,
      [req.user.id]
    );
    if (existing[0]?.status === 'approved') {
      return res.status(400).json({ error: 'Already approved' });
    }
    if (existing[0]?.status === 'pending') {
      return res.json({ success: true, status: 'pending' });
    }

    await pool.query(
      `INSERT INTO ambassador_submissions (user_id, swap_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id) DO UPDATE SET status = 'pending', submitted_at = NOW(), swap_id = EXCLUDED.swap_id`,
      [req.user.id, swapId || null]
    );
    res.json({ success: true, status: 'pending' });
  } catch (err) {
    console.error('Ambassador submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// GET /api/ambassador/admin/pending — list pending submissions for admin
router.get('/admin/pending', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.swap_id, s.status, s.submitted_at,
              u.name, u.email
       FROM ambassador_submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'pending'
       ORDER BY s.submitted_at ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// POST /api/ambassador/admin/:id/approve — approve and award badge
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE ambassador_submissions SET status = 'approved', reviewed_at = NOW()
       WHERE id = $1 RETURNING user_id`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    await pool.query(
      `UPDATE users SET ambassador_badge = true, ambassador_badge_earned_at = NOW() WHERE id = $1`,
      [rows[0].user_id]
    );

    // Notify the user
    const { createNotification } = require('./notifications');
    await createNotification(pool, {
      userId: rows[0].user_id,
      type: 'ambassador_approved',
      title: '🏅 Ambassador badge awarded!',
      body: 'Your Facebook post has been verified. Thanks for spreading the word!',
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Ambassador approve error:', err.message);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// POST /api/ambassador/admin/:id/reject — reject submission
router.post('/admin/:id/reject', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE ambassador_submissions SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject' });
  }
});

// ----------------------------------------------------------------
// GET /api/ambassador/admin/awarded — list everyone currently
// holding the badge, most recently awarded first.
// ----------------------------------------------------------------
router.get('/admin/awarded', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, ambassador_badge_earned_at
       FROM users
       WHERE ambassador_badge = TRUE
       ORDER BY ambassador_badge_earned_at DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load awarded ambassadors' });
  }
});

// ----------------------------------------------------------------
// POST /api/ambassador/admin/:userId/revoke — remove the badge
// ----------------------------------------------------------------
router.post('/admin/:userId/revoke', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ambassador_badge = FALSE, ambassador_badge_earned_at = NULL
       WHERE id = $1 RETURNING id, name`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    // Mark their submission as revoked too, so /submit doesn't treat
    // them as still-approved and block a future resubmission.
    await pool.query(
      `UPDATE ambassador_submissions SET status = 'revoked', reviewed_at = NOW() WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true, name: rows[0].name });
  } catch (err) {
    console.error('Ambassador revoke error:', err.message);
    res.status(500).json({ error: 'Failed to revoke badge' });
  }
});

module.exports = router;
