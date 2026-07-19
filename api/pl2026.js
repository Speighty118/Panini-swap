/**
 * Topps Premier League 2026 — "coming soon" interest teaser.
 *
 * No email capture — reuses the in-app notification system. When
 * you're ready to launch, call the admin announce endpoint below and
 * everyone who tapped "Notify me" gets a notification + push alert.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { requireAuth } = require('./middleware/auth');
const { createNotification } = require('./notifications');
const { sendPushNotification } = require('./push');

// ----------------------------------------------------------------
// GET /api/pl2026/status
// Whether the logged-in user has already asked to be notified.
// ----------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT notify_pl2026 FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({ notified: Boolean(rows[0]?.notify_pl2026) });
  } catch (err) {
    console.error('PL2026 status error:', err.message);
    res.status(500).json({ error: 'Failed to load status' });
  }
});

// ----------------------------------------------------------------
// POST /api/pl2026/notify
// Registers interest — no email, just flags the account so a
// notification can be sent when the collection actually launches.
// ----------------------------------------------------------------
router.post('/notify', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET notify_pl2026 = TRUE WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PL2026 notify error:', err.message);
    res.status(500).json({ error: 'Failed to register interest' });
  }
});

// ----------------------------------------------------------------
// Admin endpoints — self-contained here (same pattern as founder.js)
// so this doesn't need to touch admin.js at all.
// ----------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/pl2026/admin/count — how many people are waiting
router.get('/admin/count', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM users WHERE notify_pl2026 = TRUE`
    );
    res.json({ count: parseInt(rows[0].count, 10) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load count' });
  }
});

// POST /api/pl2026/admin/announce-launch — notifies everyone who
// registered interest, then clears the flag so it can be reused for
// a future collection later without re-notifying these same people.
router.post('/admin/announce-launch', requireAdmin, async (req, res) => {
  try {
    const { rows: interested } = await pool.query(
      `SELECT id FROM users WHERE notify_pl2026 = TRUE`
    );

    for (const user of interested) {
      await createNotification(pool, {
        userId: user.id,
        type: 'announcement',
        title: '⚽ Topps Premier League 2026 is here!',
        body: 'The collection you were waiting for has launched — add your spares and needs to start swapping.',
      }).catch(() => {});
      sendPushNotification(user.id, {
        title: '⚽ Topps Premier League 2026 is here!',
        body: 'Add your spares and needs to start swapping.',
      }).catch(() => {});
    }

    await pool.query(`UPDATE users SET notify_pl2026 = FALSE WHERE notify_pl2026 = TRUE`);

    res.json({ success: true, notified: interested.length });
  } catch (err) {
    console.error('PL2026 announce error:', err.message);
    res.status(500).json({ error: 'Failed to send launch announcement' });
  }
});

module.exports = router;
