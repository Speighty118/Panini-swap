process.env.JWT_SECRET='isolated-support-http-test-only';
process.env.DATABASE_URL='postgresql://gos_test@127.0.0.1:55437/gos_integration';
const assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken');
const {requireAuth}=require('../api/middleware/auth');
const create=require('../api/support_checkout');
(async()=>{
 const sessions=new Map();let count=0;
 const stripe={checkout:{sessions:{create:async(body,options)=>{
   if(!sessions.has(options.idempotencyKey)){count++;sessions.set(options.idempotencyKey,{url:'https://checkout.stripe.com/c/pay/cs_test_'+count});}
   return sessions.get(options.idempotencyKey);
 },retrieve:async()=>({mode:'payment',currency:'gbp',amount_total:300,payment_status:'paid',metadata:{userId:'7',purchaseType:'support_tip'}})}}};
 const app=express();app.use(express.json());app.use('/support',create({stripe,requireAuth,enabled:true,frontendUrl:'http://127.0.0.1:5182'}));
 const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const origin='http://127.0.0.1:'+server.address().port;
 const token=jwt.sign({userId:7},process.env.JWT_SECRET,{expiresIn:'1m'});
 const headers={'content-type':'application/json',authorization:'Bearer '+token};
 try{
  assert.equal((await fetch(origin+'/support/checkout',{method:'POST'})).status,401);
  assert.equal((await fetch(origin+'/support/checkout',{method:'POST',headers:{authorization:'Bearer invalid'}})).status,401);
  const body=JSON.stringify({amount:300,attemptId:'00000000-0000-0000-0000-000000000001'});
  const responses=await Promise.all([1,2].map(()=>fetch(origin+'/support/checkout',{method:'POST',headers,body})));
  for(const response of responses)assert.equal(response.status,200);
  assert.equal(count,1);
  const result=await fetch(origin+'/support/status?sessionId=cs_test_1',{headers});assert.equal(result.headers.get('cache-control'),'no-store');assert.equal((await result.json()).paid,true);
  const other=jwt.sign({userId:8},process.env.JWT_SECRET);
  assert.equal((await fetch(origin+'/support/status?sessionId=cs_test_1',{headers:{authorization:'Bearer '+other}})).status,404);
  console.log('PASS HTTP: actual JWT middleware, invalid auth, concurrent retry, payment confirmation and cross-account access. Stripe stubbed; no external traffic.');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
