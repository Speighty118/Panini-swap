/**
 * Admin API endpoints.
 * Mount under /api/admin.
 *
 * Not tied to the normal user auth system — gated instead by a
 * shared secret (ADMIN_SECRET env var), checked via the
 * X-Admin-Secret header. Intended for a single group admin (you),
 * not a full multi-admin role system.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// ----------------------------------------------------------------
// GET /api/admin/reported-users
// Lists users with times_reported > 0, most-reported first.
// ----------------------------------------------------------------
router.get('/reported-users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, times_reported, is_suspended, created_at
       FROM users
       WHERE times_reported > 0
       ORDER BY times_reported DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reported users' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/disputes
// Lists all disputes, optionally filtered by status.
// Query param: ?status=open|reviewing|resolved|dismissed
// ----------------------------------------------------------------
router.get('/disputes', async (req, res) => {
  const { status } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT d.*,
              raiser.name AS raised_by_name, raiser.email AS raised_by_email,
              against.name AS against_name, against.email AS against_email,
              against.times_reported AS against_times_reported,
              against.is_suspended AS against_is_suspended
       FROM disputes d
       JOIN users raiser ON raiser.id = d.raised_by_id
       JOIN users against ON against.id = d.against_id
       WHERE ($1::text IS NULL OR d.status = $1)
       ORDER BY d.created_at DESC`,
      [status || null]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/disputes/:id/status
// Body: { status }  — one of: reviewing, resolved, dismissed
// ----------------------------------------------------------------
router.post('/disputes/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const valid = ['open', 'reviewing', 'resolved', 'dismissed'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const resolvedAt = ['resolved', 'dismissed'].includes(status) ? new Date() : null;
    const { rows } = await client.query(
      `UPDATE disputes SET status = $1, resolved_at = $2 WHERE id = $3 RETURNING *`,
      [status, resolvedAt, req.params.id]
    );
    const dispute = rows[0];
    if (!dispute) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dispute not found' });
    }

    // Sync the linked swap so it doesn't stay stuck showing "disputed"
    // forever once you've actually dealt with it. Only touches the swap
    // if it's still sitting at 'disputed' — won't clobber anything else.
    if (['resolved', 'dismissed'].includes(status)) {
      await client.query(
        `UPDATE swaps SET status = 'declined',
         decline_reason = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'disputed'`,
        [`Manually resolved by admin — dispute marked ${status}`, dispute.swap_id]
      );
    }

    await client.query(
      `INSERT INTO admin_actions (action_type, target_user_id, target_dispute_id, note)
       VALUES ($1, $2, $3, $4)`,
      [`dispute_${status}`, dispute.against_id, dispute.id, note || null]
    );

    // If that was this user's last open dispute, auto-clear their case
    // into the Resolved section — saves a manual click for the common case.
    if (['resolved', 'dismissed'].includes(status)) {
      const { rows: openLeft } = await client.query(
        `SELECT COUNT(*) FROM disputes WHERE against_id = $1 AND status IN ('open', 'reviewing')`,
        [dispute.against_id]
      );
      if (parseInt(openLeft[0].count, 10) === 0) {
        await client.query(
          `INSERT INTO moderation_case_status (user_id, status, updated_at)
           VALUES ($1, 'resolved', NOW())
           ON CONFLICT (user_id) DO UPDATE SET status = 'resolved', updated_at = NOW()`,
          [dispute.against_id]
        );
      }
    }

    await client.query('COMMIT');

    // Let both people know the outcome, so you're not manually
    // messaging everyone for the routine cases. Fires after commit —
    // a failed notification shouldn't undo the resolution itself.
    if (['resolved', 'dismissed'].includes(status)) {
      try {
        const { createNotification } = require('./notifications');
        const outcomeText = status === 'resolved'
          ? 'has been reviewed and resolved'
          : 'has been reviewed — no action was needed';

        await createNotification(pool, {
          userId: dispute.raised_by_id,
          type: 'dispute_update',
          title: '⚖️ Update on your report',
          body: `Your report about swap #${dispute.swap_id} ${outcomeText}.`,
          swapId: dispute.swap_id,
        });
        await createNotification(pool, {
          userId: dispute.against_id,
          type: 'dispute_update',
          title: '⚖️ Update on a report against you',
          body: `A report about swap #${dispute.swap_id} ${outcomeText}.`,
          swapId: dispute.swap_id,
        });
      } catch (notifyErr) {
        console.error('Dispute outcome notification error:', notifyErr);
      }
    }

    res.json(dispute);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update dispute' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/admin/users/:id/suspend
// Body: { suspended: true | false }
// ----------------------------------------------------------------
router.post('/users/:id/suspend', async (req, res) => {
  const { suspended, note } = req.body;
  if (typeof suspended !== 'boolean') {
    return res.status(400).json({ error: 'suspended must be true or false' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_suspended = $1 WHERE id = $2 RETURNING id, name, email, is_suspended`,
      [suspended, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      `INSERT INTO admin_actions (action_type, target_user_id, note) VALUES ($1, $2, $3)`,
      [suspended ? 'suspend' : 'unsuspend', req.params.id, note || null]
    ).catch(() => {}); // don't fail the suspend if logging has an issue
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update suspension status' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/analytics
// God's-eye view: every user with their activity stats,
// profile photo, and rating summary.
// ----------------------------------------------------------------
router.get('/analytics', async (req, res) => {
  try {
    // Split into smaller queries to avoid temp disk exhaustion on Railway
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at, u.last_login_at,
              u.login_count, u.is_suspended, u.email_verified,
              u.times_reported, u.profile_photo
       FROM users u
       ORDER BY u.last_login_at DESC NULLS LAST`
    );

    const userIds = rows.map(r => r.id);
    if (!userIds.length) return res.json([]);

    const [stickerRes, swapRes, sessionRes, ratingRes, reviewRes] = await Promise.all([
      pool.query(
        `SELECT user_id,
                COUNT(DISTINCT sticker_id) FILTER (WHERE type = 'dupe') AS duplicates_count,
                COUNT(DISTINCT sticker_id) FILTER (WHERE type = 'need') AS needs_count
         FROM (
           SELECT user_id, sticker_id, 'dupe' AS type FROM user_duplicates WHERE user_id = ANY($1::int[])
           UNION ALL
           SELECT user_id, sticker_id, 'need' AS type FROM user_needs WHERE user_id = ANY($1::int[])
         ) t GROUP BY user_id`,
        [userIds]
      ),
      pool.query(
        `SELECT u_id, COUNT(*) AS swaps_count,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed_swaps
         FROM (
           SELECT user_a_id AS u_id, status FROM swaps WHERE user_a_id = ANY($1::int[])
           UNION ALL
           SELECT user_b_id AS u_id, status FROM swaps WHERE user_b_id = ANY($1::int[])
         ) t GROUP BY u_id`,
        [userIds]
      ),
      pool.query(
        `SELECT user_id,
                COUNT(*) AS total_sessions,
                ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen) - started_at)) / 60)::numeric, 1) AS avg_session_minutes
         FROM user_sessions WHERE user_id = ANY($1::int[])
         GROUP BY user_id`,
        [userIds]
      ),
      pool.query(
        `SELECT ratee_id, ROUND(AVG(stars)::numeric, 1) AS avg_rating, COUNT(*) AS rating_count
         FROM ratings WHERE ratee_id = ANY($1::int[]) GROUP BY ratee_id`,
        [userIds]
      ),
      pool.query(
        `SELECT r.ratee_id, r.stars, r.comment, r.created_at, u.name AS reviewer_name
         FROM ratings r JOIN users u ON u.id = r.rater_id
         WHERE r.ratee_id = ANY($1::int[]) ORDER BY r.created_at DESC`,
        [userIds]
      ),
    ]);

    // Build lookup maps
    const stickers = Object.fromEntries(stickerRes.rows.map(r => [r.user_id, r]));
    const swaps = Object.fromEntries(swapRes.rows.map(r => [r.u_id, r]));
    const sessions = Object.fromEntries(sessionRes.rows.map(r => [r.user_id, r]));
    const ratings = Object.fromEntries(ratingRes.rows.map(r => [r.ratee_id, r]));
    const reviewsByUser = {};
    reviewRes.rows.forEach(r => {
      if (!reviewsByUser[r.ratee_id]) reviewsByUser[r.ratee_id] = [];
      if (reviewsByUser[r.ratee_id].length < 5) reviewsByUser[r.ratee_id].push(r);
    });

    const result = rows.map(u => ({
      ...u,
      duplicates_count: stickers[u.id]?.duplicates_count || 0,
      needs_count: stickers[u.id]?.needs_count || 0,
      swaps_count: swaps[u.id]?.swaps_count || 0,
      completed_swaps: swaps[u.id]?.completed_swaps || 0,
      total_sessions: sessions[u.id]?.total_sessions || 0,
      avg_session_minutes: sessions[u.id]?.avg_session_minutes || null,
      avg_rating: ratings[u.id]?.avg_rating || null,
      rating_count: ratings[u.id]?.rating_count || 0,
      recent_reviews: reviewsByUser[u.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics', detail: err.message });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/swaps
// All swaps with participant names, status, sticker counts.
// Optional ?status= filter (proposed, accepted, posted, completed,
// declined, disputed). Ordered by most recently updated first.
// ----------------------------------------------------------------
router.get('/swaps', async (req, res) => {
  const { status } = req.query;
  try {
    const conditions = status ? `WHERE s.status = $1` : '';
    const params = status ? [status] : [];
    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.created_at,
         s.updated_at,
         s.user_a_accepted,
         s.user_b_accepted,
         s.user_a_posted,
         s.user_b_posted,
         s.user_a_received,
         s.user_b_received,
         s.decline_reason,
         s.declined_by_id,
         ua.name  AS user_a_name,
         ua.email AS user_a_email,
         ub.name  AS user_b_name,
         ub.email AS user_b_email,
         COUNT(si.id)                                          AS total_stickers,
         COUNT(si.id) FILTER (WHERE si.from_user_id = s.user_a_id) AS a_gives,
         COUNT(si.id) FILTER (WHERE si.from_user_id = s.user_b_id) AS b_gives
       FROM swaps s
       JOIN users ua ON ua.id = s.user_a_id
       JOIN users ub ON ub.id = s.user_b_id
       LEFT JOIN swap_items si ON si.swap_id = s.id
       ${conditions}
       GROUP BY s.id, ua.name, ua.email, ub.name, ub.email
       ORDER BY s.updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch swaps' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/broadcast-one
// Send a notification to a single specific user.
// Body: { userId, title, body }
// ----------------------------------------------------------------
router.post('/broadcast-one', async (req, res) => {
  const { userId, title, body } = req.body;
  if (!userId || !title) return res.status(400).json({ error: 'userId and title required' });
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'announcement', $2, $3)`,
      [userId, title, body || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/signups-chart
// Daily new signups for the past 30 days.
// ----------------------------------------------------------------
router.get('/signups-chart', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         DATE(created_at) AS date,
         COUNT(*) AS count
       FROM users
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch signup chart' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/swap-funnel
// Count of swaps at each status stage right now.
// ----------------------------------------------------------------
router.get('/swap-funnel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS count FROM swaps GROUP BY status ORDER BY
       CASE status
         WHEN 'proposed' THEN 1
         WHEN 'accepted' THEN 2
         WHEN 'posted' THEN 3
         WHEN 'completed' THEN 4
         WHEN 'declined' THEN 5
         WHEN 'disputed' THEN 6
         ELSE 7
       END`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch swap funnel' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/sticker-heatmap
// Top 20 most-needed and top 20 most-duplicated stickers.
// ----------------------------------------------------------------
router.get('/sticker-heatmap', async (req, res) => {
  try {
    const [neededRes, dupedRes] = await Promise.all([
      pool.query(
        `SELECT s.sticker_number, s.description, s.team_name,
                COUNT(*) AS want_count
         FROM user_needs un
         JOIN stickers s ON s.id = un.sticker_id
         GROUP BY s.id, s.sticker_number, s.description, s.team_name
         ORDER BY want_count DESC LIMIT 20`
      ),
      pool.query(
        `SELECT s.sticker_number, s.description, s.team_name,
                COUNT(*) AS have_count,
                SUM(ud.quantity) AS total_copies
         FROM user_duplicates ud
         JOIN stickers s ON s.id = ud.sticker_id
         GROUP BY s.id, s.sticker_number, s.description, s.team_name
         ORDER BY have_count DESC LIMIT 20`
      ),
    ]);
    res.json({ mostNeeded: neededRes.rows, mostDuplicated: dupedRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sticker heatmap' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/zero-stickers
// Users who signed up but have listed 0 duplicates AND 0 needs.
// ----------------------------------------------------------------
router.get('/zero-stickers', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at, u.last_login_at, u.login_count
       FROM users u
       LEFT JOIN user_duplicates ud ON ud.user_id = u.id
       LEFT JOIN user_needs un ON un.user_id = u.id
       WHERE ud.sticker_id IS NULL AND un.sticker_id IS NULL
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch zero-sticker users' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/nudge-zero-stickers
// Sends a notification (and push, where subscribed) to every user
// who's signed up but never added a duplicate or a need — a
// different message to the general auto-nudge, since these users
// haven't got anything to swap with yet. Respects the same
// last_nudge_at cooldown so it can be run safely more than once.
// ----------------------------------------------------------------
router.post('/nudge-zero-stickers', async (req, res) => {
  try {
    const { sendZeroStickerNudge } = require('../jobs/send_zero_sticker_nudge');
    const sent = await sendZeroStickerNudge();
    res.json({ success: true, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Nudge failed' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/live-locations
// Users active in the last 30 minutes with geolocation data,
// for the live map. Returns lat/lng, city, country, name.
// ----------------------------------------------------------------
router.get('/live-locations', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.geo_city AS city, u.geo_country AS country,
              u.geo_latitude AS latitude, u.geo_longitude AS longitude,
              u.last_login_at,
              COUNT(DISTINCT ud.sticker_id) AS duplicates_count,
              COUNT(DISTINCT un.sticker_id) AS needs_count
       FROM users u
       LEFT JOIN user_duplicates ud ON ud.user_id = u.id
       LEFT JOIN user_needs un ON un.user_id = u.id
       WHERE u.geo_latitude IS NOT NULL
         AND u.last_login_at > NOW() - INTERVAL '24 hours'
       GROUP BY u.id
       ORDER BY u.last_login_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch live locations' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/top-traders
// Leaderboard of users with the most completed swaps.
// ----------------------------------------------------------------
router.get('/top-traders', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email,
              COUNT(DISTINCT s.id) AS completed_swaps,
              ROUND(AVG(r.stars)::numeric, 1) AS avg_rating
       FROM users u
       JOIN swaps s ON (s.user_a_id = u.id OR s.user_b_id = u.id)
         AND s.status = 'completed'
       LEFT JOIN ratings r ON r.ratee_id = u.id
       GROUP BY u.id
       HAVING COUNT(DISTINCT s.id) > 0
       ORDER BY completed_swaps DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch top traders' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/oldest-pending
// Swaps stuck in proposed state longest — inactivity flags.
// ----------------------------------------------------------------
router.get('/oldest-pending', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.created_at, s.updated_at, s.status,
              ua.name AS user_a_name, ua.email AS user_a_email,
              ub.name AS user_b_name, ub.email AS user_b_email,
              s.user_a_accepted, s.user_b_accepted,
              EXTRACT(EPOCH FROM (NOW() - s.created_at))/86400 AS days_old
       FROM swaps s
       JOIN users ua ON ua.id = s.user_a_id
       JOIN users ub ON ub.id = s.user_b_id
       WHERE s.status = 'proposed'
       ORDER BY s.created_at ASC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch oldest pending swaps' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/dau-chart
// Daily active users for the past 30 days.
// ----------------------------------------------------------------
router.get('/dau-chart', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         DATE(last_login_at) AS date,
         COUNT(*) AS active_users
       FROM users
       WHERE last_login_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(last_login_at)
       ORDER BY date ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DAU chart' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/error-log
// Recent rate limit and error events.
// ----------------------------------------------------------------
router.get('/error-log', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM error_log ORDER BY created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch error log' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/health
// System health checks — detects known failure modes.
// ----------------------------------------------------------------
router.get('/health', async (req, res) => {
  const checks = [];
  const start = Date.now();

  try {
    // Check 1: Database connectivity
    try {
      await pool.query('SELECT 1');
      checks.push({ name: 'Database connection', status: 'ok', message: 'Connected successfully' });
    } catch (err) {
      checks.push({ name: 'Database connection', status: 'error', message: `❌ Database unreachable: ${err.message}` });
    }

    // Check 2: v_possible_gives view — must not contain LIMIT
    const { rows: viewRows } = await pool.query(
      `SELECT pg_get_viewdef('v_possible_gives', true) AS def`
    );
    const viewDef = viewRows[0]?.def || '';
    const hasLimit = /LIMIT\s+\d+/i.test(viewDef);
    checks.push({
      name: 'Matching view (v_possible_gives)',
      status: hasLimit ? 'error' : 'ok',
      message: hasLimit
        ? '🚨 LIMIT found in view — matching is broken! Run fix_view.js immediately.'
        : 'No LIMIT — view is healthy',
    });

    // Check 3: Total rows in v_possible_gives
    const { rows: viewCountRows } = await pool.query(`SELECT COUNT(*) AS count FROM v_possible_gives`);
    const viewCount = parseInt(viewCountRows[0].count);
    checks.push({
      name: 'Possible gives (total)',
      status: viewCount === 0 ? 'error' : viewCount <= 100 ? 'warning' : 'ok',
      message: viewCount === 0
        ? '🚨 No possible gives — matching cannot work'
        : viewCount <= 100
        ? `⚠️ Only ${viewCount} — suspiciously low, may indicate a LIMIT bug`
        : `${viewCount.toLocaleString()} possible gives`,
    });

    // Check 4: Double-booking trigger exists
    const { rows: triggerRows } = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_double_booking'`
    );
    checks.push({
      name: 'Double-booking protection trigger',
      status: triggerRows.length ? 'ok' : 'error',
      message: triggerRows.length
        ? 'Trigger active — double bookings prevented at database level'
        : '🚨 Trigger missing — run fix_constraint.js immediately!',
    });

    // Check 5: Users with stickers but no matches
    const { rows: zeroMatchRows } = await pool.query(
      `SELECT COUNT(*) AS count FROM users u
       WHERE (SELECT COUNT(*) FROM user_duplicates WHERE user_id = u.id) > 0
         AND (SELECT COUNT(*) FROM user_needs WHERE user_id = u.id) > 0
         AND (SELECT COUNT(*) FROM matches WHERE (user_a_id = u.id OR user_b_id = u.id) AND status = 'pending') = 0`
    );
    const zeroMatch = parseInt(zeroMatchRows[0].count);
    checks.push({
      name: 'Users with stickers but no matches',
      status: zeroMatch > 10 ? 'warning' : 'ok',
      message: zeroMatch === 0
        ? 'All users with stickers have matches'
        : `${zeroMatch} user${zeroMatch > 1 ? 's' : ''} have stickers but no matches`,
    });

    // Check 6: Matching job last run
    const { rows: matchTimeRows } = await pool.query(`SELECT MAX(computed_at) AS last_run FROM matches`);
    const lastRun = matchTimeRows[0]?.last_run;
    const minutesAgo = lastRun ? Math.round((Date.now() - new Date(lastRun)) / 60000) : null;
    checks.push({
      name: 'Matching job last run',
      status: !lastRun ? 'warning' : minutesAgo > 10 ? 'warning' : 'ok',
      message: !lastRun
        ? '⚠️ No matches ever computed'
        : minutesAgo > 10
        ? `⚠️ Last run ${minutesAgo} minutes ago — may have stopped`
        : `Running normally — last run ${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago`,
    });

    // Check 7: Broken proposed swaps (stickers missing from duplicates)
    const { rows: brokenRows } = await pool.query(
      `SELECT COUNT(DISTINCT s.id) AS count
       FROM swaps s
       JOIN swap_items si ON si.swap_id = s.id
       LEFT JOIN user_duplicates ud ON ud.user_id = si.from_user_id AND ud.sticker_id = si.sticker_id
       WHERE s.status = 'proposed' AND ud.quantity IS NULL`
    );
    const brokenCount = parseInt(brokenRows[0].count);
    checks.push({
      name: 'Broken proposed swaps',
      status: brokenCount > 0 ? 'error' : 'ok',
      message: brokenCount === 0
        ? 'No broken swaps detected'
        : `🚨 ${brokenCount} proposed swap${brokenCount > 1 ? 's' : ''} have missing stickers — users will get accept errors!`,
    });

    // Check 8: Pending matches count
    const { rows: pendingRows } = await pool.query(`SELECT COUNT(*) AS count FROM matches WHERE status = 'pending'`);
    checks.push({
      name: 'Pending matches',
      status: 'ok',
      message: `${parseInt(pendingRows[0].count).toLocaleString()} pending matches across all users`,
    });

    // Check 9: Recent 500 errors (check if any swap proposals failed in last hour)
    const { rows: recentSwapFails } = await pool.query(
      `SELECT COUNT(*) AS count FROM swaps WHERE status = 'declined' AND decline_reason LIKE 'Automatically declined%' AND updated_at > NOW() - INTERVAL '1 hour'`
    );
    const autoDeclined = parseInt(recentSwapFails[0].count);
    checks.push({
      name: 'Auto-declined swaps (last hour)',
      status: autoDeclined > 5 ? 'warning' : 'ok',
      message: autoDeclined === 0
        ? 'No auto-declined swaps in the last hour'
        : `${autoDeclined} swap${autoDeclined > 1 ? 's' : ''} auto-declined due to stale data in the last hour`,
    });

    // Check 10: Recent login rate limit hits (last hour)
    const { rows: rateLimitRows } = await pool.query(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT ip) AS unique_ips
       FROM error_log
       WHERE type = 'rate_limit' AND path LIKE '%/auth%' AND created_at > NOW() - INTERVAL '1 hour'`
    );
    const loginErrors = parseInt(rateLimitRows[0].count);
    const uniqueIps = parseInt(rateLimitRows[0].unique_ips);
    checks.push({
      name: 'Login errors (429s) — last hour',
      status: loginErrors > 20 ? 'error' : loginErrors > 5 ? 'warning' : 'ok',
      message: loginErrors === 0
        ? 'No login rate limit errors in the last hour ✓'
        : `${loginErrors} rate limit hit${loginErrors > 1 ? 's' : ''} from ${uniqueIps} unique IP${uniqueIps > 1 ? 's' : ''} — ${loginErrors > 20 ? 'widespread issue, check rate limit config' : 'normal level'}`,
    });

    const overallStatus = checks.some(c => c.status === 'error') ? 'error'
      : checks.some(c => c.status === 'warning') ? 'warning' : 'ok';

    res.json({
      checks,
      overallStatus,
      checkedAt: new Date().toISOString(),
      responseMs: Date.now() - start,
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ error: 'Health check failed', detail: err.message });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/auto-nudge
// Send a notification to users who haven't logged in for 7+ days
// and have stickers listed. Respects last_nudge_at to avoid spam.
// ----------------------------------------------------------------
router.post('/auto-nudge', async (req, res) => {
  try {
    const { sendAutoNudge } = require('../jobs/send_auto_nudge');
    const sent = await sendAutoNudge();
    res.json({ success: true, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auto-nudge failed' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/run-proposal-expiry
// Manual trigger for the proposal expiry job.
// ----------------------------------------------------------------
router.post('/run-proposal-expiry', async (req, res) => {
  try {
    const { expireStaleProposals } = require('../jobs/expire_stale_proposals');
    await expireStaleProposals();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Proposal expiry job failed' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/run-expire-proposals
// Manual trigger for the stale-proposal expiry job.
// ----------------------------------------------------------------
router.post('/run-expire-proposals', async (req, res) => {
  try {
    const { expireStaleProposals } = require('../jobs/expire_stale_proposals');
    await expireStaleProposals();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Expire proposals job failed' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/run-posting-reminders
// Manual trigger for the "post your stickers" reminder job.
// ----------------------------------------------------------------
router.post('/run-posting-reminders', async (req, res) => {
  try {
    const { sendPostingReminders } = require('../jobs/send_posting_reminders');
    await sendPostingReminders();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Posting reminder job failed' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/run-receipt-reminders
// Manual trigger for the "confirm receipt" reminder job — nudges
// anyone who hasn't confirmed receipt on a swap stuck at 'posted'
// for 48+ hours. Lets you run it on demand instead of waiting for
// the cron job, e.g. to test it after deploying.
// ----------------------------------------------------------------
router.post('/run-receipt-reminders', async (req, res) => {
  try {
    const { sendReceiptReminders } = require('../jobs/send_receipt_reminders');
    await sendReceiptReminders();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Receipt reminder job failed' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/fraud-flags
// Users showing suspicious behaviour: accepted swaps but never posted,
// multiple no-show reports, high dispute rate.
// ----------------------------------------------------------------
router.get('/fraud-flags', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.name, u.email, u.created_at,
         u.times_reported,
         COUNT(DISTINCT s_stuck.id) AS stuck_accepted_swaps,
         COUNT(DISTINCT s_disputed.id) AS disputed_swaps,
         COUNT(DISTINCT nr.id) AS no_show_reports
       FROM users u
       LEFT JOIN swaps s_stuck ON (s_stuck.user_a_id = u.id OR s_stuck.user_b_id = u.id)
         AND s_stuck.status = 'accepted'
         AND s_stuck.updated_at < NOW() - INTERVAL '7 days'
       LEFT JOIN swaps s_disputed ON (s_disputed.user_a_id = u.id OR s_disputed.user_b_id = u.id)
         AND s_disputed.status = 'disputed'
       LEFT JOIN no_show_reports nr ON nr.reported_user_id = u.id
       GROUP BY u.id
       HAVING
         COUNT(DISTINCT s_stuck.id) > 0 OR
         COUNT(DISTINCT s_disputed.id) > 1 OR
         COUNT(DISTINCT nr.id) > 0 OR
         u.times_reported > 1
       ORDER BY (COUNT(DISTINCT nr.id) + COUNT(DISTINCT s_disputed.id) + COALESCE(u.times_reported, 0)) DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fraud flags' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/moderation/cases
// Unified moderation view: one row per flagged user, combining
// disputes, no-show reports, reported messages, and times_reported
// into a single case, with a severity rating and a section
// ('suspended' | 'needs_attention' | 'resolved') the dashboard
// uses to sort things into collapsible groups.
// ----------------------------------------------------------------
router.get('/moderation/cases', async (req, res) => {
  try {
    const { rows: candidateRows } = await pool.query(`
      SELECT DISTINCT id FROM (
        SELECT id FROM users WHERE times_reported > 0
        UNION SELECT against_id AS id FROM disputes
        UNION SELECT reported_user_id AS id FROM no_show_reports
        UNION SELECT sender_id AS id FROM direct_messages WHERE reported = TRUE
        UNION SELECT user_id AS id FROM moderation_case_status
      ) t
    `);
    const userIds = candidateRows.map(r => r.id);
    if (!userIds.length) return res.json([]);

    const [usersRes, disputesRes, noShowRes, msgRes, stuckRes, statusRes, actionsRes] = await Promise.all([
      pool.query(
        `SELECT id, name, email, times_reported, is_suspended, created_at
         FROM users WHERE id = ANY($1::int[])`,
        [userIds]
      ),
      pool.query(
        `SELECT d.*, raiser.name AS raised_by_name, raiser.email AS raised_by_email
         FROM disputes d
         JOIN users raiser ON raiser.id = d.raised_by_id
         WHERE d.against_id = ANY($1::int[])
         ORDER BY d.created_at DESC`,
        [userIds]
      ),
      pool.query(
        `SELECT nr.*, reporter.name AS reporter_name
         FROM no_show_reports nr
         JOIN users reporter ON reporter.id = nr.reporter_id
         WHERE nr.reported_user_id = ANY($1::int[])
         ORDER BY nr.created_at DESC`,
        [userIds]
      ),
      pool.query(
        `SELECT dm.id, dm.sender_id, dm.body, dm.created_at
         FROM direct_messages dm
         WHERE dm.sender_id = ANY($1::int[]) AND dm.reported = TRUE
         ORDER BY dm.created_at DESC`,
        [userIds]
      ),
      pool.query(
        `SELECT u.id,
                COUNT(DISTINCT s_stuck.id) AS stuck_accepted_swaps,
                COUNT(DISTINCT s_disputed.id) AS disputed_swaps
         FROM users u
         LEFT JOIN swaps s_stuck ON (s_stuck.user_a_id = u.id OR s_stuck.user_b_id = u.id)
           AND s_stuck.status = 'accepted' AND s_stuck.updated_at < NOW() - INTERVAL '7 days'
         LEFT JOIN swaps s_disputed ON (s_disputed.user_a_id = u.id OR s_disputed.user_b_id = u.id)
           AND s_disputed.status = 'disputed'
         WHERE u.id = ANY($1::int[])
         GROUP BY u.id`,
        [userIds]
      ),
      pool.query(`SELECT * FROM moderation_case_status WHERE user_id = ANY($1::int[])`, [userIds]),
      pool.query(
        `SELECT * FROM admin_actions WHERE target_user_id = ANY($1::int[]) ORDER BY created_at DESC`,
        [userIds]
      ),
    ]);

    const disputesByUser = {};
    disputesRes.rows.forEach(d => { (disputesByUser[d.against_id] = disputesByUser[d.against_id] || []).push(d); });
    const noShowByUser = {};
    noShowRes.rows.forEach(r => { (noShowByUser[r.reported_user_id] = noShowByUser[r.reported_user_id] || []).push(r); });
    const msgByUser = {};
    msgRes.rows.forEach(m => { (msgByUser[m.sender_id] = msgByUser[m.sender_id] || []).push(m); });
    const stuckByUser = Object.fromEntries(stuckRes.rows.map(r => [r.id, r]));
    const statusByUser = Object.fromEntries(statusRes.rows.map(r => [r.user_id, r]));
    const actionsByUser = {};
    actionsRes.rows.forEach(a => { (actionsByUser[a.target_user_id] = actionsByUser[a.target_user_id] || []).push(a); });

    const cases = usersRes.rows.map(u => {
      const disputes = disputesByUser[u.id] || [];
      const noShows = noShowByUser[u.id] || [];
      const reportedMsgs = msgByUser[u.id] || [];
      const stuck = stuckByUser[u.id] || { stuck_accepted_swaps: 0, disputed_swaps: 0 };
      const openDisputes = disputes.filter(d => ['open', 'reviewing'].includes(d.status));
      const manualStatus = statusByUser[u.id] && statusByUser[u.id].status;

      let section;
      if (u.is_suspended) {
        section = 'suspended';
      } else if (openDisputes.length > 0 || parseInt(stuck.stuck_accepted_swaps, 10) > 0) {
        // Something is still genuinely open — can't be manually resolved
        // away until that's dealt with.
        section = 'needs_attention';
      } else if (manualStatus === 'resolved') {
        // Admin has explicitly cleared this case. times_reported is a
        // lifetime counter that doesn't go back down on its own, so it
        // shouldn't be able to override a manual resolve.
        section = 'resolved';
      } else if (u.times_reported > 0 || noShows.length > 0 || reportedMsgs.length > 0) {
        section = 'needs_attention';
      } else {
        section = 'resolved';
      }

      const severity =
        u.times_reported >= 3 || parseInt(stuck.stuck_accepted_swaps, 10) > 0 || openDisputes.length > 1
          ? 'high'
          : u.times_reported > 0 || openDisputes.length > 0 || noShows.length > 0
          ? 'medium'
          : 'low';

      // Unique list of everyone who's reported/disputed this user, so the
      // dashboard can offer a "message" thread to each of them, not just
      // the reported user themselves.
      const reporterMap = {};
      disputes.forEach(d => { reporterMap[d.raised_by_id] = { id: d.raised_by_id, name: d.raised_by_name }; });
      noShows.forEach(r => { reporterMap[r.reporter_id] = { id: r.reporter_id, name: r.reporter_name }; });
      const reporters = Object.values(reporterMap);

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        is_suspended: u.is_suspended,
        times_reported: u.times_reported || 0,
        created_at: u.created_at,
        disputes,
        no_show_reports: noShows,
        reported_messages: reportedMsgs,
        reporters,
        action_history: (actionsByUser[u.id] || []).slice(0, 15),
        stuck_accepted_swaps: parseInt(stuck.stuck_accepted_swaps, 10) || 0,
        open_dispute_count: openDisputes.length,
        section,
        severity,
        case_note: (statusByUser[u.id] && statusByUser[u.id].note) || null,
      };
    });

    const order = { high: 0, medium: 1, low: 2 };
    cases.sort((a, b) => order[a.severity] - order[b.severity]);

    res.json(cases);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch moderation cases' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/moderation/case/:userId/resolve
// Body: { resolved: true|false, note }
// Manually marks a flagged user's case as resolved or reopened —
// this is what moves them between the Needs attention and
// Resolved sections when there's nothing left auto-tracking it
// (e.g. a no-show report, which has no built-in status).
// ----------------------------------------------------------------
router.post('/moderation/case/:userId/resolve', async (req, res) => {
  const { resolved, note } = req.body;
  const status = resolved ? 'resolved' : 'needs_attention';
  try {
    await pool.query(
      `INSERT INTO moderation_case_status (user_id, status, note, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET status = $2, note = $3, updated_at = NOW()`,
      [req.params.userId, status, note || null]
    );
    await pool.query(
      `INSERT INTO admin_actions (action_type, target_user_id, note)
       VALUES ($1, $2, $3)`,
      [resolved ? 'resolve_case' : 'reopen_case', req.params.userId, note || null]
    );
    res.json({ success: true, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update case status' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/moderation/thread/:userId
// Fetches the admin-support conversation with a specific user, if
// one exists — used to show reply threads on moderation case cards.
// ----------------------------------------------------------------
router.get('/moderation/thread/:userId', async (req, res) => {
  const ADMIN_SENDER_ID = 121;
  try {
    const { rows: convRows } = await pool.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2`,
      [ADMIN_SENDER_ID, req.params.userId]
    );
    if (!convRows.length) return res.json({ conversationId: null, messages: [] });

    const conversationId = convRows[0].id;
    const { rows: messages } = await pool.query(
      `SELECT dm.id, dm.sender_id, dm.body, dm.created_at, u.name AS sender_name,
              (dm.sender_id = $2) AS is_admin
       FROM direct_messages dm
       JOIN users u ON u.id = dm.sender_id
       WHERE dm.conversation_id = $1
       ORDER BY dm.created_at ASC`,
      [conversationId, ADMIN_SENDER_ID]
    );
    res.json({ conversationId, messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch message thread' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/moderation/message
// Body: { userId, message, isWarning }
// Sends a message to a user via the admin-support conversation —
// used both for the one-off "Send warning" action and for ordinary
// back-and-forth replies on a moderation case. Logs the action so
// it shows up in that user's case history and the action log.
// ----------------------------------------------------------------
router.post('/moderation/message', async (req, res) => {
  const { userId, message, isWarning } = req.body;
  if (!userId || !message || !message.trim()) {
    return res.status(400).json({ error: 'userId and message are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ADMIN_SENDER_ID = 121; // "Got One Spare? Support" system account

    const { rows: existing } = await client.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2`,
      [ADMIN_SENDER_ID, userId]
    );

    let conversationId;
    if (existing.length > 0) {
      conversationId = existing[0].id;
    } else {
      const { rows: newConv } = await client.query(`INSERT INTO conversations DEFAULT VALUES RETURNING id`);
      conversationId = newConv[0].id;
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [conversationId, ADMIN_SENDER_ID, userId]
      );
    }

    await client.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, body) VALUES ($1, $2, $3)`,
      [conversationId, ADMIN_SENDER_ID, message.trim()]
    );

    await client.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'direct_message', $2, $3)`,
      [
        userId,
        isWarning ? '⚠️ A message from Got One Spare? Support' : 'New message from Got One Spare? Support',
        message.trim().substring(0, 100),
      ]
    ).catch(() => {});

    await client.query(
      `INSERT INTO admin_actions (action_type, target_user_id, note) VALUES ($1, $2, $3)`,
      [isWarning ? 'warn' : 'message', userId, message.trim()]
    );

    await client.query('COMMIT');

    const { sendPushNotification } = require('./push');
    sendPushNotification(userId, {
      title: isWarning ? '⚠️ Message from Got One Spare?' : '💬 New message from Got One Spare?',
      body: message.trim().slice(0, 80),

    }).catch(() => {});

    res.json({ success: true, conversationId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to send warning' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/admin/moderation/log
// Recent moderation actions (suspensions, warnings, dispute
// resolutions, case status changes) — powers the Action log
// section at the bottom of the Moderation tab.
// ----------------------------------------------------------------
router.get('/moderation/log', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.name AS target_user_name, u.email AS target_user_email
       FROM admin_actions a
       LEFT JOIN users u ON u.id = a.target_user_id
       ORDER BY a.created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch action log' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/messages
// All conversations across the platform for admin oversight.
// ----------------------------------------------------------------
router.get('/messages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.id AS conversation_id,
         u1.name AS user_a_name, u1.email AS user_a_email,
         u2.name AS user_b_name, u2.email AS user_b_email,
         COUNT(dm.id) AS message_count,
         COUNT(dm.id) FILTER (WHERE dm.reported) AS reported_count,
         MAX(dm.created_at) AS last_message_at
       FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id > cp1.user_id
       JOIN users u1 ON u1.id = cp1.user_id
       JOIN users u2 ON u2.id = cp2.user_id
       LEFT JOIN direct_messages dm ON dm.conversation_id = c.id
       GROUP BY c.id, u1.name, u1.email, u2.name, u2.email
       ORDER BY last_message_at DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/messages/:conversationId
// Full message thread for admin review.
// ----------------------------------------------------------------
router.get('/messages/:conversationId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dm.*, u.name AS sender_name, u.email AS sender_email
       FROM direct_messages dm
       JOIN users u ON u.id = dm.sender_id
       WHERE dm.conversation_id = $1
       ORDER BY dm.created_at ASC`,
      [req.params.conversationId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/reported-messages
// All reported messages for moderation.
// ----------------------------------------------------------------
router.get('/reported-messages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dm.*, u.name AS sender_name, u.email AS sender_email,
              u2.name AS recipient_name
       FROM direct_messages dm
       JOIN users u ON u.id = dm.sender_id
       JOIN conversation_participants cp ON cp.conversation_id = dm.conversation_id AND cp.user_id != dm.sender_id
       JOIN users u2 ON u2.id = cp.user_id
       WHERE dm.reported = TRUE
       ORDER BY dm.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reported messages' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/messages/send
// Admin sends a direct message to any user.
// ----------------------------------------------------------------
router.post('/messages/send', async (req, res) => {
  const { recipientId, body } = req.body;
  if (!recipientId || !body?.trim()) {
    return res.status(400).json({ error: 'recipientId and body required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Use a special admin user ID of 0 — or find/create an admin system user
    // For now, find the first admin-created user or use a placeholder
    const ADMIN_SENDER_ID = 121; // "Got One Spare? Support" system account

    const { rows: existing } = await client.query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
       JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2`,
      [ADMIN_SENDER_ID, recipientId]
    );

    let conversationId;
    if (existing.length > 0) {
      conversationId = existing[0].id;
    } else {
      const { rows: newConv } = await client.query(
        `INSERT INTO conversations DEFAULT VALUES RETURNING id`
      );
      conversationId = newConv[0].id;
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [conversationId, ADMIN_SENDER_ID, recipientId]
      );
    }

    await client.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)`,
      [conversationId, ADMIN_SENDER_ID, body.trim()]
    );

    await client.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'direct_message', 'New message from Got One Spare? Support', $2)`,
      [recipientId, body.trim().substring(0, 100)]
    ).catch(() => {});

    await client.query('COMMIT');

    // Push notification
    const { sendPushNotification } = require('./push');
    sendPushNotification(recipientId, {
      title: '💬 New message from Got One Spare?',
      body: body.trim().slice(0, 80),
    }).catch(() => {});

    res.json({ success: true, conversationId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------
// GET /api/admin/overview
// High-level platform stats: totals, recent activity.
// ----------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const [usersRes, swapsRes, matchesRes, feedbackRes] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_users_7d,
        COUNT(*) FILTER (WHERE last_login_at > NOW() - INTERVAL '7 days') AS active_7d,
        COUNT(*) FILTER (WHERE last_login_at > NOW() - INTERVAL '24 hours') AS active_24h
        FROM users`),
      pool.query(`SELECT
        COUNT(*) AS total_swaps,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'proposed' OR status = 'accepted') AS active,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_7d
        FROM swaps`),
      pool.query(`SELECT COUNT(*) AS pending_matches FROM matches WHERE status = 'pending'`),
      pool.query(`SELECT COUNT(*) AS total_feedback FROM feedback`),
    ]);
    res.json({
      users: usersRes.rows[0],
      swaps: swapsRes.rows[0],
      matches: matchesRes.rows[0],
      feedback: feedbackRes.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/broadcast
// Send a notification to every active user at once.
// Body: { title, body, type }
// ----------------------------------------------------------------
router.post('/broadcast', async (req, res) => {
  const { title, body, type = 'announcement' } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const { sendBroadcastToAllUsers } = require('./broadcast');
    const { sentCount, pushCount } = await sendBroadcastToAllUsers(pool, { title, body, type });
    console.log(`[BROADCAST] Push sent to ${pushCount} subscribers`);
    res.json({ sent: sentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/scheduled-announcements
// Queue an announcement to be sent at a future date/time by the
// send-scheduled-announcements cron job, instead of immediately.
// Body: { title, body, sendAt } — sendAt is an ISO datetime string.
// ----------------------------------------------------------------
router.post('/scheduled-announcements', async (req, res) => {
  const { title, body, sendAt } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const sendAtDate = new Date(sendAt);
  if (!sendAt || Number.isNaN(sendAtDate.getTime())) {
    return res.status(400).json({ error: 'A valid sendAt date/time is required' });
  }
  if (sendAtDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'sendAt must be in the future' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduled_announcements (title, body, send_at)
       VALUES ($1, $2, $3) RETURNING *`,
      [title.trim(), body?.trim() || null, sendAtDate.toISOString()]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to schedule announcement' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/scheduled-announcements
// List scheduled announcements, most recently created first.
// ----------------------------------------------------------------
router.get('/scheduled-announcements', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_announcements ORDER BY send_at ASC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scheduled announcements' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/admin/scheduled-announcements/:id
// Cancel a scheduled announcement — only while still pending.
// ----------------------------------------------------------------
router.delete('/scheduled-announcements/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE scheduled_announcements SET status = 'cancelled'
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(400).json({ error: 'Announcement not found or already sent/cancelled' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel scheduled announcement' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/feedback/:id/resolve
// Mark feedback as fixed or declined, and send the user a
// notification via their bell. Only works for logged-in submissions.
// Body: { status: 'fixed' | 'declined' }
// ----------------------------------------------------------------
router.post('/feedback/:id/resolve', async (req, res) => {
  const { status, notify = true } = req.body;
  if (!['fixed', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'status must be fixed or declined' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE feedback SET status = $1 WHERE id = $2
       RETURNING *, (SELECT name FROM users WHERE id = feedback.user_id) AS user_name`,
      [status, req.params.id]
    );
    const feedback = rows[0];
    if (!feedback) return res.status(404).json({ error: 'Feedback not found' });

    // Only send notification if notify is true and the feedback has a user
    if (notify && feedback.user_id) {
      const messages = {
        fixed: {
          title: '✅ Your feedback has been implemented!',
          body: `You said: "${feedback.message.slice(0, 120)}${feedback.message.length > 120 ? '…' : ''}"\n\nGreat news — this has been added to Got One Spare? Give the site a quick refresh and you should see the change. Thank you so much for taking the time to send feedback, it genuinely makes the platform better. Keep it coming — every piece of feedback helps as we work towards the full launch! 🙌`,
        },
        declined: {
          title: '👋 An update on your feedback',
          body: `You said: "${feedback.message.slice(0, 120)}${feedback.message.length > 120 ? '…' : ''}"\n\nThanks so much — we've read it carefully and really appreciate you taking the time. This particular suggestion isn't something we're able to implement right now, but we've noted it down and may well revisit it in the future. Please keep the feedback coming — it all helps as we work towards launching to everyone! 🙏`,
        },
      };
      const msg = messages[status];
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'announcement', $2, $3)`,
        [feedback.user_id, msg.title, msg.body]
      );
    }

    res.json({ success: true, status, notify, userName: feedback.user_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve feedback' });
  }
});

// ----------------------------------------------------------------
// POST /api/admin/feedback/:id/reply
// Send a notification reply to the user who submitted a specific
// piece of feedback. Only works if the feedback was submitted by
// a logged-in user (anonymous submissions can't be replied to).
// ----------------------------------------------------------------
router.post('/feedback/:id/reply', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.name AS user_name FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.id = $1`,
      [req.params.id]
    );
    const feedback = rows[0];
    if (!feedback) return res.status(404).json({ error: 'Feedback not found' });
    if (!feedback.user_id) {
      return res.status(400).json({ error: 'This feedback was submitted anonymously — no user to notify' });
    }
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body)
       VALUES ($1, 'announcement', $2, $3)`,
      [
        feedback.user_id,
        'Reply to your feedback',
        `You said: "${feedback.message.slice(0, 120)}${feedback.message.length > 120 ? '…' : ''}"\n\n${message.trim()}`,
      ]
    );
    res.json({ success: true, sentTo: feedback.user_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/invites-list
// Lists all invite codes (proxies through admin auth rather than
// requiring the public invites endpoint).
// ----------------------------------------------------------------
router.get('/invites-list', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS used_by_name, u.email AS used_by_email
       FROM invite_codes i
       LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch codes' });
  }
});

// POST /api/admin/test-push — send a test push to a specific user
router.post('/test-push', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const { sendPushNotification } = require('./push');
    await sendPushNotification(userId, {
      title: '🔔 Test notification',
      body: 'Push notifications are working on Got One Spare?',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Test push error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/app-survey
// Returns app-interest survey results + PWA install stats for the admin dashboard.
// ----------------------------------------------------------------
router.get('/app-survey', async (req, res) => {
  try {
    const [survey, phoneOs, installs, pushSubs, installUsers, pushUsers] = await Promise.all([
      pool.query(`SELECT wants_app, COUNT(*) AS count FROM app_interest_survey GROUP BY wants_app`),
      pool.query(`SELECT phone_os, COUNT(*) AS count FROM app_interest_survey GROUP BY phone_os ORDER BY count DESC`),
      pool.query(`SELECT COUNT(*) FROM users WHERE pwa_installed_at IS NOT NULL`),
      pool.query(`SELECT COUNT(*) FROM users WHERE push_subscription IS NOT NULL`),
      pool.query(`SELECT name, email, pwa_installed_at FROM users WHERE pwa_installed_at IS NOT NULL ORDER BY pwa_installed_at DESC`),
      pool.query(`SELECT name, email FROM users WHERE push_subscription IS NOT NULL ORDER BY name ASC`),
    ]);

    const totalResponses = survey.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
    const yesCount = parseInt(survey.rows.find(r => r.wants_app === true)?.count || 0, 10);
    const noCount = parseInt(survey.rows.find(r => r.wants_app === false)?.count || 0, 10);
    const PHONE_LABELS = { ios: 'iPhone (iOS)', android: 'Android', neither: 'Neither' };

    res.json({
      totalResponses,
      wantsApp: {
        yes: yesCount,
        no: noCount,
        yesPct: totalResponses > 0 ? Math.round((yesCount / totalResponses) * 100) : 0,
      },
      phoneOs: phoneOs.rows.map(r => ({
        key: r.phone_os,
        label: PHONE_LABELS[r.phone_os] || r.phone_os,
        count: parseInt(r.count, 10),
        pct: totalResponses > 0 ? Math.round((parseInt(r.count, 10) / totalResponses) * 100) : 0,
      })),
      pwaInstalls: parseInt(installs.rows[0].count),
      pushSubscribers: parseInt(pushSubs.rows[0].count),
      installUsers: installUsers.rows,
      pushUsers: pushUsers.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

module.exports = router;
