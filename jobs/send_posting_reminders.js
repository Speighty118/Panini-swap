/**
 * Posting reminder job.
 *
 * Two tiers, both driven off the same "accepted" swaps:
 *   1. 48+ hours since acceptance, first nudge — the missing middle
 *      reminder (there's already one for "you haven't accepted yet" in
 *      send_reminders.js, and one for "you haven't confirmed receipt
 *      yet" in send_receipt_reminders.js).
 *   2. 7+ days since acceptance, a second, more direct nudge that also
 *      points at the "Withdraw from swap" option — for swaps that
 *      genuinely stalled. Deliberately NOT auto-declined: there's no
 *      way to tell "actually posted but forgot to click the button"
 *      apart from "never posted at all" from timestamps alone, and
 *      guessing wrong would free up a sticker that's already been
 *      physically sent. So this stays a nudge, and it's up to the user
 *      to withdraw if it's genuinely dead.
 *
 * Only nudges someone if the person they're posting TO has actually
 * filled in their address — no point nagging someone to post when
 * they literally can't yet.
 *
 * Push notification + in-app bell only, no email — keeps this well
 * within the Resend free tier quota.
 *
 * Run via cron-job.org, e.g. every 6 hours:
 * GET https://your-backend.railway.app/api/internal/run-posting-reminders?secret=<CRON_SECRET>
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sendPostingReminders() {
  console.log('[POSTING REMINDERS] Starting job');

  try {
    const { createNotification } = require('../api/notifications');

    const { rows: swaps } = await pool.query(`
      SELECT
        s.id, s.user_a_id, s.user_b_id, s.user_a_posted, s.user_b_posted,
        ua.name AS user_a_name, ub.name AS user_b_name,
        (ua.address_line1 IS NOT NULL AND ua.city IS NOT NULL) AS user_a_address_ready,
        (ub.address_line1 IS NOT NULL AND ub.city IS NOT NULL) AS user_b_address_ready
      FROM swaps s
      JOIN users ua ON ua.id = s.user_a_id
      JOIN users ub ON ub.id = s.user_b_id
      WHERE s.status = 'accepted'
        AND s.updated_at <= NOW() - INTERVAL '48 hours'
        AND s.posting_reminder_sent = FALSE
    `);

    console.log(`[POSTING REMINDERS] Found ${swaps.length} swaps needing a first nudge`);

    for (const swap of swaps) {
      // user_a posts TO user_b, so only nudge if user_b's address is ready
      if (!swap.user_a_posted && swap.user_b_address_ready) {
        await createNotification(pool, {
          userId: swap.user_a_id,
          type: 'swap_reminder',
          title: "Don't forget to post your stickers! 📮",
          body: `${swap.user_b_name} is waiting on you to post your side of the swap.`,
          swapId: swap.id,
        });
      }
      // user_b posts TO user_a, so only nudge if user_a's address is ready
      if (!swap.user_b_posted && swap.user_a_address_ready) {
        await createNotification(pool, {
          userId: swap.user_b_id,
          type: 'swap_reminder',
          title: "Don't forget to post your stickers! 📮",
          body: `${swap.user_a_name} is waiting on you to post your side of the swap.`,
          swapId: swap.id,
        });
      }
      await pool.query(`UPDATE swaps SET posting_reminder_sent = TRUE WHERE id = $1`, [swap.id]);
      console.log(`[POSTING REMINDERS] First reminder sent for swap #${swap.id}`);
    }

    const { rows: staleSwaps } = await pool.query(`
      SELECT
        s.id, s.user_a_id, s.user_b_id, s.user_a_posted, s.user_b_posted,
        ua.name AS user_a_name, ub.name AS user_b_name,
        (ua.address_line1 IS NOT NULL AND ua.city IS NOT NULL) AS user_a_address_ready,
        (ub.address_line1 IS NOT NULL AND ub.city IS NOT NULL) AS user_b_address_ready
      FROM swaps s
      JOIN users ua ON ua.id = s.user_a_id
      JOIN users ub ON ub.id = s.user_b_id
      WHERE s.status = 'accepted'
        AND s.updated_at <= NOW() - INTERVAL '7 days'
        AND s.posting_reminder_sent = TRUE
        AND s.posting_second_reminder_sent = FALSE
    `);

    console.log(`[POSTING REMINDERS] Found ${staleSwaps.length} swaps needing a second, final nudge`);

    for (const swap of staleSwaps) {
      if (!swap.user_a_posted && swap.user_b_address_ready) {
        await createNotification(pool, {
          userId: swap.user_a_id,
          type: 'swap_reminder',
          title: 'This swap has been waiting a week 📮',
          body: `Still haven't posted to ${swap.user_b_name}? If you have, just mark it as posted. If it's not happening, you can withdraw from the swap instead.`,
          swapId: swap.id,
        });
      }
      if (!swap.user_b_posted && swap.user_a_address_ready) {
        await createNotification(pool, {
          userId: swap.user_b_id,
          type: 'swap_reminder',
          title: 'This swap has been waiting a week 📮',
          body: `Still haven't posted to ${swap.user_a_name}? If you have, just mark it as posted. If it's not happening, you can withdraw from the swap instead.`,
          swapId: swap.id,
        });
      }
      await pool.query(`UPDATE swaps SET posting_second_reminder_sent = TRUE WHERE id = $1`, [swap.id]);
      console.log(`[POSTING REMINDERS] Second reminder sent for swap #${swap.id}`);
    }

    console.log('[POSTING REMINDERS] Done');
  } catch (err) {
    console.error('[POSTING REMINDERS] Error:', err.message);
  }
}

module.exports = { sendPostingReminders };
