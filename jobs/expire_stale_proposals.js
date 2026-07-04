/**
 * Stale proposal expiry job.
 *
 * Auto-declines any swap that's been sitting at 'proposed' for 7+
 * days without both sides accepting. The 24h reminder email already
 * nudges people once — after that, nothing was ever cleaning these
 * up, so they could sit forever leaving the other person waiting.
 *
 * This is a neutral, no-fault decline — it doesn't touch anyone's
 * times_reported or reputation, and the matching job will naturally
 * offer a fresh match for the same pair (or someone else) on its
 * very next run, since declining frees the match back up.
 *
 * Run via cron-job.org, e.g. once a day:
 * GET https://your-backend.railway.app/api/internal/run-expire-proposals?secret=<CRON_SECRET>
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const EXPIRY_DAYS = 7;

async function expireStaleProposals() {
  console.log('[EXPIRE PROPOSALS] Starting job');

  try {
    const { createNotification } = require('../api/notifications');

    const { rows: swaps } = await pool.query(`
      SELECT id, user_a_id, user_b_id
      FROM swaps
      WHERE status = 'proposed'
        AND created_at <= NOW() - INTERVAL '${EXPIRY_DAYS} days'
    `);

    console.log(`[EXPIRE PROPOSALS] Found ${swaps.length} stale proposals to expire`);

    for (const swap of swaps) {
      await pool.query(
        `UPDATE swaps SET status = 'declined',
         decline_reason = 'Automatically declined — no response within ${EXPIRY_DAYS} days. A fresh match will be generated shortly.',
         updated_at = NOW()
         WHERE id = $1`,
        [swap.id]
      );

      for (const userId of [swap.user_a_id, swap.user_b_id]) {
        await createNotification(pool, {
          userId,
          type: 'swap_declined',
          title: 'Swap proposal expired',
          body: `A swap proposal was automatically cancelled after ${EXPIRY_DAYS} days with no response. A fresh match should appear in your Matches tab shortly.`,
          swapId: swap.id,
        });
      }

      console.log(`[EXPIRE PROPOSALS] Expired swap #${swap.id}`);
    }

    console.log('[EXPIRE PROPOSALS] Done');
  } catch (err) {
    console.error('[EXPIRE PROPOSALS] Error:', err.message);
  }
}

module.exports = { expireStaleProposals };
