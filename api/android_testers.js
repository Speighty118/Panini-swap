/**
 * Android closed-testing tester recruitment — web-only widget lets
 * logged-in users volunteer their Google/Play Store email so they can
 * be added to the Play Console closed testing track (needs 12 opted-in
 * testers for 14 days before Google unlocks production access).
 *
 * This just collects a lead list into the admin dashboard — it does
 * NOT auto-add testers to Play Console (would need extra Google API
 * integration). The admin copies emails from here into Play Console's
 * tester list and shares the opt-in URL manually.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { requireAuth } = require('./middleware/auth');

const MAX_SIGNUPS = 20;

// ----------------------------------------------------------------
// GET /api/android-testers/status
// Spots remaining, whether full, whether this user already signed up.
// ----------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM android_tester_signups`);
    const count = parseInt(countRows[0].count, 10);
    const { rows: mine } = await pool.query(
      `SELECT id FROM android_tester_signups WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({
      spotsRemaining: Math.max(0, MAX_SIGNUPS - count),
      full: count >= MAX_SIGNUPS,
      signedUp: mine.length > 0,
    });
  } catch (err) {
    console.error('Android tester status error:', err.message);
    res.status(500).json({ error: 'Failed to load status' });
  }
});

// ----------------------------------------------------------------
// POST /api/android-testers/signup
// Body: { googleEmail }
// ----------------------------------------------------------------
router.post('/signup', requireAuth, async (req, res) => {
  try {
    const googleEmail = (req.body.googleEmail || '').trim().toLowerCase();
    if (!googleEmail || !googleEmail.includes('@')) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM android_tester_signups`);
    if (parseInt(countRows[0].count, 10) >= MAX_SIGNUPS) {
      return res.status(400).json({ error: 'All tester spots are full — thanks for your interest!' });
    }

    await pool.query(
      `INSERT INTO android_tester_signups (user_id, google_email) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET google_email = $2`,
      [req.user.id, googleEmail]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Android tester signup error:', err.message);
    res.status(500).json({ error: 'Failed to sign up' });
  }
});

// ----------------------------------------------------------------
// Admin endpoints — self-contained, same pattern as app_launch.js
// ----------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/android-testers/admin/list
router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ats.id, u.name, u.email AS account_email, ats.google_email, ats.created_at
       FROM android_tester_signups ats
       JOIN users u ON u.id = ats.user_id
       ORDER BY ats.created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tester list' });
  }
});

module.exports = router;
