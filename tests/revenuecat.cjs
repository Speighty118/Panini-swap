const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../api/revenuecat_handler');
const event = {environment:'PRODUCTION',type:'NON_RENEWING_PURCHASE',product_id:'com.gotonespare.app.founder.v2',app_user_id:'42',transaction_id:'test-transaction',currency:'GBP',price_in_purchased_currency:14.99};
function harness(){
 let queries=[], notifications=0, fail=false, member=false;
 const handler=create({secret:'isolated-test',pool:{query:async(sql,args)=>{queries.push(args);if(fail)throw Error('offline');if(member)return {rows:[]};member=true;return {rows:[{id:42,name:'Test',email:'test@example.invalid'}]};}},notify:async()=>notifications++,welcome:async()=>{}});
 return {queries,get notifications(){return notifications},set fail(v){fail=v},async call(e=event,auth='Bearer isolated-test') {let code=200,body; const res={status(n){code=n;return this},json(b){body=b;return this}};await handler({headers:{authorization:auth},body:{event:e}},res);return {code,body};}};
}
test('new Founder purchase grants once; retries preserve existing recognition',async()=>{const h=harness();assert.equal((await h.call()).code,200);await h.call();assert.equal(h.notifications,1);assert.deepEqual(h.queries[0],['test-transaction',1499,42]);});
test('rejects unauthorized and ignores sandbox, tips, malformed identities and events',async()=>{const h=harness();assert.equal((await h.call(event,'bad')).code,401);for(const patch of [{environment:'SANDBOX'},{environment:undefined},{product_id:'com.gotonespare.app.support.small'},{app_user_id:'42other'},{app_user_id:'support-sandbox-test'},{app_user_id:'9007199254740993'},{type:'CANCELLATION'},{transaction_id:null}])await h.call({...event,...patch});assert.equal(h.queries.length,0);});
test('database failures request a retry instead of losing the purchase',async()=>{const h=harness();h.fail=true;assert.equal((await h.call()).code,500);h.fail=false;assert.equal((await h.call()).code,200);assert.equal(h.notifications,1);});
