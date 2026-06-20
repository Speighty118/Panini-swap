/**
 * Feedback API.
 * 
 * POST /api/feedback  — submit feedback (auth optional)
 * GET  /api/feedback  — list all feedback (admin only)
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ----------------------------------------------------------------
// POST /api/feedback
// Submit feedback. Auth optional — logged-in users are identified,
// logged-out users can still submit anonymously.
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  const { message, page } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
  }

  // Try to get user_id from auth header if present, but don't require it
  let userId = null;
  try {
    const jwt = require('jsonwebtoken');
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      userId = decoded.userId;
    }
  } catch {
    // Not logged in or invalid token — that's fine, still accept feedback
  }

  try {
    await pool.query(
      `INSERT INTO feedback (user_id, message, page) VALUES ($1, $2, $3)`,
      [userId, message.trim(), page || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ----------------------------------------------------------------
// GET /api/feedback
// Admin only — list all feedback submissions.
// ----------------------------------------------------------------
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.name AS user_name, u.email AS user_email
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       ORDER BY f.created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

module.exports = router;
