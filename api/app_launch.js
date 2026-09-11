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
// POST /api/app-launch/track-click
// Fire-and-forget from the website when someone taps a "Download on
// the App Store" link — the floating iOS widget or the dashboard
// banner. Best-effort: a tracking beacon must never block or fail
// the actual link, so this always returns 200.
// Body: { source } — 'widget' | 'banner'
// ----------------------------------------------------------------
router.post('/track-click', requireAuth, async (req, res) => {
  const source = ['widget', 'banner'].includes(req.body?.source) ? req.body.source : 'unknown';
  try {
    await pool.query(
      `INSERT INTO appstore_clicks (source, user_id) VALUES ($1, $2)`,
      [source, req.user.id]
    );
  } catch (err) {
    console.error('App Store click track error:', err.message);
  }
  res.json({ ok: true });
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

// GET /api/app-launch/admin/click-stats — App Store link click totals
router.get('/admin/click-stats', requireAdmin, async (req, res) => {
  try {
    const [totals, daily] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE source = 'widget') AS widget,
          COUNT(*) FILTER (WHERE source = 'banner') AS banner,
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today,
          COUNT(DISTINCT user_id) AS unique_users
        FROM appstore_clicks
      `),
      pool.query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS count
        FROM appstore_clicks
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY date ASC
      `),
    ]);
    const t = totals.rows[0];
    res.json({
      total: parseInt(t.total, 10),
      widget: parseInt(t.widget, 10),
      banner: parseInt(t.banner, 10),
      today: parseInt(t.today, 10),
      uniqueUsers: parseInt(t.unique_users, 10),
      daily: daily.rows,
    });
  } catch (err) {
    console.error('App Store click stats error:', err.message);
    res.status(500).json({ error: 'Failed to load click stats' });
  }
});

// ----------------------------------------------------------------
// GET /api/app-launch/admin/launch-email-progress
// How the iOS-launch email campaign is going: sent so far, how many
// verified users are still left to reach.
// ----------------------------------------------------------------
router.get('/admin/launch-email-progress', requireAdmin, async (req, res) => {
  try {
    const [sentRes, remainingRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE ios_launch_email_sent_at IS NOT NULL`),
      pool.query(`
        SELECT COUNT(*) FROM users
        WHERE is_suspended = FALSE AND email_verified = TRUE AND ios_launch_email_sent_at IS NULL
      `),
    ]);
    res.json({
      sent: parseInt(sentRes.rows[0].count, 10),
      remaining: parseInt(remainingRes.rows[0].count, 10),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load campaign progress' });
  }
});

// ----------------------------------------------------------------
// POST /api/app-launch/admin/send-launch-batch
// Sends the iOS-launch email to the next batch of verified users who
// haven't had it yet, most-likely-to-act-on-it first: people who
// explicitly asked to be notified, then most-recently-active. Body:
// { limit } — defaults to 80, deliberately under Resend's 100/day
// free-tier cap so there's daily headroom left for transactional
// email (password resets, verification, swap notifications).
// Safe to call once a day until "remaining" hits 0.
// ----------------------------------------------------------------
async function sendNextLaunchBatch(limit = 80) {
  const safeLimit = Math.min(limit, 200);
  const { rows: batch } = await pool.query(
    `SELECT id, name, email FROM users
     WHERE is_suspended = FALSE AND email_verified = TRUE AND ios_launch_email_sent_at IS NULL
     ORDER BY notify_app_launch DESC, last_login_at DESC NULLS LAST
     LIMIT $1`,
    [safeLimit]
  );

  let sent = 0;
  const failed = [];
  for (const user of batch) {
    try {
      await sendAppLaunchEmail(user.email, user.name);
      await pool.query(
        `UPDATE users SET ios_launch_email_sent_at = NOW(), notify_app_launch = FALSE WHERE id = $1`,
        [user.id]
      );
      sent++;
    } catch (err) {
      console.error(`iOS launch email failed for user ${user.id}:`, err.message);
      failed.push(user.id);
    }
  }

  const { rows: remainingRows } = await pool.query(
    `SELECT COUNT(*) FROM users WHERE is_suspended = FALSE AND email_verified = TRUE AND ios_launch_email_sent_at IS NULL`
  );

  return { sent, failed: failed.length, batchSize: batch.length, remaining: parseInt(remainingRows[0].count, 10) };
}

router.post('/admin/send-launch-batch', requireAdmin, async (req, res) => {
  const limit = parseInt(req.body?.limit, 10) || 80;
  try {
    res.json(await sendNextLaunchBatch(limit));
  } catch (err) {
    console.error('iOS launch batch send error:', err.message);
    res.status(500).json({ error: 'Failed to send batch' });
  }
});

// POST /api/app-launch/admin/announce-launch — emails everyone who
// registered interest, then clears the flag.
router.post('/admin/announce-launch', requireAdmin, async (req, res) => {
  try {
    // Skip anyone already covered by the broader launch-email batch
    // campaign below, so this button and that one can't double-send.
    const { rows: interested } = await pool.query(
      `SELECT id, name, email FROM users WHERE notify_app_launch = TRUE AND ios_launch_email_sent_at IS NULL`
    );

    let sent = 0;
    for (const user of interested) {
      try {
        await sendAppLaunchEmail(user.email, user.name);
        await pool.query(`UPDATE users SET ios_launch_email_sent_at = NOW() WHERE id = $1`, [user.id]);
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
module.exports.sendNextLaunchBatch = sendNextLaunchBatch;
