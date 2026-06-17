/**
 * Admin API endpoints.
 * Mount under /api/admin.
 *
 * Not tied to the normal user auth system — gated instead by a
 * shared secret (ADMIN_SECRET env var), checked via the
 * X-Admin-Secret header. Intended for a single group admin (you),
 * not a full multi-admin role system.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// ----------------------------------------------------------------
// GET /api/admin/reported-users
// Lists users with times_reported > 0, most-reported first.
// ----------------------------------------------------------------
router.get('/reported-users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, times_reported, is_suspended, created_at
       FROM users
       WHERE times_reported > 0
       ORDER BY times_reported DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reported users' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/disputes
// Lists all disputes, optionally filtered by status.
// Query param: ?status=open|reviewing|resolved|dismissed
// ----------------------------------------------------------------
router.get('/disputes', async (req, res) => {
  const { status } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT d.*,
              raiser.name AS raised_by_name, raiser.email AS raised_by_email,
              against.name AS against_name, against.email AS against_email,
              against.times_reported AS against_times_reported,
              against.is_suspended AS against_is_suspended
       FROM disputes d
       JOIN users raiser ON raiser.id = d.raised_by_id
       JOIN users against ON against.id = d.against_id
       WHERE ($1::text IS NULL OR d.status = $1)
       ORDER BY d.created_at DESC`,
      [status || null]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/disputes/:id/status
// Body: { status }  — one of: reviewing, resolved, dismissed
// ----------------------------------------------------------------
router.post('/disputes/:id/status', async (req, res) => {
  const { status } = req.body;
  const valid = ['open', 'reviewing', 'resolved', 'dismissed'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }
  try {
    const resolvedAt = ['resolved', 'dismissed'].includes(status) ? new Date() : null;
    const { rows } = await pool.query(
      `UPDATE disputes SET status = $1, resolved_at = $2 WHERE id = $3 RETURNING *`,
      [status, resolvedAt, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Dispute not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update dispute' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/users/:id/suspend
// Body: { suspended: true | false }
// ----------------------------------------------------------------
router.post('/users/:id/suspend', async (req, res) => {
  const { suspended } = req.body;
  if (typeof suspended !== 'boolean') {
    return res.status(400).json({ error: 'suspended must be true or false' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_suspended = $1 WHERE id = $2 RETURNING id, name, email, is_suspended`,
      [suspended, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update suspension status' });
  }
});

module.exports = router;
