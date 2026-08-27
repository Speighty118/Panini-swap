/**
 * Matching batch job.
 *
 * Run on a schedule (e.g. every 5 minutes via cron, or a queue worker)
 * rather than computing matches live on each page load.
 *
 * What it does, once per album:
 *   1. Calls find_matches(3, albumId) — the SQL function that finds user
 *      pairs where each side can give >= 3 stickers the other needs,
 *      scoped to that one album.
 *   2. Bulk-upserts results into the `matches` table in a single query
 *      per album (via UNNEST), instead of one query per pair — this used
 *      to loop with an individual awaited query per candidate pair,
 *      which was fine at small scale but became thousands of sequential
 *      round-trips as the user base grew, eventually taking minutes and
 *      blowing past the cron trigger's 30s timeout (502/timeout
 *      failures). Bulk upserting brings this back down to a handful of
 *      queries total, regardless of how many pairs are found.
 *   3. Marks any previously-pending match that's no longer in the
 *      current result set as 'stale' (e.g. someone's inventory changed
 *      and they no longer qualify) — also a single bulk query per album.
 *
 * Run: node jobs/run_matching.js
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const MIN_MATCH = 3;
const MIN_NOTIFY = 3; // Same "decent size" bar as the homepage activity ticker

async function runMatchingJob() {
  const client = await pool.connect();
  const startedAt = Date.now();
  const newMatches = []; // brand-new pairs found this run, notified after commit
  let totalActive = 0;
  let totalStale = 0;

  try {
    await client.query('BEGIN');

    const { rows: albums } = await client.query('SELECT id FROM albums ORDER BY id');

    // Feature: pause matching. Deliberately filtered here in JS rather
    // than inside find_matches() itself — keeps the matching SQL
    // function untouched and this easy to remove/adjust later.
    // Wrapped defensively: if this query fails for any reason (e.g. a
    // migration hasn't run yet), we fall back to treating nobody as
    // paused rather than crashing the entire matching job.
    let pausedIds = new Set();
    try {
      const { rows: pausedRows } = await client.query(
        `SELECT id FROM users WHERE COALESCE(matching_paused, FALSE) = TRUE`
      );
      pausedIds = new Set(pausedRows.map(r => r.id));
    } catch (pauseErr) {
      console.error('Could not check paused users (continuing without pause filter):', pauseErr.message);
    }

    // Run matching separately per album — each album's matches, staleness,
    // and swap-reactivation checks are independent of every other album's.
    for (const { id: albumId } of albums) {
      const { rows: currentMatches } = await client.query(
        'SELECT * FROM find_matches($1, $2)',
        [MIN_MATCH, albumId]
      );

      console.log(`Album ${albumId}: found ${currentMatches.length} candidate pairs.`);

      const activeMatches = currentMatches.filter(
        m => !pausedIds.has(m.user_a) && !pausedIds.has(m.user_b)
      );
      if (pausedIds.size > 0) {
        console.log(`Album ${albumId}: skipping ${currentMatches.length - activeMatches.length} pair(s) involving paused user(s).`);
      }

      if (activeMatches.length > 0) {
        // Bulk upsert — one query for the whole album's pairs, via
        // UNNEST'd arrays, instead of one query per pair.
        const aArr = activeMatches.map(m => m.user_a);
        const bArr = activeMatches.map(m => m.user_b);
        const agbArr = activeMatches.map(m => m.a_gives_b_count);
        const bgaArr = activeMatches.map(m => m.b_gives_a_count);

        const { rows: upserted } = await client.query(
          `INSERT INTO matches (user_a_id, user_b_id, album_id, a_gives_b_count, b_gives_a_count, status, computed_at)
           SELECT u.a, u.b, $5::int, u.agb, u.bga, 'pending', NOW()
           FROM UNNEST($1::int[], $2::int[], $3::int[], $4::int[]) AS u(a, b, agb, bga)
           ON CONFLICT (user_a_id, user_b_id, album_id)
           DO UPDATE SET
             a_gives_b_count = EXCLUDED.a_gives_b_count,
             b_gives_a_count = EXCLUDED.b_gives_a_count,
             computed_at = NOW(),
             status = CASE
               WHEN matches.status = 'stale' THEN 'pending'
               -- Reactivate a previously-proposed match only if its swap
               -- (in this same album) has since been declined or completed
               -- (not still active).
               WHEN matches.status = 'proposed' AND NOT EXISTS (
                 SELECT 1 FROM swaps s
                 WHERE ((s.user_a_id = matches.user_a_id AND s.user_b_id = matches.user_b_id)
                     OR (s.user_a_id = matches.user_b_id AND s.user_b_id = matches.user_a_id))
                 AND s.album_id = matches.album_id
                 AND s.status IN ('proposed', 'accepted', 'posted')
               ) THEN 'pending'
               ELSE matches.status
             END
           RETURNING user_a_id, user_b_id, a_gives_b_count, b_gives_a_count, (xmax = 0) AS is_new_pair`,
          [aArr, bArr, agbArr, bgaArr, albumId]
        );

        for (const row of upserted) {
          if (row.is_new_pair && Math.min(row.a_gives_b_count, row.b_gives_a_count) >= MIN_NOTIFY) {
            newMatches.push({ user_a: row.user_a_id, user_b: row.user_b_id, a_gives_b_count: row.a_gives_b_count, b_gives_a_count: row.b_gives_a_count });
          }
        }
      }

      // Mark stale: pending matches in this album not in this run's results
      // anymore (their inventories changed enough to drop below threshold).
      // We don't touch 'proposed' matches — those already became real swaps.
      // Single bulk query using an anti-join against the active pairs,
      // instead of a per-row SELECT+loop+per-row UPDATE.
      const aArr = activeMatches.map(m => m.user_a);
      const bArr = activeMatches.map(m => m.user_b);

      const { rowCount: staleCount } = await client.query(
        `UPDATE matches m
         SET status = 'stale'
         WHERE m.status = 'pending' AND m.album_id = $3
           AND NOT EXISTS (
             SELECT 1 FROM UNNEST($1::int[], $2::int[]) AS active(a, b)
             WHERE active.a = m.user_a_id AND active.b = m.user_b_id
           )`,
        [aArr, bArr, albumId]
      );

      totalActive += currentMatches.length;
      totalStale += staleCount;
    }

    await client.query('COMMIT');

    // Notify both sides of any brand-new match, now it's safely
    // committed. Fire-and-forget — a notification hiccup shouldn't
    // affect the matching job itself, which runs every minute.
    if (newMatches.length > 0) {
      try {
        const { createNotification } = require('../api/notifications');
        for (const m of newMatches) {
          const { rows: names } = await pool.query(
            `SELECT id, name FROM users WHERE id = ANY($1::int[])`,
            [[m.user_a, m.user_b]]
          );
          const nameA = names.find(n => n.id === m.user_a)?.name || 'Someone';
          const nameB = names.find(n => n.id === m.user_b)?.name || 'Someone';
          const count = Math.min(m.a_gives_b_count, m.b_gives_a_count);

          await createNotification(pool, {
            userId: m.user_a,
            type: 'match_found',
            title: '🎉 New match found!',
            body: `You've been matched with ${nameB} — ${count} sticker${count !== 1 ? 's' : ''} you can swap.`,
          });
          await createNotification(pool, {
            userId: m.user_b,
            type: 'match_found',
            title: '🎉 New match found!',
            body: `You've been matched with ${nameA} — ${count} sticker${count !== 1 ? 's' : ''} you can swap.`,
          });
        }
        console.log(`Notified ${newMatches.length} new match(es).`);
      } catch (notifyErr) {
        console.error('Match notification error:', notifyErr);
      }
    }

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
      `Matching job complete: ${totalActive} active, ${totalStale} marked stale. (${duration}ms)`
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
