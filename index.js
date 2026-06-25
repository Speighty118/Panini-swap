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
const futureCollectionsRoutes = require('./api/future_collections');
const messagingRoutes = require('./api/messaging');
const { runMatchingJob } = require('./jobs/run_matching');

const app = express();
app.set('trust proxy', 1); // Trust Railway's proxy for rate limiting and IP detection

// ---- Security & parsing middleware ----
app.use(helmet());
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
const ADMIN_PATHS = ['/api/admin', '/api/invites', '/api/feedback', '/api/donations', '/api/reports', '/api/announcements'];

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
app.use('/api/future-collections', futureCollectionsRoutes);
app.use('/api/messages', messagingRoutes);
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
    const [collectors, swaps, matches, active] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users`),
      pool.query(`SELECT COUNT(*) FROM swaps WHERE status IN ('accepted', 'posted', 'completed')`),
      pool.query(`SELECT COUNT(*) FROM matches WHERE status = 'pending'`),
      pool.query(`SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE last_seen > NOW() - INTERVAL '7 days'`),
    ]);
    await pool.end();
    statsCache = {
      collectors: parseInt(collectors.rows[0].count),
      swaps: parseInt(swaps.rows[0].count),
      matches: parseInt(matches.rows[0].count),
      activeThisWeek: parseInt(active.rows[0].count),
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
