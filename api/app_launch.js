/**
 * iOS / Android app launch — "coming soon" interest capture.
 *
 * Web-only feature: users register interest via a banner (hidden in
 * the native apps themselves) and get emailed once the apps go live.
 * Same shape as pl2026.js, but emails instead of in-app notifications
 * since these users may not open the web app again once the native
 * apps exist.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { requireAuth } = require('./middleware/auth');
const { sendAppLaunchEmail } = require('./email');

// ----------------------------------------------------------------
// GET /api/app-launch/status
// Whether the logged-in user has already asked to be notified.
// ----------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT notify_app_launch FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({ notified: Boolean(rows[0]?.notify_app_launch) });
  } catch (err) {
    console.error('App launch status error:', err.message);
    res.status(500).json({ error: 'Failed to load status' });
  }
});

// ----------------------------------------------------------------
// POST /api/app-launch/notify
// Registers interest using the account's existing email.
// ----------------------------------------------------------------
router.post('/notify', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET notify_app_launch = TRUE WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('App launch notify error:', err.message);
    res.status(500).json({ error: 'Failed to register interest' });
  }
});

// ----------------------------------------------------------------
// Admin endpoints — self-contained here (same pattern as pl2026.js)
// so this doesn't need to touch admin.js at all.
// ----------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/app-launch/admin/count — how many people are waiting
router.get('/admin/count', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM users WHERE notify_app_launch = TRUE`
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load count' });
  }
});

// GET /api/app-launch/admin/list — who's actually on the waiting list
router.get('/admin/list', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE notify_app_launch = TRUE ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load waiting list' });
  }
});

// POST /api/app-launch/admin/announce-launch — emails everyone who
// registered interest, then clears the flag.
router.post('/admin/announce-launch', requireAdmin, async (req, res) => {
  try {
    const { rows: interested } = await pool.query(
      `SELECT id, name, email FROM users WHERE notify_app_launch = TRUE`
    );

    let sent = 0;
    for (const user of interested) {
      try {
        await sendAppLaunchEmail(user.email, user.name);
        sent++;
      } catch (err) {
        console.error(`App launch email failed for user ${user.id}:`, err.message);
      }
    }

    await pool.query(`UPDATE users SET notify_app_launch = FALSE WHERE notify_app_launch = TRUE`);

    res.json({ success: true, notified: sent, total: interested.length });
  } catch (err) {
    console.error('App launch announce error:', err.message);
    res.status(500).json({ error: 'Failed to send launch announcement' });
  }
});

module.exports = router;
