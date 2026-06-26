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
const { sendVerificationEmail, sendPasswordResetEmail } = require('./email');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '30d';
const MAX_SIGNUPS_PER_IP_PER_DAY = 5;

function signToken(userId, name) {
  return jwt.sign({ userId, name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
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
  const { name, email, password, inviteCode } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Check invite-only mode
    if (process.env.INVITE_ONLY === 'true') {
      if (!inviteCode) {
        return res.status(403).json({ error: 'An invite code is required to sign up.', inviteRequired: true });
      }
      const { rows: codeRows } = await pool.query(
        `SELECT id FROM invite_codes WHERE code = $1 AND used_at IS NULL`,
        [inviteCode.trim().toUpperCase()]
      );
      if (!codeRows[0]) {
        return res.status(403).json({ error: 'Invalid or already-used invite code.', inviteRequired: true });
      }
    }

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

    // Mark invite code as used
    if (process.env.INVITE_ONLY === 'true' && inviteCode) {
      await pool.query(
        `UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2`,
        [user.id, inviteCode.trim().toUpperCase()]
      ).catch(() => {}); // best-effort
    }

    const token = signToken(user.id, user.name);

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
    if (user.is_suspended) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact the group admin for details.' });
    }

    const token = signToken(user.id, user.name);

    // Track login — update last_login_at, increment login_count, create session record
    await pool.query(
      `UPDATE users SET last_login_at = NOW(), login_count = login_count + 1 WHERE id = $1`,
      [user.id]
    ).catch(() => {});
    await pool.query(
      `INSERT INTO user_sessions (user_id) VALUES ($1)`,
      [user.id]
    ).catch(() => {});

    // Geolocate the IP on login — best-effort, never blocks the response.
    // Stored in geo_* columns, separate from the user's postal address fields.
    // Only updates if we don't already have geo data for this user.
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && !user.geo_latitude) {
      fetch(`http://ip-api.com/json/${ip}?fields=country,city,lat,lon,status`)
        .then(r => r.json())
        .then(geo => {
          if (geo.status === 'success') {
            pool.query(
              `UPDATE users SET geo_country = $1, geo_city = $2, geo_latitude = $3, geo_longitude = $4 WHERE id = $5`,
              [geo.country, geo.city, geo.lat, geo.lon, user.id]
            ).catch(() => {});
          }
        })
        .catch(() => {});
    }

    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ----------------------------------------------------------------
// GET /api/auth/search?q=name
// Search for users by name — for finding swap partners manually.
// Returns limited public info only.
// ----------------------------------------------------------------
router.get('/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.city, u.rating_avg, u.rating_count, u.swap_streak,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed') AS completed_swaps,
              u.response_rate
       FROM users u
       LEFT JOIN swaps s ON s.user_a_id = u.id OR s.user_b_id = u.id
       WHERE u.name ILIKE $1 AND u.is_suspended = FALSE AND u.email_verified = TRUE
       GROUP BY u.id
       ORDER BY u.name ASC
       LIMIT 20`,
      [`%${q.trim()}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/forgot-password
// Request a password reset email. Always returns success to prevent
// email enumeration — even if the email doesn't exist.
// Body: { email }
// ----------------------------------------------------------------
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    // Always return success to prevent email enumeration
    if (!rows.length) return res.json({ success: true });

    const user = rows[0];
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Invalidate any existing tokens for this user
    await pool.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1`,
      [user.id]
    );

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    const resetUrl = `${process.env.FRONTEND_URL || 'https://www.gotonespare.com'}/reset-password?token=${token}`;
    await sendPasswordResetEmail(user.email, user.name, resetUrl);

    res.json({ success: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// ----------------------------------------------------------------
// POST /api/auth/reset-password
// Reset the password using a valid token.
// Body: { token, password }
// ----------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const { rows } = await pool.query(
      `SELECT prt.*, u.id AS user_id, u.name, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token = $1
         AND prt.expires_at > NOW()
         AND prt.used_at IS NULL`,
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const resetRecord = rows[0];
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);

    await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [passwordHash, resetRecord.user_id]
    );

    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1`,
      [token]
    );

    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
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
    if (!rows[0].is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }
    if (rows[0].is_suspended) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact the group admin for details.' });
    }
    // Keep last_seen fresh on the most recent open session
    await pool.query(
      `UPDATE user_sessions SET last_seen = NOW()
       WHERE user_id = $1 AND ended_at IS NULL
       AND started_at = (SELECT MAX(started_at) FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL)`,
      [req.user.id]
    ).catch(() => {});
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
  const {
    name, address_line1, address_line2, city, postcode, country, profile_photo,
    email_swap_proposed, email_swap_accepted, email_swap_posted,
    email_swap_received, email_swap_reminders, email_chat_messages,
  } = req.body;

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
           profile_photo = COALESCE($7, profile_photo),
           email_swap_proposed = CASE WHEN $8::boolean IS NOT NULL THEN $8 ELSE email_swap_proposed END,
           email_swap_accepted = CASE WHEN $9::boolean IS NOT NULL THEN $9 ELSE email_swap_accepted END,
           email_swap_posted = CASE WHEN $10::boolean IS NOT NULL THEN $10 ELSE email_swap_posted END,
           email_swap_received = CASE WHEN $11::boolean IS NOT NULL THEN $11 ELSE email_swap_received END,
           email_swap_reminders = CASE WHEN $12::boolean IS NOT NULL THEN $12 ELSE email_swap_reminders END,
           email_chat_messages = CASE WHEN $13::boolean IS NOT NULL THEN $13 ELSE email_chat_messages END
       WHERE id = $14
       RETURNING *`,
      [
        name, address_line1, address_line2, city, postcode, country, profile_photo,
        email_swap_proposed ?? null,
        email_swap_accepted ?? null,
        email_swap_posted ?? null,
        email_swap_received ?? null,
        email_swap_reminders ?? null,
        email_chat_messages ?? null,
        req.user.id,
      ]
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
