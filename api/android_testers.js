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
const { createNotification } = require('./notifications');
const { sendPushNotification } = require('./push');
const { sendAndroidTesterRecruitmentEmail } = require('./email');

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
// GET /api/android-testers/public-status
// Same as /status but no login required — for the standalone
// gotonespare.com/android-testers page reached from the recruitment
// email, which anonymous (not-logged-in) visitors can also use.
// ----------------------------------------------------------------
router.get('/public-status', async (req, res) => {
  try {
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM android_tester_signups`);
    const count = parseInt(countRows[0].count, 10);
    res.json({ spotsRemaining: Math.max(0, MAX_SIGNUPS - count), full: count >= MAX_SIGNUPS });
  } catch (err) {
    console.error('Android tester public status error:', err.message);
    res.status(500).json({ error: 'Failed to load status' });
  }
});

// ----------------------------------------------------------------
// POST /api/android-testers/public-signup
// Body: { name, googleEmail } — no login required.
// ----------------------------------------------------------------
router.post('/public-signup', async (req, res) => {
  try {
    const name = (req.body.name || '').trim().slice(0, 255);
    const googleEmail = (req.body.googleEmail || '').trim().toLowerCase();
    if (!name) {
      return res.status(400).json({ error: 'Please enter your name' });
    }
    if (!googleEmail || !googleEmail.includes('@')) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM android_tester_signups`);
    if (parseInt(countRows[0].count, 10) >= MAX_SIGNUPS) {
      return res.status(400).json({ error: 'All tester spots are full — thanks for your interest!' });
    }

    const { rows: existing } = await pool.query(
      `SELECT id FROM android_tester_signups WHERE lower(google_email) = $1`,
      [googleEmail]
    );
    if (existing.length) {
      return res.json({ success: true }); // already signed up — treat as success, not an error
    }

    await pool.query(
      `INSERT INTO android_tester_signups (user_id, name, google_email) VALUES (NULL, $1, $2)`,
      [name, googleEmail]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Android tester public signup error:', err.message);
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
      `SELECT ats.id, ats.user_id, COALESCE(u.name, ats.name) AS name, u.email AS account_email,
              ats.google_email, ats.created_at, ats.reminded_at, (ats.user_id IS NULL) AS anonymous
       FROM android_tester_signups ats
       LEFT JOIN users u ON u.id = ats.user_id
       ORDER BY ats.created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tester list' });
  }
});

// POST /api/android-testers/admin/notify-check-email
// Body: { userIds: [1, 2, 3] } — sends an in-app notification + push
// to just the selected testers, reminding them to check their inbox
// (and junk/spam folder) for the Play Console opt-in invite email.
router.post('/admin/notify-check-email', requireAdmin, async (req, res) => {
  try {
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.filter(Number.isInteger) : [];
    if (!userIds.length) {
      return res.status(400).json({ error: 'No testers selected' });
    }

    // Only notify users who are actually on the tester list AND haven't
    // already been reminded, not arbitrary ids and not a double-send.
    const { rows: valid } = await pool.query(
      `SELECT user_id FROM android_tester_signups WHERE user_id = ANY($1::int[]) AND reminded_at IS NULL`,
      [userIds]
    );

    for (const { user_id } of valid) {
      await createNotification(pool, {
        userId: user_id,
        type: 'android_tester_reminder',
        title: '📧 Check your inbox!',
        body: "We've sent your Android testing invite link — check your email (and your junk/spam folder!) for it.",
      }).catch(() => {});
      sendPushNotification(user_id, {
        title: '📧 Check your inbox!',
        body: "We've sent your Android testing invite link — check your email (and junk/spam) for it.",
      }).catch(() => {});
    }

    if (valid.length) {
      await pool.query(
        `UPDATE android_tester_signups SET reminded_at = NOW() WHERE user_id = ANY($1::int[])`,
        [valid.map((v) => v.user_id)]
      );
    }

    res.json({ success: true, notified: valid.length });
  } catch (err) {
    console.error('Android tester notify error:', err.message);
    res.status(500).json({ error: 'Failed to send reminders' });
  }
});

// ----------------------------------------------------------------
// POST /api/android-testers/admin/send-recruitment-email
// Emails every active user via Resend with a branded invite linking
// to the public gotonespare.com/android-testers signup page.
// ----------------------------------------------------------------
router.post('/admin/send-recruitment-email', requireAdmin, async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT id, name, email FROM users WHERE is_suspended = FALSE AND is_active = TRUE`
    );

    const signupUrl = `${process.env.FRONTEND_URL || 'https://www.gotonespare.com'}/android-testers`;
    let sent = 0;
    for (const user of users) {
      try {
        await sendAndroidTesterRecruitmentEmail(user.email, user.name, signupUrl);
        sent++;
      } catch (err) {
        console.error(`Recruitment email failed for user ${user.id}:`, err.message);
      }
    }

    res.json({ success: true, sent, total: users.length });
  } catch (err) {
    console.error('Android tester recruitment email error:', err.message);
    res.status(500).json({ error: 'Failed to send recruitment emails' });
  }
});

module.exports = router;
