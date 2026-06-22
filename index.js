/**
 * Main app entrypoint.
 *
 * Env vars required:
 *   DATABASE_URL  - postgres connection string
 *   JWT_SECRET    - secret for signing auth tokens
 *   PORT          - (optional) defaults to 3000
 *   CORS_ORIGIN   - (optional) frontend origin, e.g. https://your-swap-site.com
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
const { runMatchingJob } = require('./jobs/run_matching');

const app = express();

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
const ADMIN_PATHS = ['/api/admin', '/api/invites', '/api/feedback', '/api/donations'];

ADMIN_PATHS.forEach(path => app.use(path, adminCors));

app.use((req, res, next) => {
  if (ADMIN_PATHS.some(p => req.path.startsWith(p))) return next();
  restrictedCors(req, res, next);
});

// Basic rate limiting — protects login/signup from brute force,
// and protects the whole API from abuse. Tune as the group grows.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // stricter on login/signup specifically
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
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
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---- Internal: trigger the matching batch job ----
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
// client never sees a raw stack trace.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Panini swap API listening on port ${PORT}`);
});

module.exports = app;
