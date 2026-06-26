/**
 * Swap reminder job.
 * Send email reminders for swap proposals that have been waiting
 * for more than 24 hours without a response.
 *
 * Run this via cron-job.org every hour:
 * POST https://your-backend.railway.app/api/run-reminders
 * with header: x-cron-secret: <CRON_SECRET>
 */

const { Pool } = require('pg');
const { sendSwapReminderEmail } = require('../api/email');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sendReminders() {
  console.log('[REMINDERS] Starting reminder job');

  try {
    // Find proposed swaps older than 24h where reminder hasn't been sent
    // and the recipient has reminders enabled
    const { rows: swaps } = await pool.query(`
      SELECT
        s.id AS swap_id,
        s.user_a_id,
        s.user_b_id,
        s.user_a_accepted,
        s.user_b_accepted,
        s.predicted_count,
        ua.name AS user_a_name,
        ua.email AS user_a_email,
        ua.email_swap_reminders AS user_a_reminders,
        ub.name AS user_b_name,
        ub.email AS user_b_email,
        ub.email_swap_reminders AS user_b_reminders,
        (SELECT COUNT(*) FROM swap_items WHERE swap_id = s.id) AS item_count
      FROM swaps s
      JOIN users ua ON ua.id = s.user_a_id
      JOIN users ub ON ub.id = s.user_b_id
      WHERE s.status = 'proposed'
        AND s.created_at <= NOW() - INTERVAL '24 hours'
        AND s.proposal_reminder_sent = false
    `);

    console.log(`[REMINDERS] Found ${swaps.length} swaps needing reminders`);

    for (const swap of swaps) {
      const swapCount = swap.item_count > 0 ? swap.item_count / 2 : (swap.predicted_count || '?');

      // Send to whichever side hasn't accepted yet
      const promises = [];

      if (!swap.user_a_accepted && swap.user_a_reminders) {
        promises.push(
          sendSwapReminderEmail(swap.user_a_email, {
            recipientName: swap.user_a_name,
            proposerName: swap.user_b_name,
            swapId: swap.swap_id,
            count: swapCount,
          }).catch(err => console.error(`[REMINDERS] Email error for user_a on swap ${swap.swap_id}:`, err.message))
        );
      }

      if (!swap.user_b_accepted && swap.user_b_reminders) {
        promises.push(
          sendSwapReminderEmail(swap.user_b_email, {
            recipientName: swap.user_b_name,
            proposerName: swap.user_a_name,
            swapId: swap.swap_id,
            count: swapCount,
          }).catch(err => console.error(`[REMINDERS] Email error for user_b on swap ${swap.swap_id}:`, err.message))
        );
      }

      if (promises.length > 0) {
        await Promise.all(promises);
        // Mark reminder as sent regardless of email success/fail
        await pool.query(
          `UPDATE swaps SET proposal_reminder_sent = true WHERE id = $1`,
          [swap.swap_id]
        );
        console.log(`[REMINDERS] Reminder sent for swap #${swap.swap_id}`);
      } else {
        // No one has reminders enabled — still mark as sent so we don't re-check
        await pool.query(
          `UPDATE swaps SET proposal_reminder_sent = true WHERE id = $1`,
          [swap.swap_id]
        );
      }
    }

    console.log('[REMINDERS] Done');
  } catch (err) {
    console.error('[REMINDERS] Error:', err.message);
  }
}

module.exports = { sendReminders };
