/**
 * Auth API endpoints: signup, login, get/update own profile.
 * Mount under /api/auth.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const { requireAuth, JWT_SECRET } = require('./middleware/auth');
const { sendVerificationEmail } = require('./email');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '30d';
const MAX_SIGNUPS_PER_IP_PER_DAY = 5;

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function publicUser(row) {
  // Strip password_hash before ever sending a user object to the client
  const { password_hash, ...rest } = row;
  return rest;
}

// ----------------------------------------------------------------
// POST /api/auth/signup
// Body: { name, email, password }
// Sends a verification email; account is created immediately but
// flagged email_verified = false until the link is clicked.
// ----------------------------------------------------------------
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Throttle: how many accounts has this IP created in the last 24h?
    const { rows: recentAttempts } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM signup_attempts
       WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [ip]
    );
    if (parseInt(recentAttempts[0].cnt, 10) >= MAX_SIGNUPS_PER_IP_PER_DAY) {
      return res.status(429).json({ error: 'Too many accounts created from this network recently. Please try again tomorrow.' });
    }

    const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing[0]) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, verification_token, verification_token_expires)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, email.toLowerCase(), passwordHash, verificationToken, tokenExpiry]
    );

    await pool.query(
      `INSERT INTO signup_attempts (ip_address, email) VALUES ($1, $2)`,
      [ip, email.toLowerCase()]
    );

    const user = rows[0];
    const token = signToken(user.id);

    // Send verification email — don't let an email-sending failure
    // block account creation; log it and let the user request a resend.
    const verifyUrl = `${process.env.FRONTEND_URL || 'https://panini-swap-frontend.vercel.app'}/verify-email?token=${verificationToken}`;
    try {
      await sendVerificationEmail(user.email, user.name, verifyUrl);
    } catch (emailErr) {
      console.error('Failed to send verification email:', emailErr);
    }

    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/verify-email
// Body: { token }
// ----------------------------------------------------------------
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE verification_token = $1`,
      [token]
    );
    const user = rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid or already-used verification link' });
    }
    if (user.verification_token_expires && new Date(user.verification_token_expires) < new Date()) {
      return res.status(400).json({ error: 'This verification link has expired. Please request a new one.' });
    }

    await pool.query(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_token_expires = NULL
       WHERE id = $1`,
      [user.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/resend-verification
// Requires auth (the user must be logged in to request a resend).
// ----------------------------------------------------------------
router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) return res.status(400).json({ error: 'Email is already verified' });

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3`,
      [verificationToken, tokenExpiry, user.id]
    );

    const verifyUrl = `${process.env.FRONTEND_URL || 'https://panini-swap-frontend.vercel.app'}/verify-email?token=${verificationToken}`;
    await sendVerificationEmail(user.email, user.name, verifyUrl);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/login
// Body: { email, password }
// ----------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];

    // Generic error for both "no such user" and "wrong password" —
    // don't leak which one it was.
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ----------------------------------------------------------------
// GET /api/auth/me
// Returns the logged-in user's own profile (includes address —
// this is the only endpoint that should return your own address
// back to you for editing purposes).
// ----------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ----------------------------------------------------------------
// PUT /api/auth/me
// Update own profile (name, address fields). Email/password
// changes are deliberately left out of this simple endpoint —
// handle those separately with re-verification if you add them.
// ----------------------------------------------------------------
router.put('/me', requireAuth, async (req, res) => {
  const { name, address_line1, address_line2, city, postcode, country, profile_photo } = req.body;

  // profile_photo arrives as a base64 data URL (e.g. "data:image/jpeg;base64,...").
  // Cap at ~700KB of base64 text, which corresponds to roughly 500KB of
  // actual image data — plenty for a small profile photo, small enough
  // to keep the database and API responses fast.
  const MAX_PHOTO_LENGTH = 700_000;
  if (profile_photo && profile_photo.length > MAX_PHOTO_LENGTH) {
    return res.status(400).json({ error: 'Photo is too large. Please use a smaller image (under ~500KB).' });
  }
  if (profile_photo && !profile_photo.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid photo format.' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           address_line1 = COALESCE($2, address_line1),
           address_line2 = COALESCE($3, address_line2),
           city = COALESCE($4, city),
           postcode = COALESCE($5, postcode),
           country = COALESCE($6, country),
           profile_photo = COALESCE($7, profile_photo)
       WHERE id = $8
       RETURNING *`,
      [name, address_line1, address_line2, city, postcode, country, profile_photo, req.user.id]
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
