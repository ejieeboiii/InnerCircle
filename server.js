const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createDatabase } = require('./lib/database');
const { migrate } = require('./lib/schema');
const { createRealtime } = require('./lib/realtime');
const { createStorage } = require('./lib/storage');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createAdminAuth, hashToken, tokenFromCookie, equalSecret, cookieOptions } = require('./lib/auth');
const app = express();
const route = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
app.use((req,res,next) => ready.then(() => next(), () => res.status(503).json({error:'Server storage is not configured or unavailable.'})));
app.disable('x-powered-by');
// Trust only the proxy addresses/hops explicitly configured by the operator.
if (process.env.VERCEL) app.set('trust proxy',1);
else if (process.env.INNERCIRCLE_TRUST_PROXY) {
  const proxy = process.env.INNERCIRCLE_TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(proxy) ? Number(proxy) : proxy);
}
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize:1e6, ...(process.env.VERCEL ? {transports:['websocket']} : {}) });
const PORT = process.env.PORT || 3000;
const dataDir = process.env.INNERCIRCLE_DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = process.env.INNERCIRCLE_UPLOADS_DIR || path.join(__dirname, 'uploads');
const db = createDatabase();
if (!process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) fs.mkdirSync(uploadsDir,{recursive:true});
const auth = createAdminAuth(db);
const storage = createStorage(db,banned);
const realtime = createRealtime(db,io,dispatchEvent);
const online = new Map();
const insert = db.prepare('INSERT INTO messages (id,sender,kind,body,created_at,owner_id) VALUES (@id,@sender,@kind,@body,@created_at,@owner_id)');
const recent = db.prepare(`SELECT * FROM (SELECT m.* FROM messages m WHERE NOT EXISTS
  (SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.device_id=?) ORDER BY created_at DESC, rowid DESC LIMIT 100) ORDER BY created_at ASC`);
