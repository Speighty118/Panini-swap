// No credentials or side effects at import: dependencies are supplied by the host.
const express = require('express');
const AMOUNTS = new Set([300, 500, 1000]);
module.exports = function supportCheckout({ stripe, requireAuth, enabled, frontendUrl }) {
  const router = express.Router();
  router.use(requireAuth);
  router.post('/checkout', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled) return res.status(503).json({ error: 'Contributions are not available yet.' });
    const { amount, attemptId } = req.body || {};
    if (!AMOUNTS.has(amount) || typeof attemptId !== 'string' || !/^[a-f0-9-]{36}$/i.test(attemptId)) {
      return res.status(400).json({ error: 'Choose £3, £5 or £10 and try again.' });
    }
    try {
      const origin = new URL(frontendUrl);
      if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) throw new Error('Invalid return origin');
      const metadata = { userId: String(req.user.id), purchaseType: 'support_tip' };
      const session = await stripe.checkout.sessions.create({
        mode: 'payment', payment_method_types: ['card'],
        line_items: [{ price_data: { currency:'gbp', unit_amount:amount, product_data:{
          name:'Support Got One Spare?', description:'One-off support for running costs and development. No subscription or Founder membership.'
        } }, quantity:1 }],
        metadata, payment_intent_data:{metadata},
        success_url: `${origin.origin}/?support=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin.origin}/?support=cancelled`,
      }, { idempotencyKey:`support:${req.user.id}:${attemptId}` });
      res.json({ url:session.url });
    } catch (error) { res.status(502).json({ error:'Unable to start checkout. Please try again.' }); }
  });
  router.get('/status', async (req,res) => {
    res.set('Cache-Control','no-store');
    if (!enabled) return res.status(503).json({error:'Contributions are not available yet.'});
    if(typeof req.query.sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{1,250}$/.test(req.query.sessionId)) return res.status(400).json({error:'Invalid checkout session.'});
    try {
      const session=await stripe.checkout.sessions.retrieve(req.query.sessionId);
      if(session.metadata?.userId!==String(req.user.id) || session.metadata?.purchaseType!=='support_tip') return res.status(404).json({error:'Checkout not found.'});
      const paid=session.payment_status==='paid' && session.currency==='gbp' && AMOUNTS.has(session.amount_total) && session.mode==='payment';
      res.json({paid,amount:paid?session.amount_total:null});
    } catch(error) {res.status(502).json({error:'Unable to confirm payment. Please try again.'});}
  });
  return router;
};
