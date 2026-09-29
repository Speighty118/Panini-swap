const express = require('express');
const { Pool } = require('pg');
const { sendFounderWelcomeEmail } = require('./email');
const { createNotification } = require('./notifications');
const createRevenueCatHandler = require('./revenuecat_handler');
const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { requireAuth } = require('./middleware/auth');
const { createSync } = require('./revenuecat_sync');
const sync = createSync({pool,apiKey:process.env.REVENUECAT_LOOKUP_KEY || 'appl_TgridhdUrSWzKOGYKbHwdgowyRT'});
const enabled = process.env.FOUNDER_LEDGER_ENABLED === 'true';
router.post('/sync', requireAuth, async (req,res) => {
  res.set('Cache-Control','no-store');
  if(!enabled)return res.status(503).json({error:'Purchase reconciliation unavailable.'});
  try { await sync([req.user.id]); return res.json({received:true}); }
  catch { return res.status(502).json({error:'Unable to verify purchase. Please try Restore purchases again shortly.'}); }
});
router.post('/webhook', createRevenueCatHandler({
  pool, secret: process.env.REVENUECAT_WEBHOOK_SECRET,
  ledger: enabled ? async (_pool,event) => {
    if(event.environment==='SANDBOX')return [];
    if(event.type==='TRANSFER')return sync([...(event.transferred_from||[]),...(event.transferred_to||[])]);
    const supported=['INITIAL_PURCHASE','NON_RENEWING_PURCHASE','CANCELLATION','REFUND_REVERSED'];
    if(event.environment!=='PRODUCTION'||!supported.includes(event.type)||!['com.gotonespare.app.founder','com.gotonespare.app.founder.v2','founder_membership'].includes(event.product_id))return [];
    return sync([event.app_user_id]);
  } : null,
  notify: createNotification, welcome: sendFounderWelcomeEmail,
}));
module.exports = router;
