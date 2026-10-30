const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizeSessions,parsePeriod,readSessions}=require('../api/donation_report');
const base={livemode:true,mode:'payment',currency:'gbp',amount_total:300,payment_status:'paid',status:'complete',created:1793386800,metadata:{userId:'5',purchaseType:'support_tip'}};
test('only verified live GBP support and Founder sessions count; retries do not invent revenue',()=>{
 const result=summarizeSessions([{...base,id:'a'},{...base,id:'b',amount_total:500}, {...base,id:'c',amount_total:1499,metadata:{userId:'6',purchaseType:'founder'}}, {...base,id:'open',payment_status:'unpaid',status:'open'}, {...base,id:'expired',payment_status:'unpaid',status:'expired'}, {...base,id:'test',livemode:false}, {...base,id:'usd',currency:'usd'}, {...base,id:'other',metadata:{purchaseType:'other'}}, {...base,id:'invalid',amount_total:1}]);
 assert.equal(result.grossPence,2299);assert.equal(result.contributionPence,800);assert.equal(result.founderPence,1499);assert.equal(result.donorCount,2);assert.equal(result.paidCount,3);assert.equal(result.checkoutCount,5);assert.equal(result.expiredCount,1);assert.equal(result.openCount,1);
});
test('period validation rejects invalid, future and excessive ranges',()=>{
 const now=Date.parse('2026-10-30T21:00:00Z');assert.equal(parsePeriod({from:'2026-10-30T20:00:00Z',to:'2026-10-30T21:00:00Z'},now).gte,1793390400);
 for(const query of [{from:'bad',to:'bad'},{from:'2026-08-01',to:'2026-10-30'},{from:'2026-10-30T22:00:00Z',to:'2026-10-30T23:00:00Z'},{from:'2026-10-30',to:'2026-10-29'}])assert.throws(()=>parsePeriod(query,now));
});
test('pagination retrieves subsequent sessions and signals truncation',async()=>{
 let calls=0;const stripe={checkout:{sessions:{list:async p=>{calls++;if(calls===2)assert.equal(p.starting_after,'a');return {data:[{id:calls===1?'a':'b'}],has_more:calls===1};}}}};
 const result=await readSessions(stripe,{gte:1,lt:2});assert.equal(result.sessions.length,2);assert.equal(result.complete,true);
 stripe.checkout.sessions.list=async()=>({data:[{id:'x'}],has_more:true});const partial=await readSessions(stripe,{gte:1,lt:2});assert.equal(partial.complete,false);assert.equal(partial.sessions.length,20);
});
