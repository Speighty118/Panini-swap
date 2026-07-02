/**
 * Inactive-user nudge job.
 *
 * Sends a notification (and push) to users who haven't logged in for
 * 7+ days but do have stickers listed. Respects last_nudge_at so the
 * same user isn't nudged more than once a week, however often this
 * job runs.
 *
 * Same logic that used to live only in the admin dashboard's manual
 * "Run now" button — now shared so it can also run automatically via
 * cron-job.org.
 *
 * Run via cron-job.org, e.g. once a day:
 * GET https://your-backend.railway.app/api/internal/run-auto-nudge?secret=<CRON_SECRET>
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sendAutoNudge() {
  console.log('[AUTO-NUDGE] Starting job');
  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.name FROM users u
       WHERE u.last_login_at < NOW() - INTERVAL '7 days'
         AND (u.last_nudge_at IS NULL OR u.last_nudge_at < NOW() - INTERVAL '7 days')
         AND u.email_verified = TRUE
         AND u.is_suspended = FALSE
         AND (
           EXISTS (SELECT 1 FROM user_duplicates WHERE user_id = u.id) OR
           EXISTS (SELECT 1 FROM user_needs WHERE user_id = u.id)
         )`
    );

    console.log(`[AUTO-NUDGE] Found ${users.length} inactive users to nudge`);

    const { sendPushNotification } = require('../api/push');
    let sent = 0;
    for (const user of users) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, 'nudge', 'Any new stickers? 👀', 'It''s been a while! Pop back to check your matches — new swap partners may have joined since your last visit.')`,
        [user.id]
      );
      await pool.query(`UPDATE users SET last_nudge_at = NOW() WHERE id = $1`, [user.id]);
      sendPushNotification(user.id, {
        title: '👀 Any new stickers?',
        body: "It's been a while — pop back and check your matches.",
      }).catch(() => {});
      sent++;
    }

    console.log(`[AUTO-NUDGE] Done — nudged ${sent} users`);
    return sent;
  } catch (err) {
    console.error('[AUTO-NUDGE] Error:', err.message);
    throw err;
  }
}

module.exports = { sendAutoNudge };
