/**
 * Web Push API endpoints.
 * Handles push subscription storage, install tracking,
 * and sending push notifications to users.
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./middleware/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Lazily initialise web-push so the server doesn't crash if
// VAPID keys haven't been set yet during initial deploy.
function getWebPush() {
  const webpush = require('web-push');
  webpush.setVapidDetails(
    'mailto:hello@gotonespare.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return webpush;
}

// ----------------------------------------------------------------
// GET /api/push/vapid-public-key
// Returns the public VAPID key so the frontend can subscribe.
// ----------------------------------------------------------------
router.get('/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// ----------------------------------------------------------------
// POST /api/push/subscribe
// Saves a push subscription for the current user.
// Also records that they have the PWA installed.
// Body: { subscription, isStandalone }
// ----------------------------------------------------------------
router.post('/subscribe', requireAuth, async (req, res) => {
  const { subscription, isStandalone } = req.body;
  console.log(`[PUSH SUBSCRIBE] userId=${req.user.id} isStandalone=${isStandalone} hasEndpoint=${!!subscription?.endpoint}`);
  if (!subscription || !subscription.endpoint) {
    console.log('[PUSH SUBSCRIBE] Invalid subscription - missing endpoint');
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    await pool.query(
      `UPDATE users
       SET push_subscription = $1,
           pwa_installed_at = CASE WHEN pwa_installed_at IS NULL AND $2 THEN NOW() ELSE pwa_installed_at END
       WHERE id = $3`,
      [JSON.stringify(subscription), isStandalone === true, req.user.id]
    );
    console.log(`[PUSH SUBSCRIBE] Success for userId=${req.user.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH SUBSCRIBE] Error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// ----------------------------------------------------------------
// POST /api/push/track-install
// Records that the user opened the app in standalone mode
// (i.e. from home screen). Called on app load if standalone.
// ----------------------------------------------------------------
router.post('/track-install', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET pwa_installed_at = COALESCE(pwa_installed_at, NOW()) WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to track install' });
  }
});

// ----------------------------------------------------------------
// sendPushNotification — internal helper used by swap endpoints.
// Exported for use in swaps.js and other routes.
// ----------------------------------------------------------------
async function sendPushNotification(userId, { title, body, url = '/' }) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const { rows } = await pool.query(
      `SELECT push_subscription FROM users WHERE id = $1 AND push_subscription IS NOT NULL`,
      [userId]
    );
    if (!rows[0]?.push_subscription) return;
    const subscription = typeof rows[0].push_subscription === 'string'
      ? JSON.parse(rows[0].push_subscription)
      : rows[0].push_subscription;
    const webpush = getWebPush();
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url }));
  } catch (err) {
    // Subscription expired or invalid — clear it
    if (err.statusCode === 410 || err.statusCode === 404) {
      await pool.query(`UPDATE users SET push_subscription = NULL WHERE id = $1`, [userId]).catch(() => {});
    }
    console.error('Push send error:', err.message);
  }
}

module.exports = router;
module.exports.sendPushNotification = sendPushNotification;
