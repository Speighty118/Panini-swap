const PRODUCTS=new Set(['com.gotonespare.app.support.small','com.gotonespare.app.support.medium','com.gotonespare.app.support.large','com.gotonespare.app.founder','com.gotonespare.app.founder.v2','founder_membership']);
function normalize(e){
 if(!e || e.environment!=='PRODUCTION' || e.store!=='APP_STORE' || e.is_family_share===true || !PRODUCTS.has(e.product_id) || !['NON_RENEWING_PURCHASE','INITIAL_PURCHASE','CANCELLATION','REFUND_REVERSED'].includes(e.type))return null;
 if(!e.id||!e.transaction_id||!Number.isSafeInteger(e.event_timestamp_ms)||!Number.isSafeInteger(e.purchased_at_ms)||!Number.isFinite(new Date(e.purchased_at_ms).getTime()))throw Error('Incomplete Apple payment event');
 const amount=typeof e.price_in_purchased_currency==='number'&&Number.isFinite(e.price_in_purchased_currency)?Math.round(Math.abs(e.price_in_purchased_currency)*100):null;
 return {eventId:String(e.id),transactionId:String(e.transaction_id),type:e.type,eventMs:e.event_timestamp_ms,purchasedAt:new Date(e.purchased_at_ms).toISOString(),userId:/^[1-9]\d*$/.test(String(e.app_user_id))&&Number.isSafeInteger(Number(e.app_user_id))?Number(e.app_user_id):null,product:e.product_id,currency:typeof e.currency==='string'?e.currency.toUpperCase():null,amount:Number.isSafeInteger(amount)?amount:null};
}
async function record(pool,event){const e=normalize(event);if(!e)return;
 await pool.query(`INSERT INTO apple_support_events(event_id,transaction_id,event_type,event_ms,purchased_at,user_id,product_id,currency,amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(event_id) DO NOTHING`,[e.eventId,e.transactionId,e.type,e.eventMs,e.purchasedAt,e.userId,e.product,e.currency,e.amount]);
}
function summarize(rows){
 const groups=new Map();for(const e of rows){if(!groups.has(e.transaction_id))groups.set(e.transaction_id,[]);groups.get(e.transaction_id).push(e);}
 const payments=[];let excluded=0;
 for(const events of groups.values()){
  events.sort((a,b)=>Number(a.event_ms)-Number(b.event_ms)||(a.event_type==='CANCELLATION'?1:0)-(b.event_type==='CANCELLATION'?1:0));
  const purchase=events.find(e=>['NON_RENEWING_PURCHASE','INITIAL_PURCHASE'].includes(e.event_type));
  if(!purchase || purchase.currency!=='GBP'||purchase.amount_minor===null||!Number.isSafeInteger(Number(purchase.amount_minor))){excluded++;continue;}
  const latest=events[events.length-1];
  payments.push({id:'apple:'+purchase.transaction_id,userId:purchase.user_id===null?null:String(purchase.user_id),name:purchase.name||'',email:purchase.email||'',amount:Number(purchase.amount_minor),type:purchase.product_id.includes('.support.')?'Contribution':'Founder',createdAt:purchase.purchased_at,refunded:latest.event_type==='CANCELLATION'});
 }
 const grossPence=payments.reduce((n,p)=>n+p.amount,0),refundPence=payments.filter(p=>p.refunded).reduce((n,p)=>n+p.amount,0);
 return {payments,grossPence,refundPence,retainedPence:grossPence-refundPence,contributionPence:payments.filter(p=>p.type==='Contribution').reduce((n,p)=>n+p.amount,0),founderPence:payments.filter(p=>p.type==='Founder').reduce((n,p)=>n+p.amount,0),paidCount:payments.length,excludedTransactions:excluded};
}
async function report(pool,period){
 const rows=(await pool.query(`SELECT e.*,u.name,u.email FROM apple_support_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.transaction_id IN (SELECT transaction_id FROM apple_support_events WHERE purchased_at >= $1 AND purchased_at < $2) ORDER BY event_ms,event_id`,[period.from,period.to])).rows;
 const tracking=(await pool.query('SELECT started_at FROM apple_support_tracking WHERE id=1')).rows[0];
 return {...summarize(rows),trackingSince:tracking?.started_at,historyComplete:false};
}
module.exports={normalize,record,summarize,report};
