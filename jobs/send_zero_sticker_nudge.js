/**
 * Zero-stickers nudge job.
 *
 * Sends a notification (and push) to users who signed up but have
 * never added a duplicate or a need. Different message to the
 * inactive-user nudge, since these users haven't got anything to
 * swap with yet. Respects last_nudge_at so nobody gets nudged more
 * than once a week.
 *
 * Same logic that used to live only in the admin dashboard's manual
 * "Nudge all" button — now shared so it can also run automatically
 * via cron-job.org.
 *
 * Run via cron-job.org, e.g. once a day:
 * GET https://your-backend.railway.app/api/internal/run-zero-sticker-nudge?secret=<CRON_SECRET>
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sendZeroStickerNudge() {
  console.log('[ZERO-STICKER NUDGE] Starting job');
  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.name
       FROM users u
       LEFT JOIN user_duplicates ud ON ud.user_id = u.id
       LEFT JOIN user_needs un ON un.user_id = u.id
       WHERE ud.sticker_id IS NULL AND un.sticker_id IS NULL
         AND u.email_verified = TRUE
         AND u.is_suspended = FALSE
         AND (u.last_nudge_at IS NULL OR u.last_nudge_at < NOW() - INTERVAL '7 days')
       GROUP BY u.id, u.name`
    );

    console.log(`[ZERO-STICKER NUDGE] Found ${users.length} users with nothing listed`);

    const { sendPushNotification } = require('../api/push');
    let sent = 0;
    for (const user of users) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, 'nudge', 'Get your stickers listed! 📋', 'Add your spares and what you''re after to start getting matched with other swappers — it only takes a couple of minutes.')`,
        [user.id]
      );
      await pool.query(`UPDATE users SET last_nudge_at = NOW() WHERE id = $1`, [user.id]);
      sendPushNotification(user.id, {
        title: '📋 Get your stickers listed!',
        body: 'Add your spares and needs to start getting matched.',
      }).catch(() => {});
      sent++;
    }

    console.log(`[ZERO-STICKER NUDGE] Done — nudged ${sent} users`);
    return sent;
  } catch (err) {
    console.error('[ZERO-STICKER NUDGE] Error:', err.message);
    throw err;
  }
}

module.exports = { sendZeroStickerNudge };
