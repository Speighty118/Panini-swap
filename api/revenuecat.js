/**
 * RevenueCat webhook — grants Founder membership when the iOS in-app
 * purchase (com.gotonespare.app.founder) completes.
 *
 * IMPORTANT — env var needed in Railway:
 *   REVENUECAT_WEBHOOK_SECRET  - shared secret configured as the
 *                                "Authorization header value" when
 *                                setting up this webhook URL in the
 *                                RevenueCat dashboard (Project settings
 *                                → Integrations → Webhooks)
 *
 * The RevenueCat app_user_id is set client-side to our own numeric
 * users.id (see frontend/src/revenuecat.js), so no separate identity
 * mapping is needed here.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { sendFounderWelcomeEmail } = require('./email');
const { createNotification } = require('./notifications');

const FOUNDER_PRODUCT_ID = 'com.gotonespare.app.founder';
const FOUNDER_PURCHASE_EVENT_TYPES = ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE'];

router.post('/webhook', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!process.env.REVENUECAT_WEBHOOK_SECRET || auth !== `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body?.event;
  if (!event || !FOUNDER_PURCHASE_EVENT_TYPES.includes(event.type) || event.product_id !== FOUNDER_PRODUCT_ID) {
    return res.json({ received: true });
  }

  const userId = parseInt(event.app_user_id, 10);
  if (!userId) {
    console.error('RevenueCat webhook: non-numeric app_user_id', event.app_user_id);
    return res.json({ received: true });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET founder_member = TRUE,
           founder_since = NOW(),
           membership_tier = 'founder',
           founder_payment_id = $1,
           founder_amount = $2
       WHERE id = $3 AND founder_member = FALSE
       RETURNING id, name, email`,
      [event.transaction_id || event.id, Math.round((event.price_in_purchased_currency || 0) * 100), userId]
    );

    // No row back means either already a Founder (RevenueCat can resend
    // events — this keeps it idempotent) or an invalid user id.
    if (rows[0]) {
      await createNotification(pool, {
        userId,
        type: 'founder_welcome',
        title: '🏆 Welcome to the Founders Club!',
        body: 'Thank you for supporting Got One Spare — your Founder badge is now live on your profile.',
      }).catch(() => {});

      sendFounderWelcomeEmail(rows[0].email, rows[0].name).catch((err) => {
        console.error('Founder welcome email failed:', err.message);
      });
    }
  } catch (err) {
    console.error('RevenueCat webhook DB update failed:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
