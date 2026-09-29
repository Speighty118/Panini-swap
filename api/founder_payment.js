// Legacy Founder checkouts have no purchaseType. Preserve those, but require
// the original paid amount/currency; tips must never grant digital benefits.
module.exports = session => session.mode === 'payment' && session.payment_status === 'paid'
  && session.currency === 'gbp' && session.amount_total === 1499
  && (!session.metadata?.purchaseType || session.metadata.purchaseType === 'founder')
  && /^[1-9]\d*$/.test(String(session.metadata?.userId));
