/**
 * Matching batch job.
 *
 * Run on a schedule (e.g. every 5 minutes via cron, or a queue worker)
 * rather than computing matches live on each page load.
 *
 * What it does:
 *   1. Calls find_matches(3) — the SQL function that finds user pairs
 *      where each side can give >= 3 stickers the other needs.
 *   2. Upserts results into the `matches` table.
 *   3. Marks any previously-pending match that's no longer in the
 *      current result set as 'stale' (e.g. someone's inventory changed
 *      and they no longer qualify).
 *
 * Run: node jobs/run_matching.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const MIN_MATCH = 3;

async function runMatchingJob() {
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query('BEGIN');

    const { rows: currentMatches } = await client.query(
      'SELECT * FROM find_matches($1)',
      [MIN_MATCH]
    );

    console.log(`Found ${currentMatches.length} candidate pairs.`);

    const seenPairs = new Set();

    for (const m of currentMatches) {
      const key = `${m.user_a}-${m.user_b}`;
      seenPairs.add(key);

      await client.query(
        `INSERT INTO matches (user_a_id, user_b_id, a_gives_b_count, b_gives_a_count, status, computed_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())
         ON CONFLICT (user_a_id, user_b_id)
         DO UPDATE SET
           a_gives_b_count = EXCLUDED.a_gives_b_count,
           b_gives_a_count = EXCLUDED.b_gives_a_count,
           computed_at = NOW(),
           status = CASE
             WHEN matches.status = 'stale' THEN 'pending'
             ELSE matches.status
           END`,
        [m.user_a, m.user_b, m.a_gives_b_count, m.b_gives_a_count]
      );
    }

    // Mark stale: pending matches not in this run's results anymore
    // (their inventories changed enough to drop below threshold).
    // We don't touch 'proposed' matches — those already became real swaps.
    const { rows: existingPending } = await client.query(
      `SELECT user_a_id, user_b_id FROM matches WHERE status = 'pending'`
    );

    const staleIds = [];
    for (const row of existingPending) {
      const key = `${row.user_a_id}-${row.user_b_id}`;
      if (!seenPairs.has(key)) {
        staleIds.push([row.user_a_id, row.user_b_id]);
      }
    }

    for (const [a, b] of staleIds) {
      await client.query(
        `UPDATE matches SET status = 'stale' WHERE user_a_id = $1 AND user_b_id = $2`,
        [a, b]
      );
    }

    await client.query('COMMIT');

    // Auto-clean broken proposed swaps — where stickers are no longer in
    // the giver's duplicates. This runs after every matching cycle so
    // broken swaps are caught within 1 minute rather than waiting for
    // user reports.
    try {
      const { rowCount } = await pool.query(
        `UPDATE swaps SET status = 'declined',
           decline_reason = 'Automatically declined — sticker availability changed since this swap was proposed. A fresh match will be generated shortly.',
           updated_at = NOW()
         WHERE status = 'proposed'
           AND id IN (
             SELECT DISTINCT s.id FROM swaps s
             JOIN swap_items si ON si.swap_id = s.id
             LEFT JOIN user_duplicates ud ON ud.user_id = si.from_user_id AND ud.sticker_id = si.sticker_id
             WHERE s.status = 'proposed' AND ud.quantity IS NULL
           )`
      );
      if (rowCount > 0) {
        console.log(`Auto-cleaned ${rowCount} broken proposed swap${rowCount > 1 ? 's' : ''}.`);
      }
    } catch (cleanErr) {
      console.error('Broken swap cleanup error:', cleanErr);
    }

    const duration = Date.now() - startedAt;
    console.log(
      `Matching job complete: ${currentMatches.length} active, ${staleIds.length} marked stale. (${duration}ms)`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Matching job failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Allow running directly: node jobs/run_matching.js
if (require.main === module) {
  runMatchingJob()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runMatchingJob };
