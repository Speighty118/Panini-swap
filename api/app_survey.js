/**
 * App interest survey API.
 *
 * GET  /api/app-survey/me      — whether the logged-in user has already
 *                                 answered, and what they said
 * POST /api/app-survey/submit  — submit or update their answers
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PHONE_OS_VALUES = ['ios', 'android', 'neither'];

// ----------------------------------------------------------------
// GET /api/app-survey/me
// ----------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wants_app, phone_os FROM app_interest_survey WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({
      answered: rows.length > 0,
      wantsApp: rows.length > 0 ? rows[0].wants_app : null,
      phoneOs: rows.length > 0 ? rows[0].phone_os : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch survey answer' });
  }
});

// ----------------------------------------------------------------
// POST /api/app-survey/submit
// Body: { wantsApp: boolean, phoneOs: 'ios' | 'android' | 'neither' }
// Upserts — answers can be changed like the old collection votes could.
// ----------------------------------------------------------------
router.post('/submit', requireAuth, async (req, res) => {
  const { wantsApp, phoneOs } = req.body;
  if (typeof wantsApp !== 'boolean') {
    return res.status(400).json({ error: 'wantsApp must be true or false' });
  }
  if (!PHONE_OS_VALUES.includes(phoneOs)) {
    return res.status(400).json({ error: 'phoneOs must be one of: ios, android, neither' });
  }
  try {
    await pool.query(
      `INSERT INTO app_interest_survey (user_id, wants_app, phone_os, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET wants_app = $2, phone_os = $3, updated_at = NOW()`,
      [req.user.id, wantsApp, phoneOs]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save survey answer' });
  }
});

module.exports = router;
