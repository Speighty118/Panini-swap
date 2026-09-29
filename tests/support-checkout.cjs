const assert=require('node:assert/strict');
const create=require('../api/support_checkout');
const eligible=require('../api/founder_payment');
(async()=>{
 const calls=[];let session={metadata:{userId:'7',purchaseType:'support_tip'},mode:'payment',payment_status:'paid',currency:'gbp',amount_total:300};
 const stripe={checkout:{sessions:{create:async(...args)=>{calls.push(args);return{url:'https://checkout.stripe.com/test'};},retrieve:async()=>session}}};
 const router=create({stripe,requireAuth:(req,res,next)=>next(),enabled:true,frontendUrl:'http://127.0.0.1:5182'});
 async function call(router,path,body={},query={}){const res={code:200,set(){return this},status(n){this.code=n;return this},json(data){this.data=data;return this}};await router.stack.find(l=>l.route?.path===path).route.stack[0].handle({body,query,user:{id:7}},res);return res;}
 const attemptId='12345678-1234-1234-1234-123456789abc';
 for(const amount of [1,1499,'300',-300,300.1])assert.equal((await call(router,'/checkout',{amount,attemptId})).code,400);
 assert.equal(calls.length,0);
 for(const amount of [300,500,1000])assert.equal((await call(router,'/checkout',{amount,attemptId})).code,200);
 assert.equal(calls[0][0].line_items[0].price_data.unit_amount,300);
 assert.equal(calls[0][0].metadata.purchaseType,'support_tip');
 assert.equal(calls[0][1].idempotencyKey,calls[1][1].idempotencyKey);
 const off=create({stripe,requireAuth:(q,r,n)=>n(),enabled:false});assert.equal((await call(off,'/checkout',{amount:300,attemptId})).code,503);
 const status=()=>call(router,'/status',{}, {sessionId:'cs_test_123'});
 assert.equal((await status()).data.paid,true);session.payment_status='unpaid';assert.equal((await status()).data.paid,false);
 session.metadata.userId='8';assert.equal((await status()).code,404);
 const founder={mode:'payment',payment_status:'paid',currency:'gbp',amount_total:1499,metadata:{userId:'7'}};
 assert.equal(eligible(founder),true);
 for(const change of [{payment_status:'unpaid'},{amount_total:300},{currency:'usd'},{metadata:{userId:'7',purchaseType:'support_tip'}}])assert.equal(eligible({...founder,...change}),false);
 console.log('PASS: disabled checkout, amount validation, idempotency key, session ownership, paid confirmation, legacy Founder eligibility and tip separation (stubbed Stripe)');
})().catch(e=>{console.error(e);process.exitCode=1});
