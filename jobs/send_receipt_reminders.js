/**
 * Receipt reminder job.
 *
 * Nudges anyone who still hasn't confirmed they've received their
 * stickers on a swap that's been sitting at 'posted' for 48+ hours.
 * This is the step most swaps were getting stuck on — nobody was
 * reminding people to come back and tap "Mark stickers as received".
 *
 * Push notification + in-app bell only, no email — keeps this well
 * within the Resend free tier quota.
 *
 * Run this via cron-job.org, e.g. every 6 hours:
 * GET https://your-backend.railway.app/api/internal/run-receipt-reminders?secret=<CRON_SECRET>
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sendReceiptReminders() {
  console.log('[RECEIPT REMINDERS] Starting job');

  try {
    const { createNotification } = require('../api/notifications');

    const { rows: swaps } = await pool.query(`
      SELECT s.id, s.user_a_id, s.user_b_id, s.user_a_received, s.user_b_received,
             ua.name AS user_a_name, ub.name AS user_b_name
      FROM swaps s
      JOIN users ua ON ua.id = s.user_a_id
      JOIN users ub ON ub.id = s.user_b_id
      WHERE s.status = 'posted'
        AND s.updated_at <= NOW() - INTERVAL '48 hours'
        AND s.receipt_reminder_sent = FALSE
    `);

    console.log(`[RECEIPT REMINDERS] Found ${swaps.length} swaps needing a nudge`);

    for (const swap of swaps) {
      if (!swap.user_a_received) {
        await createNotification(pool, {
          userId: swap.user_a_id,
          type: 'swap_reminder',
          title: 'Got your stickers yet? 📬',
          body: `If you've received your stickers from ${swap.user_b_name}, don't forget to mark the swap as received so you can both rate each other.`,
          swapId: swap.id,
        });
      }
      if (!swap.user_b_received) {
        await createNotification(pool, {
          userId: swap.user_b_id,
          type: 'swap_reminder',
          title: 'Got your stickers yet? 📬',
          body: `If you've received your stickers from ${swap.user_a_name}, don't forget to mark the swap as received so you can both rate each other.`,
          swapId: swap.id,
        });
      }
      await pool.query(`UPDATE swaps SET receipt_reminder_sent = TRUE WHERE id = $1`, [swap.id]);
      console.log(`[RECEIPT REMINDERS] Reminder sent for swap #${swap.id}`);
    }

    console.log('[RECEIPT REMINDERS] Done');
  } catch (err) {
    console.error('[RECEIPT REMINDERS] Error:', err.message);
  }
}

module.exports = { sendReceiptReminders };
