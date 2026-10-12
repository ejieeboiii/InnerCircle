const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'innercircle-admin-'));
const dataDir = path.join(fixture,'data');
fs.mkdirSync(dataDir);
const password = crypto.randomBytes(24).toString('base64url');
const username = 'Test Moderator';
let base, child;
const sockets=[];
async function launch(extraEnv={}) {
  child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:'0',INNERCIRCLE_DATA_DIR:dataDir,INNERCIRCLE_UPLOADS_DIR:path.join(fixture,'uploads'),INNERCIRCLE_ADMIN_USERNAME:username,INNERCIRCLE_ADMIN_PASSWORD:password,...extraEnv},stdio:['ignore','pipe','pipe']});
  base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Startup timed out')),10000);
    child.once('error',err=>{clearTimeout(timer);reject(err);});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited: '+code));});
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.stdout.on('data',chunk=>{const m=chunk.toString().match(/http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});
  });
}
async function stop(){if(child&&!child.killed){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}}
function database(){return new Database(path.join(dataDir,'innercircle.db'));}
function session(){
  const cookies=new Map();
  async function request(url,options={}) {
    const response=await fetch(base+url,{...options,headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});
    for(const cookie of response.headers.getSetCookie()){
      const [key,value]=cookie.split(';')[0].split('=');if(value)cookies.set(key,value);else cookies.delete(key);
    }
    return response;
  }
  async function json(url,options={}){const res=await request(url,options);return {status:res.status,data:await res.json(),res};}
  async function login(secret=password){return json('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:secret})});}
  async function adminPost(url,csrf){return json(url,{method:'POST',headers:{'X-CSRF-Token':csrf}});}
  async function connect(name='Member',expectBan=false) {
    const r=await request('/socket.io/?EIO=4&transport=polling');
    const sid=JSON.parse((await r.text()).slice(1)).sid;
    const url='/socket.io/?EIO=4&transport=polling&sid='+sid;
    const queue=[];let running=true,ack=0,failure;
    async function send(packet){const r=await request(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:packet});assert.equal(r.status,200);}
    const pump=(async()=>{while(running){try{const r=await request(url);if(!r.ok){running=false;break;}for(const p of (await r.text()).split('\x1e')){if(p==='2')await send('3');else{queue.push(p);if(p==='1')running=false;}}}catch(e){failure=e;break;}}})();
    async function wait(test){for(let i=0;i<200;i++){const n=queue.findIndex(test);if(n>=0)return queue.splice(n,1)[0];if(failure)throw failure;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Socket event timed out');}
    async function call(event,payload){const n=++ack;await send('42'+n+JSON.stringify([event,payload]));const p=await wait(p=>p.startsWith('43'+n+'['));return JSON.parse(p.slice(('43'+n).length))[0];}
    async function close(){running=false;try{await send('41');await send('1');}catch{}await pump;}
    await send('40');const joined=await wait(p=>p.startsWith('40')||p.startsWith('44'));
    if(expectBan){assert(joined.startsWith('44'));assert.equal(JSON.parse(joined.slice(2)).data.banned,true);await close();return null;}
    assert(joined.startsWith('40'));assert.equal((await call('join',name)).ok,true);
    const socket={call,async emit(event,payload){await send('42'+JSON.stringify([event,payload]));},async event(event){const p=await wait(p=>p.startsWith('42')&&JSON.parse(p.slice(2))[0]===event);return JSON.parse(p.slice(2))[1];},close};
    sockets.push(socket);return socket;
  }
  function deviceId(){const d=database();try{return d.prepare('SELECT id FROM devices WHERE token_hash=?').get(crypto.createHash('sha256').update(cookies.get('innercircle-device')).digest('hex')).id;}finally{d.close();}}
  return {request,json,login,adminPost,connect,cookies,deviceId};
}
async function upload(session,kind){
  const form=new FormData();form.append('media',new Blob([kind==='image'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'):Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109])],{type:kind==='image'?'image/png':'video/mp4'}),'test.'+(kind==='image'?'png':'mp4'));
  const result=await session.json('/api/upload',{method:'POST',body:form});assert.equal(result.status,200);return result.data.url;
}
(async()=>{
  // Start from the original schema and verify existing records survive both migrations.
  const legacy=database();legacy.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY,sender TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,owner_id TEXT,deleted_at TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL);
    CREATE TABLE message_hidden (message_id TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(message_id,device_id));
    CREATE TABLE media_uploads (url TEXT PRIMARY KEY,device_id TEXT NOT NULL,kind TEXT NOT NULL);`);
  const oldMessages=[];for(let i=1;i<=105;i++){const m={id:'legacy-'+i,sender:'Original member',kind:'text',body:'Original '+i,created_at:'2025-01-01T00:00:00.000Z'};oldMessages.push(m);legacy.prepare('INSERT INTO messages (id,sender,kind,body,created_at) VALUES (@id,@sender,@kind,@body,@created_at)').run(m);}
  const preservedHash=crypto.createHash('sha256').update('original device credential').digest('hex');
  legacy.prepare('INSERT INTO devices VALUES (?,?)').run('preserved-device',preservedHash);
  legacy.prepare('UPDATE messages SET owner_id=? WHERE id=?').run('preserved-device','legacy-1');
  legacy.prepare('INSERT INTO message_hidden VALUES (?,?)').run('legacy-2','preserved-device');
  legacy.prepare('INSERT INTO media_uploads VALUES (?,?,?)').run('/uploads/00000000-0000-0000-0000-000000000000.png','preserved-device','image');legacy.close();
  await launch();
  const d=database();assert.deepEqual(d.prepare('SELECT id,sender,kind,body,created_at FROM messages ORDER BY rowid').all(),oldMessages);
  const account=d.prepare('SELECT * FROM admin_accounts').get();assert.notEqual(account.password_hash,password);assert.match(account.password_hash,/^[a-f0-9]{128}$/);assert.match(account.password_salt,/^[a-f0-9]{32}$/);d.close();
  const preserved=database();assert.equal(preserved.prepare('SELECT token_hash FROM devices WHERE id=?').get('preserved-device').token_hash,preservedHash);
  assert.equal(preserved.prepare('SELECT member_name FROM devices WHERE id=?').get('preserved-device').member_name,'Original member');
  assert.equal(preserved.prepare('SELECT count(*) n FROM message_hidden').get().n,1);assert.equal(preserved.prepare('SELECT count(*) n FROM media_uploads').get().n,1);preserved.close();
  console.log('PASS migration preserves history and initial admin password is hashed');
  const user=session(),other=session(),admin=session();
  await Promise.all([user.json('/api/session'),other.json('/api/session'),admin.json('/api/session')]);
  const missingRoute=await user.json('/api/nonexistent');assert.equal(missingRoute.status,404);assert.match(missingRoute.data.error,/API route not found/);
  const su=await user.connect('Same name'),su2=await user.connect('Same name'),so=await other.connect('Same name');
  const userId=user.deviceId(),otherId=other.deviceId();
  assert.equal((await user.json('/api/admin/members')).status,403);
  assert.equal((await user.json('/api/admin/messages')).status,403);
  assert.equal((await user.adminPost('/api/admin/members/'+otherId+'/remove','forged')).status,403);
  assert.equal((await user.adminPost('/api/admin/members/'+otherId+'/unban','forged')).status,403);
  assert.equal((await user.adminPost('/api/admin/messages/legacy-1/delete','forged')).status,403);
  assert.match((await su.call('admin-remove-member',{id:otherId,role:'admin',csrf:'forged'})).error,/Admin access/);
  assert.match((await su.call('admin-unban-member',{id:otherId,csrf:'forged'})).error,/Admin access/);
  assert.match((await su.call('admin-delete-message',{id:'legacy-1',csrf:'forged'})).error,/Admin access/);
  assert.equal((await admin.login('Incorrect password')).status,401);
  assert.equal((await admin.request('/api/admin/login',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:JSON.stringify({username,password})})).status,403);
  const logged=await admin.login();assert.equal(logged.status,200);assert.equal(logged.data.role,'admin');const csrf=logged.data.csrf;
  const sessionCookie=logged.res.headers.getSetCookie().find(c=>c.startsWith('innercircle-admin='));assert.match(sessionCookie,/HttpOnly/i);assert.match(sessionCookie,/SameSite=Strict/i);
  const sa=await admin.connect('Forged admin display name');assert.equal((await admin.json('/api/session')).data.name,username);
  assert.equal((await admin.adminPost('/api/admin/members/'+userId+'/remove','bad')).status,403);
  assert.match((await sa.call('admin-remove-member',{id:userId,csrf:'bad'})).error,/action token/);
  const stolen=admin.cookies.get('innercircle-admin');user.cookies.set('innercircle-admin',stolen);
  assert.equal((await user.json('/api/admin/members')).status,403);user.cookies.delete('innercircle-admin');
  console.log('PASS HTTP/socket authorization, password validation, origin/CSRF checks, and device-bound sessions');
  const members=(await admin.json('/api/admin/members')).data;
  assert.equal(members.total,4);assert.equal(members.online,3);assert.equal(members.members.filter(m=>m.name==='Same name').length,2);
  assert.equal((await user.json('/api/members')).data.online,3);
  assert(!JSON.stringify((await user.json('/api/members')).data).includes('token_hash'));
  const first=(await admin.json('/api/admin/messages')).data;assert.equal(first.messages.length,100);assert(first.nextBefore);
  const older=(await admin.json('/api/admin/messages?before='+first.nextBefore)).data;assert.equal(older.messages.length,5);assert.equal(older.nextBefore,null);
  assert.equal((await admin.json('/api/admin/messages?before=bad')).status,400);
  console.log('PASS member identities, online counts per device, and full-history pagination');
  await so.emit('chat-message',{kind:'text',body:'Hide from own view'});const hidden=await so.event('chat-message');await sa.event('chat-message');await su.event('chat-message');await su2.event('chat-message');
  assert.equal((await so.call('delete-message',{id:hidden.id,scope:'me'})).ok,true);await so.event('message-hidden');
  assert(!(await other.json('/api/messages')).data.some(m=>m.id===hidden.id));
  assert((await admin.json('/api/admin/messages')).data.messages.some(m=>m.id===hidden.id));
  for(const kind of ['text','image','video']){
    const body=kind==='text'?'Moderate this message':await upload(other,kind);
    await so.emit('chat-message',{kind,body});const m=await so.event('chat-message');await sa.event('chat-message');await su.event('chat-message');await su2.event('chat-message');
    const result=kind==='image'?await admin.adminPost('/api/admin/messages/'+m.id+'/delete',csrf):{status:200,data:await sa.call('admin-delete-message',{id:m.id,csrf})};
    assert.equal(result.status,200);assert.equal(result.data.ok,true);
    for(const socket of [so,sa,su,su2])assert.equal((await socket.event('message-deleted')).byAdmin,true);
    const placeholder=(await user.json('/api/messages')).data.find(v=>v.id===m.id);assert.equal(placeholder.body,'This message was deleted by admin.');assert.equal(placeholder.deletedByAdmin,true);
    if(kind!=='text')assert.equal((await other.request(body)).status,404);
  }
  assert.equal((await sa.call('delete-message',{id:'legacy-1',scope:'everyone',csrf})).ok,true);
  for(const socket of [so,sa,su,su2])await socket.event('message-deleted');
  const audit=database();assert.equal(audit.prepare('SELECT count(*) n FROM message_moderation').get().n,4);audit.close();
  console.log('PASS admin moderation of text, images, videos, hidden and legacy messages, with audit records and media blocking');
  const activeUrl=await upload(other,'image');await so.emit('chat-message',{kind:'image',body:activeUrl});for(const socket of [so,sa,su,su2])await socket.event('chat-message');
  assert.equal((await admin.adminPost('/api/admin/members/'+admin.deviceId()+'/remove',csrf)).status,409);
  assert.equal((await sa.call('admin-remove-member',{id:userId,csrf})).ok,true);
  assert.match((await su.event('member-removed')).message,/removed/);await su2.event('member-removed');
  assert.equal((await user.json('/api/session')).data.banned,true);
  assert.equal((await user.json('/api/messages')).status,403);assert.equal((await user.json('/api/members')).status,403);
  assert.equal((await user.request(activeUrl)).status,403);
  const blockedUpload=await user.request('/api/upload',{method:'POST'});assert.equal(blockedUpload.status,403);
  assert.equal((await user.login()).status,403);await user.connect('New name',true);
  const publicAfter=(await other.json('/api/members')).data;assert.equal(publicAfter.total,3);assert(!publicAfter.members.some(m=>m.id===userId));
  const adminAfter=(await admin.json('/api/admin/members')).data;assert.equal(adminAfter.banned,1);assert.equal(adminAfter.members.find(m=>m.id===userId).banned,true);
  const escaped=session();await escaped.json('/api/session');assert.equal((await escaped.json('/api/session')).data.banned,false);
  console.log('PASS ban revokes all device sockets and blocks history, uploads, media, login, and same-session rejoin; public list updates');
  // Persist bans and sessions across restart without the bootstrap secrets.
  for(const socket of sockets)await socket.close();await stop();await launch({INNERCIRCLE_ADMIN_USERNAME:'',INNERCIRCLE_ADMIN_PASSWORD:''});
  assert.equal((await user.json('/api/session')).data.banned,true);assert.equal((await admin.json('/api/admin/members')).status,200);
  const sa2=await admin.connect();assert.equal((await sa2.call('admin-unban-member',{id:userId,csrf})).ok,true);
  assert.equal((await user.json('/api/session')).data.banned,false);const unbanned=await user.connect('Restored member');await unbanned.emit('chat-message',{kind:'text',body:'Can send again'});await unbanned.event('chat-message');await sa2.event('chat-message');
  const freshHistory=(await admin.json('/api/messages')).data;assert(freshHistory.some(m=>m.deletedByAdmin));
  console.log('PASS bans, moderation and admin sessions persist across restart; unban restores chat participation');
  // Logout invalidates a copied cookie and all sockets using that session.
  const revokedCookie=admin.cookies.get('innercircle-admin');const logout=await admin.adminPost('/api/admin/logout',csrf);assert.equal(logout.status,200);await sa2.event('admin-session-ended');
  admin.cookies.set('innercircle-admin',revokedCookie);assert.equal((await admin.json('/api/admin/members')).status,403);
  assert.equal((await admin.json('/api/session')).data.role,'user');
  const loginAgain=await admin.login();assert.equal(loginAgain.status,200);const sa3=await admin.connect();
  const expiry=database();expiry.prepare('UPDATE admin_sessions SET expires_at=? WHERE revoked_at IS NULL').run(Date.now()-1);expiry.close();
  assert.equal((await admin.json('/api/admin/members')).status,403);
  assert.match((await sa3.call('admin-delete-message',{id:'legacy-2',csrf:loginAgain.data.csrf})).error,/Admin access/);
  console.log('PASS logout/replayed cookie rejection and expired-session HTTP/socket authorization');
  for(let i=0;i<5;i++)assert.equal((await admin.login('Wrong password')).status,401);
  assert.equal((await admin.login('Wrong password')).status,429);
  for(const socket of sockets)await socket.close();await stop();
  // Production never accepts admin credentials over plain HTTP. Trust only our loopback test proxy.
  await launch({NODE_ENV:'production',INNERCIRCLE_TRUST_PROXY:'loopback'});
  const production=session();await production.json('/api/session');assert.equal((await production.login()).status,400);
  const secureSession=session();
  const secure=await secureSession.request('/api/session',{headers:{'X-Forwarded-Proto':'https'}});assert.match(secure.headers.getSetCookie()[0] || '',/Secure/i);
  const rateDb=database();rateDb.prepare('DELETE FROM admin_login_attempts').run();rateDb.close();
  const secureLogin=await secureSession.request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https'},body:JSON.stringify({username,password})});
  assert.equal(secureLogin.status,200);assert.match(secureLogin.headers.getSetCookie().find(c=>c.startsWith('innercircle-admin=')),/Secure/i);
  console.log('PASS login throttling, production HTTPS requirement, and Secure cookies behind a trusted proxy');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{for(const socket of sockets)await socket.close();await stop();});
