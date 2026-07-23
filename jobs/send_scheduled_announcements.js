/**
 * Sends any scheduled announcements whose time has come.
 *
 * Run via cron-job.org, e.g. every 5 minutes:
 *   https://yourapp.railway.app/api/internal/run-scheduled-announcements?secret=YOUR_CRON_SECRET
 */

const { Pool } = require('pg');
const { sendBroadcastToAllUsers } = require('../api/broadcast');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sendScheduledAnnouncements() {
  const { rows: due } = await pool.query(
    `SELECT * FROM scheduled_announcements WHERE status = 'pending' AND send_at <= NOW()`
  );

  for (const announcement of due) {
    try {
      await sendBroadcastToAllUsers(pool, {
        title: announcement.title,
        body: announcement.body,
        type: 'announcement',
      });
      await pool.query(
        `UPDATE scheduled_announcements SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [announcement.id]
      );
      console.log(`[SCHEDULED ANNOUNCEMENT] Sent #${announcement.id}: "${announcement.title}"`);
    } catch (err) {
      console.error(`[SCHEDULED ANNOUNCEMENT] Failed to send #${announcement.id}:`, err.message);
    }
  }

  return { sent: due.length };
}

if (require.main === module) {
  sendScheduledAnnouncements()
    .then((r) => { console.log(r); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { sendScheduledAnnouncements };
