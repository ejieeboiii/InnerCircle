const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const {io}=require('socket.io-client');
const {createDatabase}=require('../lib/database');
const {migrate}=require('../lib/schema');
const {createStorage}=require('../lib/storage');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'innercircle-cloud-'));
const databaseURL=pathToFileURL(path.join(fixture,'cluster.db')).href;
const password=crypto.randomBytes(24).toString('base64url');
const processes=[],connections=[];
async function launch(number){
  const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',VERCEL:'',PORT:'0',TURSO_DATABASE_URL:databaseURL,TURSO_AUTH_TOKEN:'',BLOB_READ_WRITE_TOKEN:'',INNERCIRCLE_UPLOADS_DIR:path.join(fixture,'uploads-'+number),INNERCIRCLE_ADMIN_USERNAME:'Cloud Moderator',INNERCIRCLE_ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});processes.push(child);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Cluster startup timed out')),15000);child.stderr.on('data',c=>process.stderr.write(c));child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('Cluster server exited '+code));});child.stdout.on('data',c=>{const m=c.toString().match(/http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});});
}
function session(base){
  const cookies=new Map();let csrf;
  async function request(url,options={}){const res=await fetch(base+url,{...options,headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of res.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');if(v)cookies.set(k,v);else cookies.delete(k);}return res;}
  async function json(url,options={}){const res=await request(url,options);return {status:res.status,data:await res.json()};}
  async function connect(target=base,name='Cluster Member',expectBan=false){
    const socket=io(target,{autoConnect:false,transports:['websocket'],reconnection:false,extraHeaders:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}});connections.push(socket);
    const queue=[];socket.onAny((type,payload)=>queue.push({type,payload}));
    async function event(type,test=()=>true){for(let i=0;i<400;i++){const index=queue.findIndex(e=>e.type===type&&test(e.payload));if(index>=0)return queue.splice(index,1)[0].payload;await new Promise(r=>setTimeout(r,25));}throw Error('Missing event '+type);}
    const connected=new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',expectBan?resolve:reject);});socket.connect();const error=await connected;
    if(expectBan){assert(error?.data?.banned);socket.disconnect();return;}
    async function call(type,payload){return new Promise((resolve,reject)=>socket.timeout(10000).emit(type,payload,(err,result)=>err?reject(err):resolve(result)));}
    assert.equal((await call('join',name)).ok,true);
    return {socket,event,call};
  }
  return {json,request,connect,get csrf(){return csrf;},async login(){const result=await json('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Cloud Moderator',password})});assert.equal(result.status,200);csrf=result.data.csrf;},post(url){return json(url,{method:'POST',headers:{'X-CSRF-Token':csrf}});}};
}
(async()=>{
  const a=await launch(1),b=await launch(2),admin=session(a),member=session(b),observer=session(a);
  for(const s of [admin,member,observer])assert.equal((await s.json('/api/session')).status,200);
  await admin.login();const sa=await admin.connect(a,'Admin'),sm=await member.connect(b,'Shared member'),sm2=await member.connect(a,'Shared member'),so=await observer.connect(a,'Observer');
  const members=(await admin.json('/api/admin/members')).data;assert.equal(members.online,3);const id=members.members.find(m=>m.name==='Shared member').id;
  const sent=await sm.call('chat-message',{kind:'text',body:'Cross-instance message'});assert.equal(sent.ok,true);
  for(const s of [sm,sa,sm2,so])assert.equal((await s.event('chat-message',m=>m.id===sent.id)).body,'Cross-instance message');
  assert.equal((await sm.call('delete-message',{id:sent.id,scope:'me'})).ok,true);for(const s of [sm,sm2])await s.event('message-hidden',m=>m.id===sent.id);
  assert(!(await member.json('/api/messages')).data.some(m=>m.id===sent.id));assert((await observer.json('/api/messages')).data.some(m=>m.id===sent.id));
  assert.equal((await sa.call('admin-delete-message',{id:sent.id,csrf:admin.csrf})).ok,true);for(const s of [sa,sm,sm2,so])assert.equal((await s.event('message-deleted',m=>m.id===sent.id)).byAdmin,true);
  const moderated=(await observer.json('/api/messages')).data.find(m=>m.id===sent.id);assert.equal(moderated.body,'This message was deleted by admin.');
  console.log('PASS libSQL async adapter, two-instance WebSocket delivery, shared presence, private hiding, and admin moderation');
  assert.equal((await admin.post('/api/admin/members/'+id+'/remove')).status,200);for(const s of [sm,sm2])await s.event('member-removed');
  assert.equal((await member.json('/api/messages')).status,403);await member.connect(b,'Changed name',true);
  assert.equal((await admin.post('/api/admin/members/'+id+'/unban')).status,200);const restored=await member.connect(b,'Restored member');assert.equal((await restored.call('chat-message',{kind:'text',body:'After unban'})).ok,true);
  const adminOther=await admin.connect(b,'Admin');assert.equal((await admin.post('/api/admin/logout')).status,200);await sa.event('admin-session-ended');await adminOther.event('admin-session-ended');
  console.log('PASS cross-instance multi-tab removal, banned reconnect rejection, unban, and session logout propagation');
  // Exercise private media authorization and streaming with a controlled Blob provider.
  const db=createDatabase({url:'',token:'',filename:path.join(fixture,'storage.db')});await migrate(db);
  await db.prepare('INSERT INTO devices (id,token_hash,member_name) VALUES (?,?,?)').run('owner','owner-token','Owner');
  await db.prepare('INSERT INTO devices (id,token_hash,member_name) VALUES (?,?,?)').run('other','other-token','Other');
  let isBanned=false,meta,options;
  const storage=createStorage(db,async()=>isBanned,{blob:{async head(){return meta;},async get(){return {statusCode:200,blob:{size:10,contentType:'video/mp4'},stream:new ReadableStream({start(c){c.enqueue(Buffer.from('0123456789'));c.close();}})};}},client:{async handleUpload(config){options=await config.onBeforeGenerateToken(config.body.pathname,config.body.clientPayload);return options;}}});
  const ticket=await storage.prepare('owner','video/mp4',10);
  await assert.rejects(()=>storage.prepare('owner','video/mp4',21*1024*1024));
  await storage.handle({device:'owner',body:{pathname:ticket.pathname,clientPayload:JSON.stringify({id:ticket.id})}});assert.equal(options.maximumSizeInBytes,10);assert.deepEqual(options.allowedContentTypes,['video/mp4']);assert.equal(options.allowOverwrite,false);
  await assert.rejects(()=>storage.handle({device:'other',body:{pathname:ticket.pathname,clientPayload:JSON.stringify({id:ticket.id})}}));
  await assert.rejects(()=>storage.handle({device:'owner',body:{pathname:'media/another.mp4',clientPayload:JSON.stringify({id:ticket.id})}}));
  meta={pathname:ticket.pathname,size:9,contentType:'video/mp4'};await assert.rejects(()=>storage.finish(ticket.id,'owner'));
  meta.size=10;assert.equal((await storage.finish(ticket.id,'owner')).url,ticket.url);await storage.finish(ticket.id,'owner');
  assert.equal((await db.prepare('SELECT count(*) n FROM media_objects').get()).n,1);assert.equal((await db.prepare('SELECT count(*) n FROM media_uploads').get()).n,1);
  const {PassThrough}=require('node:stream');const res=new PassThrough();const headers={};let status=200;res.set=(key,value)=>{if(typeof key==='string')headers[key]=value;else Object.assign(headers,key);return res;};res.status=n=>{status=n;return res;};res.sendStatus=n=>{status=n;res.end();return res;};
  const chunks=[];res.on('data',c=>chunks.push(c));const done=new Promise(resolve=>res.on('finish',resolve));
  await storage.stream({headers:{range:'bytes=2-5'},method:'GET'},res,{pathname:ticket.pathname,size:10,content_type:'video/mp4'},async()=>true);await done;
  assert.equal(status,206);assert.equal(headers['Content-Range'],'bytes 2-5/10');assert.equal(Buffer.concat(chunks).toString(),'2345');
  isBanned=true;await assert.rejects(()=>storage.finish(ticket.id,'owner'));db.close();
  console.log('PASS private upload tickets, owner/path/size constraints, finalization idempotency, ban checks, and video range streaming');
})().catch(err=>{console.error(err);process.exitCode=1;}).finally(async()=>{connections.forEach(s=>s.disconnect());for(const p of processes)if(!p.killed){const exited=new Promise(r=>p.once('exit',r));p.kill();await exited;}});
