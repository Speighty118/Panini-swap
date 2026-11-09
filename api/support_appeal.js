const crypto = require('node:crypto');
const SENDER = 121;
const KEY = 'winter-update-2026-11-09';
const DEADLINE = Date.parse('2026-11-12T00:00:00Z');
const BODY = `Hi everyone, it’s Tom from Got One Spare? 👋

More than 500 of you have joined Got One Spare? Together you’ve started over 5,400 swaps, with 768 marked as completed. If you’ve ever opened an envelope and found the sticker you needed for that stubborn gap in your album, that’s exactly why I built this. You’re the ones who sorted through your spares, wrote the addresses and put those envelopes in the post. I’m proud of what we’ve built together.

That makes this a hard message to write. Our appeal has raised £10 towards the £150 we need to keep swapping open. If we fall short by the end of Wednesday 11 November, I’ll close Got One Spare? to new swaps. I’d love to bring it back for another collection one day, but I can’t promise that will happen.

If you’ve already agreed a swap or there’s an envelope on its way, you’ll have time to finish it. I’ll send the exact dates, and you’ll have at least two weeks from the closure notice to message your partner, mark stickers as posted or received, or let us know if something hasn’t arrived. We’ll keep your account and collection lists so you can use the same login if we reopen.

The appeal is still open until Wednesday night. If we reach £150, swapping will stay open. If you’d like to chip in, you can open More → Support Got One Spare? on iPhone, or use the website:
https://www.gotonespare.com/?support=1

If swapping does close, any contributions made afterwards will go towards future development. To everyone who’s already donated, thank you. And whether you made one swap or dozens, thank you for trusting another collector with your spares. That’s the part of Got One Spare? I’ll remember most.

Tom 💛`;
const ELIGIBLE = `u.id <> ${SENDER} AND COALESCE(u.is_suspended,FALSE) = FALSE
 AND u.email IS NOT NULL AND u.email !~* '^gotonespare@'
 AND COALESCE(u.name,'') !~* '(appletest|testaccount|testpartner|^test\\y)'
 AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
 (b.blocker_id=u.id AND b.blocked_id=${SENDER}) OR (b.blocker_id=${SENDER} AND b.blocked_id=u.id))`;
const signature = (value,secret) => crypto.createHmac('sha256',secret).update(value).digest('hex');
function encode(ids,secret,now=Date.now()) {
 const data=Buffer.from(JSON.stringify({key:KEY,ids,expires:Math.min(now+86400000,DEADLINE),bodyHash:signature(BODY,secret)})).toString('base64url');
 return data+'.'+signature(data,secret);
}
function decode(token,secret,now=Date.now()) {
 const [data,sig]=String(token||'').split('.'); const expected=signature(data||'',secret);
 if(!sig || sig.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) throw new Error('Invalid preview. Preview the campaign again.');
 const p=JSON.parse(Buffer.from(data,'base64url').toString());
 if(p.key!==KEY || p.expires<=now || now>=DEADLINE || p.bodyHash!==signature(BODY,secret) || !Array.isArray(p.ids) || p.ids.length>10000 || !p.ids.every(Number.isSafeInteger)) throw new Error('Preview expired. Preview the campaign again.');
 return p;
}
async function preview(pool,secret) {
 if(Date.now()>=DEADLINE) throw new Error('This appeal has ended.');
 const sender=await pool.query('SELECT name FROM users WHERE id=$1',[SENDER]);
 if(!/support/i.test(sender.rows[0]?.name||'')) throw new Error('Support sender account needs verification.');
 const {rows}=await pool.query(`SELECT u.id,u.name, EXISTS (SELECT 1 FROM direct_messages d JOIN conversation_participants cp ON cp.conversation_id=d.conversation_id WHERE cp.user_id=u.id AND d.sender_id=$1 AND d.body=$2) AS sent FROM users u WHERE ${ELIGIBLE} ORDER BY u.id`,[SENDER,BODY]);
 return {key:KEY,body:BODY,sender:sender.rows[0].name,total:rows.length,sent:rows.filter(r=>r.sent).length,recipients:rows.map(r=>({id:r.id,name:r.name,sent:r.sent})),token:encode(rows.map(r=>Number(r.id)),secret)};
}
async function sendBatch(pool,secret,token,push) {
 const {ids}=decode(token,secret); const client=await pool.connect(); const delivered=[];
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[KEY]);
  const {rows}=await client.query(`SELECT u.id FROM users u WHERE u.id=ANY($3::int[]) AND ${ELIGIBLE}
   AND NOT EXISTS (SELECT 1 FROM direct_messages d JOIN conversation_participants cp ON cp.conversation_id=d.conversation_id WHERE cp.user_id=u.id AND d.sender_id=$1 AND d.body=$2) ORDER BY u.id LIMIT 25`,[SENDER,BODY,ids]);
  for(const user of rows) {
   const existing=await client.query(`SELECT c.id FROM conversations c JOIN conversation_participants a ON a.conversation_id=c.id AND a.user_id=$1 JOIN conversation_participants b ON b.conversation_id=c.id AND b.user_id=$2 ORDER BY c.id LIMIT 1`,[SENDER,user.id]);
   let conversation=existing.rows[0]?.id;
   if(!conversation) {
    conversation=(await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id')).rows[0].id;
    await client.query('INSERT INTO conversation_participants (conversation_id,user_id) VALUES ($1,$2),($1,$3)',[conversation,SENDER,user.id]);
   }
   await client.query('INSERT INTO direct_messages (conversation_id,sender_id,body) VALUES ($1,$2,$3)',[conversation,SENDER,BODY]);
   await client.query(`INSERT INTO notifications (user_id,type,title,body) VALUES ($1,'direct_message','A note from Tom about the future of Got One Spare? 💛',$2)`,[user.id,'Swapping may be coming to an end. Please check your inbox for what happens after Wednesday and what it means if you already have stickers in the post.']);
   delivered.push(user.id);
  }
  await client.query('COMMIT');
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 // Inbox delivery is the durable record. Push is best effort and never retried on resume.
 await Promise.allSettled(delivered.map(id=>Promise.resolve().then(()=>push(id,{title:'A note from Tom about the future of Got One Spare? 💛',body:'Swapping may be coming to an end. Please check your inbox for what happens after Wednesday and what it means if you already have stickers in the post.'}))));
 return {sent:delivered.length,done:delivered.length===0};
}
module.exports={BODY,KEY,encode,decode,preview,sendBatch};
