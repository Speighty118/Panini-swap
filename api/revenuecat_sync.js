// Server-authoritative lifetime entitlement reconciliation. No client receipts accepted.
const PRODUCTS = new Set(['com.gotonespare.app.founder','com.gotonespare.app.founder.v2','founder_membership']);
const numeric = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
function verifiedPurchase(data, allowSandbox = false) {
 const subscriber=data?.subscriber;
 if(!subscriber || !subscriber.entitlements || !subscriber.non_subscriptions) throw Error('Incomplete purchase response');
 const entitlement=subscriber.entitlements.founder;
 if(!entitlement)return null;
 if(!PRODUCTS.has(entitlement.product_identifier))throw Error('Unrecognized Founder entitlement');
 if(entitlement.expires_date!==null){
  if(!Number.isFinite(Date.parse(entitlement.expires_date)))throw Error('Invalid entitlement expiry');
  if(Date.parse(entitlement.expires_date)<=Date.now())return null;
 }
 const matches=(subscriber.non_subscriptions[entitlement.product_identifier]||[]).filter(p=>(p.is_sandbox===false||(allowSandbox&&p.is_sandbox===true))&&['app_store','play_store'].includes(p.store)&&p.purchase_date===entitlement.purchase_date&&p.id&&!p.refunded_at);
 if(!matches.length){
  // A sandbox entitlement must not affect a real account.
  if((subscriber.non_subscriptions[entitlement.product_identifier]||[]).some(p=>p.is_sandbox===true&&p.purchase_date===entitlement.purchase_date))return undefined;
  throw Error('Entitlement has no verified production purchase');
 }
 if(matches.length!==1)throw Error('Ambiguous production purchase');
 return {transaction:`${matches[0].is_sandbox ? "rc-sandbox" : "rc"}:${matches[0].id}`,product:entitlement.product_identifier};
}
function createSync({pool,apiKey,fetchImpl=fetch,sandboxReviewEmail=""}) {
 return async function sync(ids){
  if(!apiKey)throw Error('RevenueCat server lookup is not configured');
  ids=[...new Set(ids.filter(numeric).map(Number))];
  if(!ids.length)return [];
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   // Lookup inside the lock prevents concurrent snapshots overwriting newer reconciliation.
   await db.query('SELECT pg_advisory_xact_lock(73190421)');
   const existing=(await db.query('SELECT id,email FROM users WHERE id=ANY($1::integer[])',[ids])).rows;
   const states=[];
   for(const {id,email} of existing){
    const response=await fetchImpl(`https://api.revenuecat.com/v1/subscribers/${id}`,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('RevenueCat lookup failed');
    const purchase=verifiedPurchase(await response.json(), Boolean(sandboxReviewEmail) && email === sandboxReviewEmail);
    if(purchase!==undefined)states.push({id,purchase});
   }
   const claimed=states.filter(s=>s.purchase).map(s=>s.purchase.transaction);
   if(new Set(claimed).size!==claimed.length)throw Error('Purchase aliases require account review');
   const affected=new Set(states.map(s=>s.id));
   for(const {id,purchase} of states){
    await db.query('UPDATE founder_native_purchases SET active=FALSE WHERE user_id=$1',[id]);
    if(purchase){
     const previous=await db.query('SELECT user_id FROM founder_native_purchases WHERE transaction_id=$1',[purchase.transaction]);
     if(previous.rows[0]?.user_id)affected.add(previous.rows[0].user_id);
     await db.query(`INSERT INTO founder_native_purchases(transaction_id,user_id,product_id,active,event_ms)
      VALUES($1,$2,$3,TRUE,$4) ON CONFLICT(transaction_id) DO UPDATE SET user_id=EXCLUDED.user_id,active=TRUE,event_ms=EXCLUDED.event_ms`,[purchase.transaction,id,purchase.product,Date.now()]);
    }
   }
   const grants=[];
   for(const id of affected){
    await db.query(`INSERT INTO founder_native_accounts(user_id,preserved_founder) SELECT id,COALESCE(founder_member,FALSE) FROM users WHERE id=$1 ON CONFLICT DO NOTHING`,[id]);
    const active=await db.query('SELECT transaction_id FROM founder_native_purchases WHERE user_id=$1 AND active=TRUE LIMIT 1',[id]);
    if(active.rows.length){
     const result=await db.query(`UPDATE users SET founder_member=TRUE,founder_since=COALESCE(founder_since,NOW()),membership_tier='founder',founder_payment_id=$2 WHERE id=$1 AND founder_member=FALSE RETURNING id,name,email`,[id,active.rows[0].transaction_id]);
     grants.push(...result.rows);
    }else await db.query(`UPDATE users u SET founder_member=FALSE,membership_tier='free' FROM founder_native_accounts a WHERE u.id=$1 AND a.user_id=u.id AND a.preserved_founder=FALSE AND EXISTS(SELECT 1 FROM founder_native_purchases p WHERE p.transaction_id=u.founder_payment_id)`,[id]);
   }
   await db.query('COMMIT');return grants;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 };
}
module.exports={createSync,verifiedPurchase};
