/**
 * No-show reports API
 * POST /api/reports          — file a no-show report
 * GET  /api/reports          — admin: list all reports
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { requireAuth } = require('./middleware/auth');

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/reports — file a no-show report
router.post('/', async (req, res) => {
  const reporterId = req.user.id;
  const { swapId, notes } = req.body;

  try {
    // Verify this is a real swap the reporter was part of
    const { rows: swapRows } = await pool.query(
      `SELECT * FROM swaps WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)`,
      [swapId, reporterId]
    );
    const swap = swapRows[0];
    if (!swap) return res.status(404).json({ error: 'Swap not found' });
    if (!['posted', 'accepted'].includes(swap.status)) {
      return res.status(400).json({ error: 'Can only report no-shows on swaps that have been posted' });
    }

    const reportedUserId = swap.user_a_id === reporterId ? swap.user_b_id : swap.user_a_id;

    await pool.query(
      `INSERT INTO no_show_reports (reporter_id, reported_user_id, swap_id, notes)
       VALUES ($1, $2, $3, $4)`,
      [reporterId, reportedUserId, swapId, notes || null]
    );

    // Increment times_reported on the reported user
    await pool.query(
      `UPDATE users SET times_reported = COALESCE(times_reported, 0) + 1 WHERE id = $1`,
      [reportedUserId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to file report' });
  }
});

// GET /api/reports/mine — reports the logged-in user has filed themselves
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.swap_id, r.notes, r.created_at,
              u.name AS reported_name
       FROM no_show_reports r
       JOIN users u ON u.id = r.reported_user_id
       WHERE r.reporter_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your reports' });
  }
});

// DELETE /api/reports/:id — withdraw a report you filed yourself.
// Only the original reporter can withdraw it — not the reported user,
// not anyone else. Decrements times_reported, floored at 0.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM no_show_reports WHERE id = $1`, [req.params.id]);
    const report = rows[0];
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.reporter_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only withdraw a report you filed yourself' });
    }

    await pool.query(`DELETE FROM no_show_reports WHERE id = $1`, [req.params.id]);
    await pool.query(
      `UPDATE users SET times_reported = GREATEST(COALESCE(times_reported, 0) - 1, 0) WHERE id = $1`,
      [report.reported_user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw report' });
  }
});

// GET /api/reports — admin only
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              u1.name AS reporter_name, u1.email AS reporter_email,
              u2.name AS reported_name, u2.email AS reported_email,
              u2.times_reported AS total_reports_against
       FROM no_show_reports r
       JOIN users u1 ON u1.id = r.reporter_id
       JOIN users u2 ON u2.id = r.reported_user_id
       ORDER BY r.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

module.exports = router;
