const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const express=require('express');
const Stripe=require('stripe');
test('actual raw-body middleware preserves signed Stripe request and reaches webhook route',async()=>{
 const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
 const mount=source.match(/app\.use\(\s*'\/api\/founder\/webhook',[\s\S]*?\n\);/)[0];
 const app=express();new Function('app','express',mount)(app,express);app.use(express.json());
 const stripe=new Stripe('sk_test_not_a_real_key');const secret='whsec_isolated_test';
 const router=express.Router();router.post('/webhook',(req,res)=>{assert.ok(Buffer.isBuffer(req.body));const event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],secret);res.json({id:event.id});});app.use('/api/founder',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try {const payload=JSON.stringify({id:'evt_local',type:'checkout.session.completed'});const signature=stripe.webhooks.generateTestHeaderString({payload,secret});const result=await fetch(`http://127.0.0.1:${server.address().port}/api/founder/webhook`,{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});assert.equal(result.status,200);assert.deepEqual(await result.json(),{id:'evt_local'});}finally{await new Promise(r=>server.close(r));}
});
