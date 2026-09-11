/**
 * Web Push API endpoints.
 * Handles push subscription storage, install tracking,
 * and sending push notifications to users.
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
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
// APNs (native iOS push) — a from-scratch HTTP/2 client since Apple
// only speaks HTTP/2 for the modern token-based APNs API. Needs
// three env vars from the Apple Developer account: APNS_KEY_ID,
// APNS_TEAM_ID, and APNS_AUTH_KEY (the raw .p8 file contents, with
// real newlines - if pasted as a single Railway variable line,
// escaped \n is fine too, handled below). Silently disabled if any
// are missing, same "don't crash the server" approach as web-push.
// ----------------------------------------------------------------
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.gotonespare.app';
const APNS_HOST = process.env.APNS_PRODUCTION === 'false'
  ? 'https://api.sandbox.push.apple.com'
  : 'https://api.push.apple.com';

let cachedApnsJwt = null;
let cachedApnsJwtAt = 0;

function apnsConfigured() {
  return Boolean(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_AUTH_KEY);
}

function getApnsJwt() {
  // Apple asks that this token be reused rather than regenerated on
  // every request - refresh at 50 minutes, well under their 1 hour cap.
  if (cachedApnsJwt && Date.now() - cachedApnsJwtAt < 50 * 60 * 1000) return cachedApnsJwt;
  const privateKey = process.env.APNS_AUTH_KEY.replace(/\\n/g, '\n');
  cachedApnsJwt = jwt.sign(
    { iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: process.env.APNS_KEY_ID } }
  );
  cachedApnsJwtAt = Date.now();
  return cachedApnsJwt;
}

function sendApnsNotification(deviceToken, { title, body, badgeCount = 1 }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(APNS_HOST);
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${getApnsJwt()}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });

    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      client.close();
      if (status === 200) resolve({ success: true });
      else reject(Object.assign(new Error(`APNs ${status}: ${data}`), { apnsStatus: status, apnsBody: data }));
    });
    req.on('error', (err) => { client.close(); reject(err); });

    req.end(JSON.stringify({
      aps: { alert: { title, body }, sound: 'default', badge: badgeCount },
    }));
  });
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
// POST /api/push/register-device
// Saves the APNs device token for the native iOS app. Separate from
// /subscribe above, which is the web-push (VAPID) path — a user can
// have both a browser subscription and a native device token at once.
// Body: { deviceToken }
// ----------------------------------------------------------------
router.post('/register-device', requireAuth, async (req, res) => {
  const { deviceToken } = req.body;
  if (!deviceToken) return res.status(400).json({ error: 'deviceToken is required' });
  try {
    await pool.query(`UPDATE users SET apns_device_token = $1 WHERE id = $2`, [deviceToken, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH register-device] Error:', err.message);
    res.status(500).json({ error: 'Failed to save device token' });
  }
});

// ----------------------------------------------------------------
// sendPushNotification — internal helper used by swap endpoints.
// Exported for use in swaps.js and other routes. Sends to whichever
// channels a user has: a web-push (VAPID) subscription, a native
// APNs device token, or both — they're independent, not either/or.
// ----------------------------------------------------------------
async function sendPushNotification(userId, { title, body, url = '/', badgeCount = 1 }) {
  const { rows } = await pool.query(
    `SELECT push_subscription, apns_device_token FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];
  if (!user) return;

  if (user.push_subscription && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    try {
      const subscription = typeof user.push_subscription === 'string'
        ? JSON.parse(user.push_subscription)
        : user.push_subscription;
      const webpush = getWebPush();
      await webpush.sendNotification(subscription, JSON.stringify({ title, body, url, badgeCount }));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query(`UPDATE users SET push_subscription = NULL WHERE id = $1`, [userId]).catch(() => {});
      }
      console.error('Web push send error:', err.message);
    }
  }

  if (user.apns_device_token && apnsConfigured()) {
    try {
      await sendApnsNotification(user.apns_device_token, { title, body, badgeCount });
    } catch (err) {
      // BadDeviceToken / Unregistered — the app was reinstalled or
      // uninstalled since this token was issued; clear it.
      if (err.apnsStatus === 400 || err.apnsStatus === 410) {
        await pool.query(`UPDATE users SET apns_device_token = NULL WHERE id = $1`, [userId]).catch(() => {});
      }
      console.error('APNs send error:', err.message);
    }
  }
}

module.exports = router;
module.exports.sendPushNotification = sendPushNotification;
