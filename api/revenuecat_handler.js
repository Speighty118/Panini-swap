// Inject dependencies so payment processing can be tested without live services.
const PRODUCTS = new Set(['com.gotonespare.app.founder', 'com.gotonespare.app.founder.v2', 'founder_membership']);
module.exports = function createRevenueCatHandler({ pool, secret, notify, welcome, ledger = null }) {
  return async (req, res) => {
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
    const event = req.body?.event;
    if (ledger && event) {
      try {
        const granted = await ledger(pool, event);
        await Promise.allSettled(granted.map(async user => {
          await Promise.allSettled([
            Promise.resolve().then(() => notify(pool,{userId:user.id,type:'founder_welcome',title:'Welcome to the Founders Club!',body:'Your Founder membership is now active. Thank you for supporting the community.'})),
            Promise.resolve().then(() => welcome(user.email,user.name)),
          ]);
        }));
        return res.json({received:true});
      } catch { return res.status(500).json({error:'Membership update failed. Please retry.'}); }
    }
    // Sandbox receipts must never upgrade real accounts. Contributions grant no membership.
    if (!event || event.environment !== 'PRODUCTION' || !PRODUCTS.has(event.product_id) ||
        !['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE'].includes(event.type)) return res.json({ received: true });
    const id = String(event.app_user_id || '');
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !event.transaction_id) return res.json({ received: true });
    try {
      const { rows } = await pool.query(`UPDATE users SET founder_member = TRUE,
        founder_since = NOW(), membership_tier = 'founder', founder_payment_id = $1,
        founder_amount = $2 WHERE id = $3 AND founder_member = FALSE RETURNING id, name, email`,
      [event.transaction_id, event.currency === 'GBP' && Number.isFinite(event.price_in_purchased_currency)
        ? Math.round(event.price_in_purchased_currency * 100) : null, Number(id)]);
      if (rows[0]) {
        await Promise.allSettled([
          Promise.resolve().then(() => notify(pool, { userId: Number(id), type: 'founder_welcome',
            title: 'Welcome to the Founders Club!', body: 'Thank you for supporting Got One Spare — your Founder badge is now live on your profile.' })),
          Promise.resolve().then(() => welcome(rows[0].email, rows[0].name)),
        ]);
      }
      return res.json({ received: true });
    } catch {
      // Acknowledge only after durable storage succeeds, allowing RevenueCat to retry.
      return res.status(500).json({ error: 'Membership update failed. Please retry.' });
    }
  };
};
