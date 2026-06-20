/**
 * Invite codes API.
 * 
 * Admin endpoints (require ADMIN_SECRET header):
 *   POST /api/invites/generate  — generate N invite codes
 *   GET  /api/invites           — list all codes with usage status
 *   DELETE /api/invites/:id     — revoke an unused code
 * 
 * Public endpoint:
 *   POST /api/invites/validate  — check a code is valid (used at signup)
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ----------------------------------------------------------------
// POST /api/invites/validate
// Public — called during signup to check a code is valid.
// Does NOT consume the code yet (that happens in auth.js on signup).
// ----------------------------------------------------------------
router.post('/validate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  // If invite-only mode is off, all codes are "valid"
  if (process.env.INVITE_ONLY !== 'true') {
    return res.json({ valid: true, inviteRequired: false });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id FROM invite_codes WHERE code = $1 AND used_at IS NULL`,
      [code.trim().toUpperCase()]
    );
    res.json({ valid: rows.length > 0, inviteRequired: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to validate code' });
  }
});

// ----------------------------------------------------------------
// POST /api/invites/generate
// Admin — generate N invite codes (default 10).
// ----------------------------------------------------------------
router.post('/generate', requireAdmin, async (req, res) => {
  const count = Math.min(parseInt(req.body.count || 1), 100);
  const createdBy = req.body.createdBy || 'admin';
  try {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const { rows } = await pool.query(
        `INSERT INTO invite_codes (code, created_by) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code`,
        [code, createdBy]
      );
      if (rows[0]) codes.push(rows[0].code);
    }
    res.json({ codes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate codes' });
  }
});

// ----------------------------------------------------------------
// GET /api/invites
// Admin — list all invite codes with usage status.
// ----------------------------------------------------------------
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS used_by_name, u.email AS used_by_email
       FROM invite_codes i
       LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch codes' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/invites/:id
// Admin — revoke an unused invite code.
// ----------------------------------------------------------------
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM invite_codes WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Code not found or already used' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revoke code' });
  }
});

module.exports = router;
