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
