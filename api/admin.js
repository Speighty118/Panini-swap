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
  const { status } = req.body;
  const valid = ['open', 'reviewing', 'resolved', 'dismissed'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
  }
  try {
    const resolvedAt = ['resolved', 'dismissed'].includes(status) ? new Date() : null;
    const { rows } = await pool.query(
      `UPDATE disputes SET status = $1, resolved_at = $2 WHERE id = $3 RETURNING *`,
      [status, resolvedAt, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Dispute not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update dispute' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin/users/:id/suspend
// Body: { suspended: true | false }
// ----------------------------------------------------------------
router.post('/users/:id/suspend', async (req, res) => {
  const { suspended } = req.body;
  if (typeof suspended !== 'boolean') {
    return res.status(400).json({ error: 'suspended must be true or false' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_suspended = $1 WHERE id = $2 RETURNING id, name, email, is_suspended`,
      [suspended, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
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
    const { rows } = await pool.query(
      `SELECT
          u.id, u.name, u.email, u.created_at, u.last_login_at,
          u.login_count, u.is_suspended, u.email_verified,
          u.times_reported, u.profile_photo,
          COUNT(DISTINCT ud.sticker_id) AS duplicates_count,
          COUNT(DISTINCT un.sticker_id) AS needs_count,
          COUNT(DISTINCT s.id) AS swaps_count,
          COUNT(DISTINCT CASE WHEN s.status = 'completed' THEN s.id END) AS completed_swaps,
          MAX(s.updated_at) AS last_swap_activity,
          ROUND(AVG(sess.session_minutes)::numeric, 1) AS avg_session_minutes,
          COUNT(DISTINCT sess.id) AS total_sessions,
          ROUND(AVG(r.stars)::numeric, 1) AS avg_rating,
          COUNT(DISTINCT r.id) AS rating_count
       FROM users u
       LEFT JOIN user_duplicates ud ON ud.user_id = u.id
       LEFT JOIN user_needs un ON un.user_id = u.id
       LEFT JOIN swaps s ON (s.user_a_id = u.id OR s.user_b_id = u.id)
       LEFT JOIN (
         SELECT user_id, id,
           EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen) - started_at)) / 60 AS session_minutes
         FROM user_sessions
       ) sess ON sess.user_id = u.id
       LEFT JOIN ratings r ON r.ratee_id = u.id
       GROUP BY u.id
       ORDER BY u.last_login_at DESC NULLS LAST`
    );

    // Fetch reviews separately to avoid subquery issues with json_agg
    const userIds = rows.map(r => r.id);
    let reviewsByUser = {};
    if (userIds.length > 0) {
      const { rows: reviews } = await pool.query(
        `SELECT r.ratee_id, r.stars, r.comment, r.created_at, u.name AS reviewer_name
         FROM ratings r
         JOIN users u ON u.id = r.rater_id
         WHERE r.ratee_id = ANY($1::int[])
         ORDER BY r.created_at DESC`,
        [userIds]
      );
      reviews.forEach(r => {
        if (!reviewsByUser[r.ratee_id]) reviewsByUser[r.ratee_id] = [];
        if (reviewsByUser[r.ratee_id].length < 5) reviewsByUser[r.ratee_id].push(r);
      });
    }

    const result = rows.map(r => ({
      ...r,
      recent_reviews: reviewsByUser[r.id] || [],
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
// GET /api/admin/health
// System health checks — detects known failure modes like the
// LIMIT 100 bug on v_possible_gives, matching job activity, etc.
// ----------------------------------------------------------------
router.get('/health', async (req, res) => {
  const checks = [];

  try {
    // Check 1: v_possible_gives view definition — must not contain LIMIT
    const { rows: viewRows } = await pool.query(
      `SELECT pg_get_viewdef('v_possible_gives', true) AS def`
    );
    const viewDef = viewRows[0]?.def || '';
    const hasLimit = /LIMIT\s+\d+/i.test(viewDef);
    checks.push({
      name: 'Matching view (v_possible_gives)',
      status: hasLimit ? 'error' : 'ok',
      message: hasLimit
        ? '⚠️ LIMIT found in view definition — matching will be restricted! Run fix_view.js immediately.'
        : 'No LIMIT — view is healthy',
    });

    // Check 2: Total rows in v_possible_gives
    const { rows: viewCountRows } = await pool.query(
      `SELECT COUNT(*) AS count FROM v_possible_gives`
    );
    const viewCount = parseInt(viewCountRows[0].count);
    checks.push({
      name: 'Possible gives (total)',
      status: viewCount === 0 ? 'warning' : viewCount <= 100 ? 'warning' : 'ok',
      message: viewCount === 0
        ? '⚠️ No possible gives found — matching cannot work'
        : viewCount <= 100
        ? `⚠️ Only ${viewCount} possible gives — suspiciously low, may indicate a LIMIT bug`
        : `${viewCount.toLocaleString()} possible gives found`,
    });

    // Check 3: Users with 0 matches despite having both dupes and needs
    const { rows: zeroMatchRows } = await pool.query(
      `SELECT COUNT(*) AS count FROM users u
       WHERE (SELECT COUNT(*) FROM user_duplicates WHERE user_id = u.id) > 0
         AND (SELECT COUNT(*) FROM user_needs WHERE user_id = u.id) > 0
         AND (SELECT COUNT(*) FROM matches WHERE (user_a_id = u.id OR user_b_id = u.id) AND status = 'pending') = 0`
    );
    const zeroMatch = parseInt(zeroMatchRows[0].count);
    checks.push({
      name: 'Users with stickers but no matches',
      status: zeroMatch > 5 ? 'warning' : 'ok',
      message: zeroMatch === 0
        ? 'All users with stickers have at least one match'
        : `${zeroMatch} user${zeroMatch > 1 ? 's' : ''} have stickers but no matches — could be normal if new, or may indicate a matching issue`,
    });

    // Check 4: Matching job last run — check most recent match creation time
    const { rows: matchTimeRows } = await pool.query(
      `SELECT MAX(computed_at) AS last_run FROM matches`
    );
    const lastRun = matchTimeRows[0]?.last_run;
    const minutesAgo = lastRun ? Math.round((Date.now() - new Date(lastRun)) / 60000) : null;
    checks.push({
      name: 'Matching job last run',
      status: !lastRun ? 'warning' : minutesAgo > 10 ? 'warning' : 'ok',
      message: !lastRun
        ? '⚠️ No matches ever computed — matching job may never have run'
        : minutesAgo > 10
        ? `⚠️ Last run ${minutesAgo} minutes ago — matching job may have stopped`
        : `Running normally — last run ${minutesAgo} minute${minutesAgo !== 1 ? 's' : ''} ago`,
    });

    // Check 5: Pending matches count
    const { rows: pendingRows } = await pool.query(
      `SELECT COUNT(*) AS count FROM matches WHERE status = 'pending'`
    );
    checks.push({
      name: 'Pending matches',
      status: 'ok',
      message: `${parseInt(pendingRows[0].count).toLocaleString()} pending matches across all users`,
    });

    res.json({ checks, checkedAt: new Date().toISOString() });
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
    const { rows: users } = await pool.query(
      `SELECT u.id, u.name FROM users u
       WHERE u.last_login_at < NOW() - INTERVAL '7 days'
         AND (u.last_nudge_at IS NULL OR u.last_nudge_at < NOW() - INTERVAL '7 days')
         AND u.email_verified = TRUE
         AND u.is_suspended = FALSE
         AND (
           EXISTS (SELECT 1 FROM user_duplicates WHERE user_id = u.id) OR
           EXISTS (SELECT 1 FROM user_needs WHERE user_id = u.id)
         )`
    );

    let sent = 0;
    for (const user of users) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, 'nudge', 'Any new stickers? 👀', 'It''s been a while! Pop back to check your matches — new swap partners may have joined since your last visit.')`,
        [user.id]
      );
      await pool.query(
        `UPDATE users SET last_nudge_at = NOW() WHERE id = $1`,
        [user.id]
      );
      sent++;
    }

    res.json({ success: true, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auto-nudge failed' });
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
    const { rows: users } = await pool.query(
      `SELECT id FROM users WHERE is_suspended = FALSE AND is_active = TRUE`
    );
    for (const user of users) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1, $2, $3, $4)`,
        [user.id, type, title.trim(), body?.trim() || null]
      );
    }
    res.json({ sent: users.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send broadcast' });
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

module.exports = router;