async function deviceFromCookie(cookie = '') {
  const token = tokenFromCookie(cookie, 'innercircle-device');
  return token ? (await db.prepare('SELECT id FROM devices WHERE token_hash=?').get(hashToken(token)))?.id : null;
}
async function banned(device) {
  return !!(await db.prepare('SELECT 1 FROM member_bans WHERE device_id=? AND unbanned_at IS NULL').get(device));
}
async function socketAdmin(socket) { return (await auth.byHash(socket.data.adminHash, socket.data.device)); }
async function allowed(socket) { return online.has(socket.id) && !(await banned(socket.data.device)); }
function deletedText(m) { return m.deleted_by_admin ? 'This message was deleted by admin.' : 'This message was deleted.'; }
function view(m, device, admin = false) {
  return { id:m.id, sender:m.sender, kind:m.deleted_at ? 'text' : m.kind,
    body:m.deleted_at ? deletedText(m) : m.body, created_at:m.created_at,
    deleted:!!m.deleted_at, deletedByAdmin:!!m.deleted_by_admin, mine:m.owner_id === device,
    canDeleteEveryone:!m.deleted_at && (admin || m.owner_id === device) };
}
async function memberSnapshot(includeBanned = false) {
  const onlineDevices = new Set((await db.prepare('SELECT DISTINCT device_id FROM presence WHERE expires_at>?').all(Date.now())).map(r=>r.device_id));
  const adminDevices = new Set((await db.prepare('SELECT DISTINCT device_id FROM admin_sessions WHERE revoked_at IS NULL AND expires_at>?').all(Date.now())).map(r => r.device_id));
  const members = (await db.prepare(`SELECT d.id,d.member_name AS name,b.banned_at FROM devices d LEFT JOIN member_bans b
    ON b.device_id=d.id AND b.unbanned_at IS NULL WHERE d.member_name IS NOT NULL ORDER BY d.joined_at,d.id`).all())
    .filter(m => includeBanned || !m.banned_at)
    .map(m => ({ id:m.id, name:m.name, online:onlineDevices.has(m.id) && !m.banned_at,
      role:adminDevices.has(m.id) && !m.banned_at ? 'admin' : 'user', ...(includeBanned ? {banned:!!m.banned_at,bannedAt:m.banned_at} : {}) }));
  return { members, total:members.filter(m => !m.banned).length, online:members.filter(m => m.online).length,
    ...(includeBanned ? { banned:members.filter(m => m.banned).length } : {}) };
}
async function broadcastMembers() {
  const publicList = (await memberSnapshot()), adminList = (await memberSnapshot(true));
  for (const client of io.sockets.sockets.values()) {
    if (!(await allowed(client))) continue;
    client.emit('online-count', publicList.online);
    client.emit('members-updated', publicList);
    if ((await socketAdmin(client))) client.emit('admin-members-updated', adminList);
  }
}
async function dispatchEvent(event) {
  if(event.type==='members')return broadcastMembers();
  if(event.type==='check-access'){
    for(const client of io.sockets.sockets.values()){
      if(await banned(client.data.device)){client.emit('member-removed',{message:'You have been removed from InnerCircle.'});client.disconnect(true);}
      else if(client.data.adminHash && !await socketAdmin(client)){client.emit('admin-session-ended',{message:'Your admin session has expired. Please log in again.'});client.disconnect(true);}
    }
    return;
  }
  if(event.type==='removed' || event.type==='session-ended'){
    for(const client of io.sockets.sockets.values()){
      if(event.type==='removed' && client.data.device===event.target){online.delete(client.id);client.emit('member-removed',{message:'You have been removed from InnerCircle.'});client.disconnect(true);}
      if(event.type==='session-ended' && client.data.adminHash===event.target){client.emit('admin-session-ended',{message:'You have logged out as admin.'});client.disconnect(true);}
    }
    return broadcastMembers();
  }
  const m=await db.prepare('SELECT * FROM messages WHERE id=?').get(event.target);
  if(!m)return;
  for(const client of io.sockets.sockets.values()){
    if(!await allowed(client))continue;
    if(event.type==='message'){
      if(!await db.prepare('SELECT 1 FROM message_hidden WHERE message_id=? AND device_id=?').get(m.id,client.data.device))client.emit('chat-message',view(m,client.data.device,!!await socketAdmin(client)));
    }
    if(event.type==='deleted')client.emit('message-deleted',{id:m.id,byAdmin:!!m.deleted_by_admin});
    if(event.type==='hidden' && await db.prepare('SELECT 1 FROM message_hidden WHERE message_id=? AND device_id=?').get(m.id,client.data.device))client.emit('message-hidden',{id:m.id});
  }
}
async function freshAdmin(admin){return admin && !await banned(admin.device_id) && await auth.byHash(admin.token_hash,admin.device_id);}
async function moderateMessage(id,admin){
  if(typeof id!=='string' || id.length>100)return {error:'Invalid message ID.',status:400};
  let event;
  const result=await db.transaction(async()=>{
    if(!await freshAdmin(admin))return {error:'Admin access required.',status:403};
    const m=await db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if(!m)return {error:'Message not found.',status:404};
    if(!m.deleted_at){
      const now=new Date().toISOString();
      await db.prepare('UPDATE messages SET deleted_at=?,deleted_by_admin=? WHERE id=?').run(now,admin.admin_id,id);
      await db.prepare("INSERT INTO message_moderation (message_id,admin_id,action,created_at) VALUES (?,?,'delete',?)").run(id,admin.admin_id,now);
      event=await realtime.record('deleted',id);
    }
    return {ok:true};
  })();
  if(event)await realtime.deliver({id:event.lastInsertRowid,type:'deleted',target:id});
  return result;
}
async function manageMember(id,action,admin,actorDevice){
  if(typeof id!=='string' || id.length>100)return {error:'Invalid member ID.',status:400};
  let event;
  const result=await db.transaction(async()=>{
    if(!await freshAdmin(admin))return {error:'Admin access required.',status:403};
    if(!await db.prepare('SELECT id FROM devices WHERE id=? AND member_name IS NOT NULL').get(id))return {error:'Member not found.',status:404};
    if(action==='remove'){
      if(id===actorDevice || await db.prepare('SELECT 1 FROM admin_sessions WHERE device_id=? AND revoked_at IS NULL AND expires_at>?').get(id,Date.now()))return {error:'An active admin cannot be removed. Log out that admin first.',status:409};
      if(!await banned(id))await db.prepare('INSERT INTO member_bans (device_id,banned_at,banned_by) VALUES (?,?,?)').run(id,new Date().toISOString(),admin.admin_id);
      await db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(Date.now(),id);
      await db.prepare('DELETE FROM presence WHERE device_id=?').run(id);
    }else await db.prepare('UPDATE member_bans SET unbanned_at=?,unbanned_by=? WHERE device_id=? AND unbanned_at IS NULL').run(new Date().toISOString(),admin.admin_id,id);
    event=await realtime.record(action==='remove'?'removed':'members',id);
    return {ok:true};
  })();
  if(event)await realtime.deliver({id:event.lastInsertRowid,type:action==='remove'?'removed':'members',target:id});
  return result;
}

