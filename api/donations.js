/**
 * Donation tracking API.
 * 
 * POST /api/donations/click  — log a donate button click before redirecting
 * GET  /api/donations         — admin only, list all clicks
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

// ----------------------------------------------------------------
// POST /api/donations/click
// Log a donate button click. Auth optional — logged-in users are
// identified, anonymous clicks are still tracked by location.
// Body: { location }  — e.g. 'swap_confirmed', 'dashboard', 'footer'
// ----------------------------------------------------------------
router.post('/click', async (req, res) => {
  const { location } = req.body;

  let userId = null;
  let userName = null;
  let userEmail = null;
  try {
    const jwt = require('jsonwebtoken');
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      userId = decoded.userId;
      const { rows } = await pool.query(
        `SELECT name, email FROM users WHERE id = $1`,
        [userId]
      );
      if (rows[0]) { userName = rows[0].name; userEmail = rows[0].email; }
    }
  } catch { /* anonymous click, fine */ }

  try {
    await pool.query(
      `INSERT INTO donation_clicks (user_id, user_name, user_email, location, clicked_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, userName, userEmail, location || 'unknown']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Donation click log error:', err);
    res.json({ success: true }); // don't block the redirect on a logging error
  }
});

// ----------------------------------------------------------------
// GET /api/donations
// Admin only — all donation clicks with user info.
// ----------------------------------------------------------------
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM donation_clicks ORDER BY clicked_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch donation clicks' });
  }
});

module.exports = router;
