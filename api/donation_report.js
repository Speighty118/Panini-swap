// Read-only reporting. No payment creation, webhook or entitlement changes.
const MAX_PAGES = 20;
function summarizeSessions(sessions) {
  const checkouts = sessions.filter(s => s.livemode === true && s.mode === 'payment' && s.currency === 'gbp' &&
    ((s.metadata?.purchaseType === 'support_tip' && [300,500,1000].includes(s.amount_total)) ||
     ((!s.metadata?.purchaseType || s.metadata.purchaseType === 'founder') && s.amount_total === 1499 && /^\d+$/.test(s.metadata?.userId || ''))));
  const paid = checkouts.filter(s => s.payment_status === 'paid');
  return {
    checkoutCount:checkouts.length, paidCount:paid.length,
    openCount:checkouts.filter(s=>s.status==='open').length,
    expiredCount:checkouts.filter(s=>s.status==='expired').length,
    grossPence:paid.reduce((n,s)=>n+s.amount_total,0),
    contributionPence:paid.filter(s=>s.metadata.purchaseType==='support_tip').reduce((n,s)=>n+s.amount_total,0),
    founderPence:paid.filter(s=>s.metadata.purchaseType!=='support_tip').reduce((n,s)=>n+s.amount_total,0),
    donorCount:new Set(paid.map(s=>s.metadata?.userId || s.customer_details?.email || s.id)).size,
    payments:paid.map(s=>({id:s.id,userId:s.metadata?.userId || null,name:s.customer_details?.name || '',email:s.customer_details?.email || '',amount:s.amount_total,type:s.metadata?.purchaseType==='support_tip'?'Contribution':'Founder',createdAt:new Date(s.created*1000).toISOString()}))
  };
}
function parsePeriod(query, now=Date.now()) {
  const from=Date.parse(query.from), to=Date.parse(query.to);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>31*86400000||to>now+60000) throw Error('Choose a valid period of up to 31 days ending no later than now.');
  return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),gte:Math.floor(from/1000),lt:Math.ceil(to/1000)};
}
async function readSessions(stripe, period) {
  const sessions=[];let cursor;
  for(let page=0;page<MAX_PAGES;page++) {
    const result=await stripe.checkout.sessions.list({limit:100,created:{gte:period.gte,lt:period.lt},...(cursor?{starting_after:cursor}:{})});
    sessions.push(...result.data);
    if(!result.has_more)return {sessions,complete:true};
    if(!result.data.length)break;
    cursor=result.data[result.data.length-1].id;
  }
  return {sessions,complete:false};
}
module.exports={summarizeSessions,parsePeriod,readSessions};