app.use('/api', route(async (req,res,next) => {
  res.setHeader('Cache-Control','no-store');
  if ((req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({error:'Invalid request origin.'});
  }
  req.device = (await deviceFromCookie(req.headers.cookie));
  if (!req.device) {
    const token = crypto.randomBytes(32).toString('hex');
    req.device = crypto.randomUUID();
    (await db.prepare('INSERT INTO devices (id,token_hash) VALUES (?,?)').run(req.device, hashToken(token)));
    res.cookie('innercircle-device', token, { ...cookieOptions(req), maxAge:31536000000 });
  }
  req.admin = (await auth.session(req.headers.cookie, req.device));
  next();
}));
app.use('/api', express.json({limit:'8kb'}));
const requireAccess=route(async (req,res,next) => {
  if ((await banned(req.device))) return res.status(403).json({error:'You have been removed from InnerCircle.', banned:true});
  next();
});
const requireAdmin=route(async (req,res,next) => {
  if ((await banned(req.device))) return res.status(403).json({error:'You have been removed from InnerCircle.', banned:true});
  req.admin=await auth.session(req.headers.cookie,req.device);
  if (!req.admin) return res.status(403).json({error:'Admin access required.'});
  if (req.method !== 'GET' && !equalSecret(req.get('X-CSRF-Token'), req.admin.csrf_token)) return res.status(403).json({error:'Invalid admin action token.'});
  next();
});
app.get('/api/session', route(async (req,res) => {
  const member = (await db.prepare('SELECT member_name FROM devices WHERE id=?').get(req.device));
  const removed = (await banned(req.device));
  res.json({role:req.admin && !removed ? 'admin' : 'user', name:member.member_name || '', banned:removed,
    ...(req.admin && !removed ? {csrf:req.admin.csrf_token,expiresAt:req.admin.expires_at} : {})});
}));
app.post('/api/admin/login', requireAccess, (req,res,next) => auth.login(req,res).then(async () => (await realtime.publish('members'))).catch(next));
app.post('/api/admin/logout', requireAdmin, route(async (req,res) => {
  const hash = req.admin.token_hash;
  (await db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), hash));
  res.clearCookie('innercircle-admin', cookieOptions(req));
  res.json({ok:true});
  await realtime.publish('session-ended',hash);
}));
app.get('/api/members', requireAccess, route(async (req,res) => res.json((await memberSnapshot()))));
app.get('/api/admin/members', requireAdmin, route(async (req,res) => res.json((await memberSnapshot(true)))));
app.post('/api/admin/members/:id/remove', requireAdmin, route(async (req,res) => {
  const result = (await manageMember(req.params.id, 'remove', req.admin, req.device));
  res.status(result.status || 200).json(result);
}));
app.post('/api/admin/members/:id/unban', requireAdmin, route(async (req,res) => {
  const result = (await manageMember(req.params.id, 'unban', req.admin, req.device));
  res.status(result.status || 200).json(result);
}));
app.post('/api/admin/messages/:id/delete', requireAdmin, route(async (req,res) => {
  const result = (await moderateMessage(req.params.id, req.admin));
  res.status(result.status || 200).json(result);
}));
app.get('/api/admin/messages', requireAdmin, route(async (req,res) => {
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({error:'Invalid history cursor.'});
  const rows = (await db.prepare('SELECT rowid AS cursor,* FROM messages WHERE rowid<? ORDER BY rowid DESC LIMIT 101').all(before));
  const page = rows.slice(0,100);
  res.json({messages:page.map(m => view(m,req.device,true)), nextBefore:rows.length > 100 ? page[page.length-1].cursor : null});
}));
app.get('/api/messages', requireAccess, route(async (req,res) => res.json((await recent.all(req.device)).map(m => view(m,req.device,!!req.admin)))));
app.use(express.static(path.join(__dirname,'public')));
app.get('/uploads/:filename', route(async (req,res) => {
  const device = (await deviceFromCookie(req.headers.cookie));
  if (!device || (await banned(device))) return res.sendStatus(403);
  const url = '/uploads/' + req.params.filename;
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(req.params.filename)) return res.sendStatus(404);
  const deleted = (await db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text' AND deleted_at IS NOT NULL").get(url));
  const active = (await db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text' AND deleted_at IS NULL").get(url));
  const pending = (await db.prepare('SELECT 1 FROM media_uploads WHERE url=? AND device_id=?').get(url,device));
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (deleted || (!active && !pending)) return res.sendStatus(404);
  res.setHeader('CDN-Cache-Control','no-store');res.setHeader('Vercel-CDN-Cache-Control','no-store');
  const object=await db.prepare('SELECT * FROM media_objects WHERE url=?').get(url);
  if(object)return storage.stream(req,res,object,async()=>!await banned(device) && !await db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text' AND deleted_at IS NOT NULL").get(url));
  if(process.env.VERCEL)return res.sendStatus(404);
  res.sendFile(req.params.filename,{root:uploadsDir});
}));
const allowedMedia = new Map([['image/jpeg','.jpg'],['image/png','.png'],['image/webp','.webp'],['image/gif','.gif'],['video/mp4','.mp4'],['video/webm','.webm']]);
const upload = multer({storage:multer.diskStorage({destination:uploadsDir,filename:(req,file,cb) => cb(null,crypto.randomUUID()+allowedMedia.get(file.mimetype))}),
  limits:{fileSize:20*1024*1024},fileFilter:(req,file,cb) => cb(null,allowedMedia.has(file.mimetype))});
app.post('/api/upload', requireAccess, (req,res,next)=>storage.cloud || process.env.VERCEL ? res.status(400).json({error:'Use the direct private media upload.'}) : next(), upload.single('media'), route(async (req,res) => {
  // Upload parsing is asynchronous; a ban could have occurred in the meantime.
  if ((await banned(req.device))) {
    if (req.file) fs.unlink(req.file.path,() => {});
    return res.status(403).json({error:'You have been removed from InnerCircle.',banned:true});
  }
  if (!req.file) return res.status(400).json({error:'Choose a JPG, PNG, WebP, GIF, MP4 or WebM file.'});
  const url='/uploads/'+req.file.filename, kind=req.file.mimetype.startsWith('image/') ? 'image' : 'video';
  (await db.prepare('INSERT INTO media_uploads VALUES (?,?,?)').run(url,req.device,kind));
  res.json({url,kind});
}));
app.get('/api/config',(req,res)=>res.json({mediaMode:storage.cloud?'blob':'local'}));
app.post('/api/uploads/prepare',requireAccess,route(async(req,res)=>{
  try{res.json(await storage.prepare(req.device,req.body?.contentType,req.body?.size));}catch(err){res.status(400).json({error:err.message});}
}));
app.post('/api/uploads/complete',requireAccess,route(async(req,res)=>{
  try{res.json(await storage.finish(req.body?.id,req.device));}catch(err){res.status(400).json({error:'Uploaded media could not be verified. Check your connection and retry.'});}
}));
app.post('/api/blob/upload',route(async(req,res)=>{
  if(!storage.cloud)return res.status(503).json({error:'Private media storage is not configured.'});
  try{res.json(await storage.handle(req));}catch(err){res.status(400).json({error:'Upload authorization failed.'});}
}));
app.use('/api', (req,res) => res.status(404).json({error:'API route not found. Check that the current InnerCircle server is running.'}));
app.use((err,req,res,next) => {
  // Never return database errors or account details to the client.
  if(res.headersSent || res.destroyed)return res.destroy();
  res.status(err instanceof multer.MulterError || err instanceof SyntaxError ? 400 : 500).json({error:'The request could not be completed.'});
});

// Socket middleware must forward async failures; event handlers run in order per socket.
io.use((socket,next)=>{
  (async()=>{
    await ready;
    const origin=socket.handshake.headers.origin;
    if((origin && ![`http://${socket.handshake.headers.host}`,`https://${socket.handshake.headers.host}`].includes(origin)) || socket.handshake.headers['sec-fetch-site']==='cross-site')return next(Error('Invalid origin'));
    const device=await deviceFromCookie(socket.handshake.headers.cookie);
    if(!device)return next(Error('Load chat history first'));
    if(await banned(device)){const err=Error('You have been removed from InnerCircle.');err.data={banned:true};return next(err);}
    socket.data.device=device;
    socket.data.adminHash=(await auth.session(socket.handshake.headers.cookie,device))?.token_hash || null;
    next();
  })().catch(next);
});
io.on('connection',socket=>{
  realtime.watch();
  let chain=Promise.resolve();
  function on(event,action){socket.on(event,(...args)=>{
    chain=chain.then(()=>action(...args)).catch(()=>{
      const ack=args[args.length-1];if(typeof ack==='function')ack({error:'The request could not be completed. Please reconnect and retry.'});
      else socket.emit('chat-error',{message:'Message could not be sent. Please reconnect and retry.'});
    });
  });}
  async function adminAction(payload,ack,action){
    const reply=typeof ack==='function'?ack:()=>{};
    const admin=await socketAdmin(socket);
    if(!await allowed(socket) || !admin)return reply({error:'Admin access required.'});
    if(!equalSecret(payload?.csrf,admin.csrf_token))return reply({error:'Invalid admin action token.'});
    reply(await action(admin));
  }
  on('join',async(name,ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    if(await banned(socket.data.device))return reply({error:'You have been removed from InnerCircle.',banned:true});
    const admin=await socketAdmin(socket);if(admin)name=admin.username;
    if(typeof name!=='string' || !name.trim() || name.trim().length>30)return reply({error:'Enter a name of 1–30 characters.'});
    name=name.trim();
    await db.transaction(async()=>{
      if(await banned(socket.data.device))throw Error('Access removed');
      await db.prepare('UPDATE devices SET member_name=?,joined_at=COALESCE(joined_at,?) WHERE id=?').run(name,new Date().toISOString(),socket.data.device);
      await db.prepare('INSERT INTO presence (connection_id,device_id,expires_at) VALUES (?,?,?) ON CONFLICT(connection_id) DO UPDATE SET expires_at=excluded.expires_at').run(socket.id,socket.data.device,Date.now()+60000);
    })();
    online.set(socket.id,name);socket.data.joined=true;
    await realtime.publish('members');
    reply({ok:true,role:admin?'admin':'user'});
  });
  on('chat-message',async(payload,ack)=>{
    if(!await allowed(socket) || !payload || typeof payload.body!=='string' || !['text','image','video'].includes(payload.kind))return;
    const body=payload.body.trim();if(!body || body.length>2000)return;
    if(payload.kind!=='text' && !/^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(body))return;
    const message={id:crypto.randomUUID(),sender:online.get(socket.id),kind:payload.kind,body,created_at:new Date().toISOString(),owner_id:socket.data.device};
    const event=await db.transaction(async()=>{
      if(await banned(socket.data.device))return null;
      if(payload.kind!=='text' && (!await db.prepare('SELECT 1 FROM media_uploads WHERE url=? AND device_id=? AND kind=?').get(body,socket.data.device,payload.kind) || await db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text'").get(body)))return null;
      await insert.run(message);return realtime.record('message',message.id);
    })();
    if(!event)return;
    await realtime.deliver({id:event.lastInsertRowid,type:'message',target:message.id});
    if(typeof ack==='function')ack({ok:true,id:message.id});
  });
  on('delete-message',async(payload,ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    if(!await allowed(socket) || !payload || typeof payload.id!=='string' || payload.id.length>100 || !['me','everyone'].includes(payload.scope))return reply({error:'Invalid deletion request.'});
    const admin=await socketAdmin(socket);
    if(payload.scope==='everyone' && admin){
      if(!equalSecret(payload.csrf,admin.csrf_token))return reply({error:'Invalid admin action token.'});
      return reply(await moderateMessage(payload.id,admin));
    }
    let event;
    const result=await db.transaction(async()=>{
      if(await banned(socket.data.device))return {error:'Access removed.'};
      const m=await db.prepare('SELECT * FROM messages WHERE id=?').get(payload.id);
      if(!m)return {error:'Message not found.'};
      if(payload.scope==='me'){
        await db.prepare('INSERT OR IGNORE INTO message_hidden VALUES (?,?)').run(m.id,socket.data.device);event=await realtime.record('hidden',m.id);
      }else{
        if(m.owner_id!==socket.data.device)return {error:'You can only delete messages sent from this device.'};
        if(!m.deleted_at){await db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(),m.id);event=await realtime.record('deleted',m.id);}
      }
      return {ok:true};
    })();
    if(event)await realtime.deliver({id:event.lastInsertRowid,type:payload.scope==='me'?'hidden':'deleted',target:payload.id});
    reply(result);
  });
  on('admin-delete-message',(payload,ack)=>adminAction(payload,ack,admin=>moderateMessage(payload.id,admin)));
  on('admin-remove-member',(payload,ack)=>adminAction(payload,ack,admin=>manageMember(payload.id,'remove',admin,socket.data.device)));
  on('admin-unban-member',(payload,ack)=>adminAction(payload,ack,admin=>manageMember(payload.id,'unban',admin,socket.data.device)));
  on('disconnect',async()=>{
    online.delete(socket.id);socket.data.joined=false;
    await db.prepare('DELETE FROM presence WHERE connection_id=?').run(socket.id);
    await realtime.publish('members');
  });
});
const ready=(async()=>{
  if(process.env.VERCEL && !storage.cloud)throw Error('Configure a private Blob store with BLOB_READ_WRITE_TOKEN before deployment.');
  await migrate(db);await auth.initialize();await realtime.start();
})();
module.exports=server;
if(!process.env.VERCEL && require.main===module){
  ready.then(()=>server.listen(PORT,'0.0.0.0',()=>console.log(`InnerCircle running at http://localhost:${server.address().port}`)))
    .catch(err=>{console.error(err.message);db.close();process.exitCode=1;});
}else ready.catch(()=>console.error('InnerCircle storage initialization failed. Check server environment configuration.'));
