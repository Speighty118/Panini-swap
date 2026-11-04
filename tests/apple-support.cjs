const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize,record,summarize}=require('../api/apple_support');
const handler=require('../api/revenuecat_handler');
const event={id:'event1',transaction_id:'txn1',type:'NON_RENEWING_PURCHASE',environment:'PRODUCTION',store:'APP_STORE',product_id:'com.gotonespare.app.support.medium',app_user_id:'123',event_timestamp_ms:1000,purchased_at_ms:1000,currency:'GBP',price_in_purchased_currency:5};
const row={transaction_id:'txn1',event_type:event.type,event_ms:1000,purchased_at:new Date(1000).toISOString(),user_id:123,product_id:event.product_id,currency:'GBP',amount_minor:'500'};
test('only real allowlisted Apple purchases are recorded',()=>{
 assert.equal(normalize(event).amount,500);
 for(const override of [{environment:'SANDBOX'},{store:'PLAY_STORE'},{is_family_share:true},{product_id:'unknown'},{type:'TRANSFER'}])assert.equal(normalize({...event,...override}),null);
 assert.equal(normalize({...event,price_in_purchased_currency:undefined}).amount,null);
 assert.throws(()=>normalize({...event,transaction_id:null}));
});
test('repeat events and transactions cannot inflate totals; out of order refunds and reversals work',async()=>{
 const events=new Map();const pool={query:async(sql,p)=>{assert.match(sql,/ON CONFLICT\(event_id\) DO NOTHING/);events.set(p[0],p);}};
 await record(pool,event);await record(pool,event);assert.equal(events.size,1);
 assert.equal(summarize([row,{...row,event_ms:1100}]).grossPence,500);
 const refund={...row,event_type:'CANCELLATION',event_ms:2000};
 assert.equal(summarize([refund,row]).retainedPence,0);
 assert.equal(summarize([refund,{...row,event_type:'REFUND_REVERSED',event_ms:3000},row]).retainedPence,500);
});
test('missing purchases, unknown amounts and foreign currency never become GBP revenue',()=>{
 for(const override of [{event_type:'CANCELLATION'},{currency:'USD'},{amount_minor:null}]){
  const result=summarize([{...row,...override}]);assert.equal(result.grossPence,0);assert.equal(result.excludedTransactions,1);
 }
});
test('webhook authentication precedes recording and storage failure requests retry',async()=>{
 let calls=0;const run=handler({secret:'test-secret',pool:{},recordPayment:async()=>{calls++;throw Error('offline');}});
 const res={status(n){this.code=n;return this;},json(b){this.body=b;return this;}};
 await run({headers:{authorization:'wrong'},body:{event}},res);assert.equal(res.code,401);assert.equal(calls,0);
 await run({headers:{authorization:'Bearer test-secret'},body:{event}},res);assert.equal(res.code,500);assert.equal(calls,1);
});
