/**
 * TEMPORARY one-off script — backfills XP for existing users from
 * their real history, so the new level system doesn't start everyone
 * at zero. Reuses the exact same awardXp() used for live awards, so
 * backfilled XP follows identical rules (including the same
 * idempotency guard) — no separate scoring logic to keep in sync.
 *
 * Referral XP is NOT backfilled — no historical referral data exists
 * yet, so existing users simply start referrals fresh.
 *
 * Safe to re-run — awardXp() is a no-op for anything already awarded.
 *
 * Run: node xp_backfill.js
 * Requires DATABASE_URL in the environment (or a .env file in this folder).
 */

require('dotenv').config();
const { Pool } = require('pg');
const { awardXp } = require('./api/xp');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to a .env file in backend/ or export it in your shell before running this script.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // 1. Completed swaps -> completed_swap XP (per swap) + first_swap_bonus (once ever)
  const { rows: completedSwaps } = await pool.query(
    `SELECT id, user_a_id, user_b_id FROM swaps WHERE status = 'completed' ORDER BY updated_at ASC`
  );
  console.log(`Backfilling ${completedSwaps.length} completed swap(s)...`);
  for (const swap of completedSwaps) {
    for (const userId of [swap.user_a_id, swap.user_b_id]) {
      await awardXp(pool, { userId, eventType: 'completed_swap', relatedId: swap.id });
      await awardXp(pool, { userId, eventType: 'first_swap_bonus' });
    }
  }

  // 2. Ratings given -> rating_given XP (per rating)
  const { rows: allRatings } = await pool.query(`SELECT rater_id, swap_id FROM ratings`);
  console.log(`Backfilling ${allRatings.length} rating(s) given...`);
  for (const r of allRatings) {
    await awardXp(pool, { userId: r.rater_id, eventType: 'rating_given', relatedId: r.swap_id });
  }

  // 3. Verified postage photos -> verified_postage XP (per swap, per side).
  // Only counts the newer per-user photo columns — swaps from before
  // that fix only have the old shared column, which can't be reliably
  // attributed to one side, so those don't retroactively earn this one.
  const { rows: postagePhotos } = await pool.query(`
    SELECT id AS swap_id, user_a_id AS user_id FROM swaps WHERE user_a_postage_photo IS NOT NULL
    UNION ALL
    SELECT id AS swap_id, user_b_id AS user_id FROM swaps WHERE user_b_postage_photo IS NOT NULL
  `);
  console.log(`Backfilling ${postagePhotos.length} verified postage photo(s)...`);
  for (const p of postagePhotos) {
    await awardXp(pool, { userId: p.user_id, eventType: 'verified_postage', relatedId: p.swap_id });
  }

  // 4. Existing Ambassador badge -> one-time ambassador_bonus XP
  const { rows: ambassadors } = await pool.query(`SELECT id FROM users WHERE ambassador_badge = TRUE`);
  console.log(`Backfilling ${ambassadors.length} ambassador bonus(es)...`);
  for (const a of ambassadors) {
    await awardXp(pool, { userId: a.id, eventType: 'ambassador_bonus' });
  }

  const { rows: totals } = await pool.query(`SELECT COUNT(*) AS users_with_xp FROM users WHERE xp > 0`);
  console.log(`Done — ${totals[0].users_with_xp} user(s) now have XP.`);
  await pool.end();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
