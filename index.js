/**
 * Main app entrypoint.
 *
 * Env vars required:
 *   DATABASE_URL      - postgres connection string
 *   JWT_SECRET        - secret for signing auth tokens
 *   PORT              - (optional) defaults to 3000
 *   CORS_ORIGIN       - (optional) frontend origin
 *   SENTRY_DSN        - (optional) Sentry DSN for error tracking
 *
 * Run: node index.js
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./api/auth');
const albumRoutes = require('./api/albums');
const stickerRoutes = require('./api/stickers');
const swapRoutes = require('./api/swaps');
const ratingRoutes = require('./api/ratings');
const disputeRoutes = require('./api/disputes');
const adminRoutes = require('./api/admin');
const messageRoutes = require('./api/messages');
const { router: notificationRoutes } = require('./api/notifications');
const inviteRoutes = require('./api/invites');
const feedbackRoutes = require('./api/feedback');
const donationRoutes = require('./api/donations');
const badgeRoutes = require('./api/badges');
const reportRoutes = require('./api/reports');
const appSurveyRoutes = require('./api/app_survey');
const announcementRoutes = require('./api/announcements');
const pushRoutes = require('./api/push');
const messagingRoutes = require('./api/messaging');
const ambassadorRoutes = require('./api/ambassador');
const founderRoutes = require('./api/founder');
const pl2026Routes = require('./api/pl2026');
const { runMatchingJob } = require('./jobs/run_matching');

const app = express();
app.set('trust proxy', 1); // Trust Railway's proxy for rate limiting and IP detection

// ---- Security & parsing middleware ----
app.use(helmet());

// Stripe webhook MUST be mounted before express.json() below, using
// the RAW request body (not JSON-parsed) — Stripe signs the exact raw
// bytes, so verification fails if the body has already been parsed.
app.use(
  '/api/founder/webhook',
  express.raw({ type: 'application/json' }),
  require('./api/founder')
);

app.use(express.json({ limit: '2mb' }));
// CORS is applied per-path rather than globally, so each request is
// handled by exactly one CORS configuration with no ordering ambiguity.
//
// Admin routes (admin.html, opened locally or hosted separately) allow
// any origin — safe, since every /api/admin route is independently
// gated by the ADMIN_SECRET check in api/admin.js regardless of origin.
//
// Everything else is restricted to CORS_ORIGIN, which may be a single
// origin or a comma-separated list (e.g. both the apex and www version
// of a custom domain): "https://gotonespare.com,https://www.gotonespare.com"
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const restrictedCors = cors({
  origin: (origin, callback) => {
    // requests with no Origin header (server-to-server, curl, etc.)
    // are allowed through; browser requests always send Origin.
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
});
// Admin-accessible routes (admin.html is a local file with null origin,
// so these need permissive CORS — all are protected by their own auth).
const adminCors = cors({ origin: '*' });
const ADMIN_PATHS = ['/api/admin', '/api/invites', '/api/feedback', '/api/donations', '/api/reports', '/api/announcements', '/api/ambassador/admin', '/api/founder/admin', '/api/pl2026/admin'];

ADMIN_PATHS.forEach(path => app.use(path, adminCors));

app.use((req, res, next) => {
  if (ADMIN_PATHS.some(p => req.path.startsWith(p))) return next();
  restrictedCors(req, res, next);
});

// Basic rate limiting — protects login/signup from brute force.
// keyGenerator uses the real client IP from X-Forwarded-For, not the proxy IP.
const realIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.ip;
};

// Log rate limit hits to the database so we can monitor them in the health panel
const { Pool: LogPool } = require('pg');
const logPool = new LogPool({ connectionString: process.env.DATABASE_URL });

const logRateLimit = (req, res) => {
  const ip = realIp(req);
  logPool.query(
    `INSERT INTO error_log (type, message, ip, path) VALUES ('rate_limit', '429 Too Many Requests', $1, $2)`,
    [ip, req.path]
  ).catch(() => {});
  res.status(429).json({
    error: req.path.startsWith('/api/auth')
      ? 'Too many login attempts from this device. Please wait a few minutes and try again, or switch between WiFi and mobile data.'
      : 'Too many requests. Please slow down and try again shortly.'
  });
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: realIp,
  skip: (req) => ADMIN_PATHS.some(p => req.path.startsWith(p)),
  handler: logRateLimit,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: realIp,
  handler: logRateLimit,
});

app.use(generalLimiter);

// ---- Routes ----
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/albums', albumRoutes);
app.use('/api/stickers', stickerRoutes);
app.use('/api/swaps', swapRoutes);
app.use('/api/swaps/:swapId/messages', messageRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/badges', badgeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/app-survey', appSurveyRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/messages', messagingRoutes);
app.use('/api/ambassador', ambassadorRoutes);
app.use('/api/founder', founderRoutes);
app.use('/api/pl2026', pl2026Routes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ----------------------------------------------------------------
// GET /api/stats — public community stats for the homepage banner.
// Results cached for 60 seconds so rapid polling from many users
// doesn't hammer the database.
// ----------------------------------------------------------------
let statsCache = null;
let statsCacheAt = 0;
const STATS_TTL = 60 * 1000; // 60 seconds

app.get('/api/stats', async (req, res) => {
  if (statsCache && Date.now() - statsCacheAt < STATS_TTL) {
    return res.json(statsCache);
  }
  try {
    const pool = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });
    const [collectors, swaps, matches, active, stickers] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users`),
      pool.query(`SELECT COUNT(*) FROM swaps WHERE status IN ('accepted', 'posted', 'completed')`),
      pool.query(`SELECT COUNT(*) FROM matches WHERE status = 'pending'`),
      pool.query(`SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE last_seen > NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*) FROM swap_items si JOIN swaps s ON s.id = si.swap_id WHERE s.status IN ('completed', 'posted', 'accepted')`),
    ]);
    await pool.end();
    statsCache = {
      collectors: parseInt(collectors.rows[0].count),
      swaps: parseInt(swaps.rows[0].count),
      matches: parseInt(matches.rows[0].count),
      activeThisWeek: parseInt(active.rows[0].count),
      stickersExchanged: parseInt(stickers.rows[0].count),
    };
    statsCacheAt = Date.now();
    res.json(statsCache);
  } catch (err) {
    console.error('Stats endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ----------------------------------------------------------------
// GET /api/activity — recent real platform events for the ticker.
// Returns the last 20 events across swaps, matches and completions.
// Results cached for 60 seconds.
// ----------------------------------------------------------------
let activityCache = null;
let activityCacheAt = 0;

app.get('/api/activity', async (req, res) => {
  if (activityCache && Date.now() - activityCacheAt < STATS_TTL) {
    return res.json(activityCache);
  }
  try {
    const pool2 = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool2.query(`
      SELECT type, label, happened_at FROM (
        -- Swap agreed (both accepted)
        SELECT 'swap_agreed' AS type,
          CONCAT(ua.name, ' agreed a swap with ', ub.name) AS label,
          s.updated_at AS happened_at
        FROM swaps s
        JOIN users ua ON ua.id = s.user_a_id
        JOIN users ub ON ub.id = s.user_b_id
        WHERE s.status IN ('accepted','posted','completed')
        ORDER BY s.updated_at DESC FETCH FIRST 8 ROWS ONLY
      ) a
      UNION ALL SELECT type, label, happened_at FROM (
        -- Swap completed
        SELECT 'swap_completed' AS type,
          CONCAT(ua.name, ' completed a swap with ', ub.name) AS label,
          s.updated_at AS happened_at
        FROM swaps s
        JOIN users ua ON ua.id = s.user_a_id
        JOIN users ub ON ub.id = s.user_b_id
        WHERE s.status = 'completed'
        ORDER BY s.updated_at DESC FETCH FIRST 6 ROWS ONLY
      ) b
      UNION ALL SELECT type, label, happened_at FROM (
        -- New match found
        SELECT 'match_found' AS type,
          CONCAT(ua.name, ' matched with ', ub.name, ' on ', LEAST(m.a_gives_b_count, m.b_gives_a_count), ' stickers') AS label,
          m.computed_at AS happened_at
        FROM matches m
        JOIN users ua ON ua.id = m.user_a_id
        JOIN users ub ON ub.id = m.user_b_id
        WHERE m.status = 'pending' AND LEAST(m.a_gives_b_count, m.b_gives_a_count) >= 3
        ORDER BY m.computed_at DESC FETCH FIRST 6 ROWS ONLY
      ) c
      ORDER BY happened_at DESC FETCH FIRST 20 ROWS ONLY
    `);
    await pool2.end();
    activityCache = rows;
    activityCacheAt = Date.now();
    res.json(rows);
  } catch (err) {
    console.error('Activity endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});
// Called by Railway's HTTP cron on a schedule. Protected by a shared
// secret passed as a query param, since Railway's simple HTTP cron
// tool only supports a plain URL (no custom headers).
app.all('/api/internal/run-matching', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await runMatchingJob();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Cron-triggered matching job failed:', err);
    res.status(500).json({ error: 'Matching job failed' });
  }
});

// Serve admin dashboard at /admin — disable CSP so inline scripts work
app.get('/admin', (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const filePath = path.join(__dirname, 'admin.html');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('admin.html not found on server.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  const content = fs.readFileSync(filePath, 'utf8');
  res.send(content);
});

// ---- Internal: trigger the reminder email job via cron-job.org ----
// Set up a new cron job hitting this URL every hour
app.all('/api/internal/run-reminders', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sendReminders } = require('./jobs/send_reminders');
    await sendReminders();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Reminder job failed:', err.message);
    res.status(500).json({ error: 'Reminder job failed' });
  }
});

// ---- Internal: trigger the proposal expiry job ----
// Set up a new cron job hitting this URL once a day. Auto-declines
// any swap still 'proposed' 7+ days after being created.
app.all('/api/internal/run-proposal-expiry', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { expireStaleProposals } = require('./jobs/expire_stale_proposals');
    await expireStaleProposals();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Proposal expiry job failed:', err.message);
    res.status(500).json({ error: 'Proposal expiry job failed' });
  }
});

// ---- Internal: trigger the scheduled-announcements job ----
// Set up a new cron job hitting this URL every 5 minutes. Sends any
// admin-scheduled announcement whose send_at time has arrived.
app.all('/api/internal/run-scheduled-announcements', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sendScheduledAnnouncements } = require('./jobs/send_scheduled_announcements');
    const result = await sendScheduledAnnouncements();
    res.json({ success: true, ranAt: new Date().toISOString(), ...result });
  } catch (err) {
    console.error('Scheduled announcements job failed:', err.message);
    res.status(500).json({ error: 'Scheduled announcements job failed' });
  }
});

// ---- Internal: trigger the "post your stickers" reminder job ----
// Set up a new cron job hitting this URL every few hours. Nudges
// anyone who accepted a swap 48+ hours ago but hasn't posted yet.
app.all('/api/internal/run-posting-reminders', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sendPostingReminders } = require('./jobs/send_posting_reminders');
    await sendPostingReminders();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Posting reminder job failed:', err.message);
    res.status(500).json({ error: 'Posting reminder job failed' });
  }
});

// ---- Internal: trigger the "confirm receipt" reminder job ----
// Set up a new cron job hitting this URL every few hours. Nudges
// anyone who hasn't confirmed receipt on a swap that's been sitting
// at 'posted' for 48+ hours.
app.all('/api/internal/run-receipt-reminders', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sendReceiptReminders } = require('./jobs/send_receipt_reminders');
    await sendReceiptReminders();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Receipt reminder job failed:', err.message);
    res.status(500).json({ error: 'Receipt reminder job failed' });
  }
});

// ---- Internal: trigger the stale-proposal expiry job ----
// Set up a new cron job hitting this URL once a day. Auto-declines
// any swap still at 'proposed' after 7 days with no response.
app.all('/api/internal/run-expire-proposals', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { expireStaleProposals } = require('./jobs/expire_stale_proposals');
    await expireStaleProposals();
    res.json({ success: true, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Expire proposals job failed:', err.message);
    res.status(500).json({ error: 'Expire proposals job failed' });
  }
});

// ---- Internal: trigger the inactive-user nudge job ----
// Set up a new cron job hitting this URL once a day. Nudges anyone
// who has stickers listed but hasn't logged in for 7+ days.
app.all('/api/internal/run-auto-nudge', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sendAutoNudge } = require('./jobs/send_auto_nudge');
    const sent = await sendAutoNudge();
    res.json({ success: true, sent, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Auto-nudge job failed:', err.message);
    res.status(500).json({ error: 'Auto-nudge job failed' });
  }
});

// ---- Internal: trigger the zero-stickers nudge job ----
// Set up a new cron job hitting this URL once a day. Nudges anyone
// who's signed up but never listed a duplicate or a need.
app.all('/api/internal/run-zero-sticker-nudge', async (req, res) => {
  const providedSecret = req.query.secret;
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sendZeroStickerNudge } = require('./jobs/send_zero_sticker_nudge');
    const sent = await sendZeroStickerNudge();
    res.json({ success: true, sent, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error('Zero-sticker nudge job failed:', err.message);
    res.status(500).json({ error: 'Zero-sticker nudge job failed' });
  }
});

// ---- Internal: read-only pending feedback digest ----
// Deliberately narrow — a dedicated secret (not ADMIN_SECRET, not
// CRON_SECRET) that can only ever read pending feedback. Nothing here
// can resolve tickets, touch users, or reach any other admin data, so
// this credential is safe to hand to an automated process without the
// blast radius a full admin or database credential would carry.
// Header-based (not query param) since this is only ever meant to be
// called by tools that can set headers, e.g. curl.
app.get('/api/internal/feedback-digest', async (req, res) => {
  const providedSecret = req.headers['x-feedback-secret'];
  if (!process.env.FEEDBACK_READ_SECRET || providedSecret !== process.env.FEEDBACK_READ_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT f.id, f.message, f.page, f.created_at, u.name AS user_name, u.email AS user_email
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.status = 'pending'
       ORDER BY f.created_at DESC
       LIMIT 200`
    );
    await pool.end();
    res.json(rows);
  } catch (err) {
    console.error('Feedback digest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch feedback digest' });
  }
});

// ---- Internal: resolve a feedback item ----
// Same fixed/declined + in-app notification logic as
// POST /api/admin/feedback/:id/resolve, just reachable with a
// dedicated write-only secret (FEEDBACK_WRITE_SECRET, separate from
// FEEDBACK_READ_SECRET) instead of the full ADMIN_SECRET. Notification
// is an in-app row only — no email is sent from this path.
app.post('/api/internal/feedback-resolve', async (req, res) => {
  const providedSecret = req.headers['x-feedback-write-secret'];
  if (!process.env.FEEDBACK_WRITE_SECRET || providedSecret !== process.env.FEEDBACK_WRITE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { id, status, notify = true } = req.body;
  if (!['fixed', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'status must be fixed or declined' });
  }
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `UPDATE feedback SET status = $1 WHERE id = $2
       RETURNING *, (SELECT name FROM users WHERE id = feedback.user_id) AS user_name`,
      [status, id]
    );
    const feedback = rows[0];
    if (!feedback) {
      await pool.end();
      return res.status(404).json({ error: 'Feedback not found' });
    }

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

    await pool.end();
    res.json({ success: true, status, notify, userName: feedback.user_name });
  } catch (err) {
    console.error('Feedback resolve error:', err.message);
    res.status(500).json({ error: 'Failed to resolve feedback' });
  }
});

// ---- Internal: send a custom reply to a feedback item ----
// Same logic as POST /api/admin/feedback/:id/reply, reachable with
// FEEDBACK_WRITE_SECRET instead of ADMIN_SECRET. In-app notification
// only, same as resolve — no email sent.
app.post('/api/internal/feedback-reply', async (req, res) => {
  const providedSecret = req.headers['x-feedback-write-secret'];
  if (!process.env.FEEDBACK_WRITE_SECRET || providedSecret !== process.env.FEEDBACK_WRITE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { id, message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT f.*, u.name AS user_name FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.id = $1`,
      [id]
    );
    const feedback = rows[0];
    if (!feedback) {
      await pool.end();
      return res.status(404).json({ error: 'Feedback not found' });
    }
    if (!feedback.user_id) {
      await pool.end();
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
    await pool.end();
    res.json({ success: true, sentTo: feedback.user_name });
  } catch (err) {
    console.error('Feedback reply error:', err.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---- Central error handler ----
// Catches anything thrown/rejected that individual routes didn't
// already handle, so the process never crashes silently and the
// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Panini swap API listening on port ${PORT}`);
});

module.exports = app;
