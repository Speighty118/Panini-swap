const PRODUCTS = new Set(['com.gotonespare.app.founder', 'com.gotonespare.app.founder.v2', 'founder_membership']);
const userId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function normalize(event) {
  if (event.type === 'TRANSFER' && !event.environment) throw Error('Transfer environment needs server reconciliation');
  if (event.environment !== 'PRODUCTION' || !event.id || !Number.isSafeInteger(event.event_timestamp_ms)) return null;
  const base = { id: event.id, time: event.event_timestamp_ms, type: event.type };
  if (event.type === 'TRANSFER') {
    const from = [...new Set((event.transferred_from || []).map(userId).filter(Boolean))];
    const to = [...new Set((event.transferred_to || []).map(userId).filter(Boolean))];
    if (!from.length) return null; // No account managed by this application.
    if (to.length !== 1) throw Error('Transfer needs an unambiguous registered destination');
    return { ...base, from, user: to[0] };
  }
  const supported = ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'REFUND_REVERSED'].includes(event.type) ||
    (event.type === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT');
  if (!supported || !PRODUCTS.has(event.product_id) || !event.transaction_id || !userId(event.app_user_id)) return null;
  return { ...base, user: userId(event.app_user_id), transaction: String(event.transaction_id), product: event.product_id,
    amount: event.currency === 'GBP' && Number.isFinite(event.price_in_purchased_currency) ? Math.round(event.price_in_purchased_currency * 100) : null };
}

// Replay in event order, not delivery order: RevenueCat can retry older events later.
// Refunds alter the transaction's status without moving it back to an earlier owner.
function project(events) {
  const purchases = new Map();
  const priority = type => type === 'TRANSFER' ? 2 : type === 'CANCELLATION' ? 3 : 1;
  for (const event of [...events].sort((a,b) => a.time-b.time || priority(a.type)-priority(b.type) || a.id.localeCompare(b.id))) {
    if (event.type === 'TRANSFER') {
      for (const row of purchases.values()) if (event.from.includes(row.user)) row.user = event.user;
    } else {
      const previous = purchases.get(event.transaction);
      const active = event.type !== 'CANCELLATION';
      purchases.set(event.transaction, { ...event, user: previous?.user ?? event.user, active,
        amount: previous?.amount ?? event.amount });
    }
  }
  return [...purchases.values()];
}

async function applyEvent(pool, rawEvent) {
  const event = normalize(rawEvent);
  if (!event) return [];
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(73190421)');
    const target = await db.query('SELECT id FROM users WHERE id=$1', [event.user]);
    if (!target.rows.length) throw Error('Purchase account missing');
    const inserted = await db.query('INSERT INTO founder_native_events(event_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [event.id,event]);
    if (!inserted.rows.length) { await db.query('COMMIT'); return []; }
    const history = await db.query('SELECT payload FROM founder_native_events');
    const purchases = project(history.rows.map(row => row.payload));
    const previous = await db.query('SELECT user_id FROM founder_native_purchases');
    const affected = new Set(previous.rows.map(row => row.user_id).filter(Boolean));
    const existing = new Set((await db.query('SELECT id FROM users WHERE id=ANY($1::integer[])', [purchases.map(row => row.user)])).rows.map(row => row.id));
    for (const row of purchases) {
      const owner = existing.has(row.user) ? row.user : null;
      if (owner) affected.add(owner);
      await db.query(`INSERT INTO founder_native_purchases(transaction_id,user_id,product_id,active,event_ms,amount_gbp)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(transaction_id) DO UPDATE SET
        user_id=EXCLUDED.user_id,active=EXCLUDED.active,event_ms=EXCLUDED.event_ms,amount_gbp=EXCLUDED.amount_gbp`,
      [row.transaction,owner,row.product,row.active,row.time,row.amount]);
    }
    const granted = [];
    for (const id of affected) {
      await db.query(`INSERT INTO founder_native_accounts(user_id,preserved_founder)
        SELECT id,COALESCE(founder_member,FALSE) FROM users WHERE id=$1 ON CONFLICT DO NOTHING`, [id]);
      const active = await db.query('SELECT transaction_id,amount_gbp FROM founder_native_purchases WHERE user_id=$1 AND active=TRUE ORDER BY purchased_at LIMIT 1', [id]);
      if (active.rows.length) {
        const row = active.rows[0];
        const updated = await db.query(`UPDATE users SET founder_member=TRUE,founder_since=COALESCE(founder_since,NOW()),
          membership_tier='founder',founder_payment_id=$2,founder_amount=$3
          WHERE id=$1 AND founder_member=FALSE RETURNING id,name,email`, [id,row.transaction_id,row.amount_gbp]);
        granted.push(...updated.rows);
      } else {
        // Stripe/manual/legacy members present before ledger activation retain their access.
        await db.query(`UPDATE users u SET founder_member=FALSE,membership_tier='free' FROM founder_native_accounts a
          WHERE u.id=$1 AND a.user_id=u.id AND a.preserved_founder=FALSE
          AND EXISTS(SELECT 1 FROM founder_native_purchases p WHERE p.transaction_id=u.founder_payment_id)`, [id]);
      }
    }
    await db.query('COMMIT');
    return granted;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
module.exports = applyEvent;
module.exports.project = project;
module.exports.normalize = normalize;
