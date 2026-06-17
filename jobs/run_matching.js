/**
 * Matching batch job.
 *
 * Run on a schedule (e.g. every 5 minutes via cron, or a queue worker)
 * rather than computing matches live on each page load.
 *
 * What it does:
 *   1. Calls find_matches(5) — the SQL function that finds user pairs
 *      where each side can give >= 5 stickers the other needs.
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

const MIN_MATCH = 5;

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
