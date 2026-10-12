const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createAdminAuth, hashToken, tokenFromCookie, equalSecret, cookieOptions } = require('./lib/auth');
const app = express();
app.disable('x-powered-by');
// Trust only the proxy addresses/hops explicitly configured by the operator.
if (process.env.INNERCIRCLE_TRUST_PROXY) {
  const proxy = process.env.INNERCIRCLE_TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(proxy) ? Number(proxy) : proxy);
}
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize:1e6 });
const PORT = process.env.PORT || 3000;
const dataDir = process.env.INNERCIRCLE_DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = process.env.INNERCIRCLE_UPLOADS_DIR || path.join(__dirname, 'uploads');
for (const dir of [dataDir, uploadsDir]) fs.mkdirSync(dir, { recursive:true });
const db = new Database(path.join(dataDir, 'innercircle.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
db.transaction(() => {
  const columns = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  for (const [name,type] of [['owner_id','TEXT'],['deleted_at','TEXT'],['deleted_by_admin','TEXT']]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS message_hidden (message_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY(message_id, device_id));
    CREATE TABLE IF NOT EXISTS media_uploads (url TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_body ON messages(body);
    CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, admin_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role='admin'), csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS admin_sessions_device ON admin_sessions(device_id, expires_at);
    CREATE TABLE IF NOT EXISTS member_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
      banned_at TEXT NOT NULL, banned_by TEXT NOT NULL, unbanned_at TEXT, unbanned_by TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_member_ban ON member_bans(device_id) WHERE unbanned_at IS NULL;
    CREATE TABLE IF NOT EXISTS message_moderation (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL,
      admin_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action='delete'), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_login_attempts (address TEXT PRIMARY KEY, window_started INTEGER NOT NULL, attempts INTEGER NOT NULL);`);
  const deviceColumns = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (!deviceColumns.includes('member_name')) db.exec('ALTER TABLE devices ADD COLUMN member_name TEXT');
  if (!deviceColumns.includes('joined_at')) db.exec('ALTER TABLE devices ADD COLUMN joined_at TEXT');
  // Recover only device identities already recorded by the previous deletion feature.
  db.exec(`UPDATE devices SET member_name=(SELECT sender FROM messages WHERE owner_id=devices.id ORDER BY created_at DESC LIMIT 1),
    joined_at=(SELECT MIN(created_at) FROM messages WHERE owner_id=devices.id)
    WHERE member_name IS NULL AND EXISTS(SELECT 1 FROM messages WHERE owner_id=devices.id);`);
})();
const auth = createAdminAuth(db);
const online = new Map();
const insert = db.prepare('INSERT INTO messages (id,sender,kind,body,created_at,owner_id) VALUES (@id,@sender,@kind,@body,@created_at,@owner_id)');
const recent = db.prepare(`SELECT * FROM (SELECT m.* FROM messages m WHERE NOT EXISTS
  (SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.device_id=?) ORDER BY created_at DESC, rowid DESC LIMIT 100) ORDER BY created_at ASC`);
function deviceFromCookie(cookie = '') {
  const token = tokenFromCookie(cookie, 'innercircle-device');
  return token ? db.prepare('SELECT id FROM devices WHERE token_hash=?').get(hashToken(token))?.id : null;
}
function banned(device) {
  return !!db.prepare('SELECT 1 FROM member_bans WHERE device_id=? AND unbanned_at IS NULL').get(device);
}
function socketAdmin(socket) { return auth.byHash(socket.data.adminHash, socket.data.device); }
function allowed(socket) { return online.has(socket.id) && !banned(socket.data.device); }
function deletedText(m) { return m.deleted_by_admin ? 'This message was deleted by admin.' : 'This message was deleted.'; }
function view(m, device, admin = false) {
  return { id:m.id, sender:m.sender, kind:m.deleted_at ? 'text' : m.kind,
    body:m.deleted_at ? deletedText(m) : m.body, created_at:m.created_at,
    deleted:!!m.deleted_at, deletedByAdmin:!!m.deleted_by_admin, mine:m.owner_id === device,
    canDeleteEveryone:!m.deleted_at && (admin || m.owner_id === device) };
}
function memberSnapshot(includeBanned = false) {
  const onlineDevices = new Set([...online.keys()].map(id => io.sockets.sockets.get(id)?.data.device).filter(Boolean));
  const adminDevices = new Set(db.prepare('SELECT DISTINCT device_id FROM admin_sessions WHERE revoked_at IS NULL AND expires_at>?').all(Date.now()).map(r => r.device_id));
  const members = db.prepare(`SELECT d.id,d.member_name AS name,b.banned_at FROM devices d LEFT JOIN member_bans b
    ON b.device_id=d.id AND b.unbanned_at IS NULL WHERE d.member_name IS NOT NULL ORDER BY d.joined_at,d.id`).all()
    .filter(m => includeBanned || !m.banned_at)
    .map(m => ({ id:m.id, name:m.name, online:onlineDevices.has(m.id) && !m.banned_at,
      role:adminDevices.has(m.id) && !m.banned_at ? 'admin' : 'user', ...(includeBanned ? {banned:!!m.banned_at,bannedAt:m.banned_at} : {}) }));
  return { members, total:members.filter(m => !m.banned).length, online:members.filter(m => m.online).length,
    ...(includeBanned ? { banned:members.filter(m => m.banned).length } : {}) };
}
function broadcastMembers() {
  const publicList = memberSnapshot(), adminList = memberSnapshot(true);
  for (const client of io.sockets.sockets.values()) {
    if (!allowed(client)) continue;
    client.emit('online-count', publicList.online);
    client.emit('members-updated', publicList);
    if (socketAdmin(client)) client.emit('admin-members-updated', adminList);
  }
}
function broadcastDeletion(m) {
  for (const client of io.sockets.sockets.values()) if (allowed(client)) {
    client.emit('message-deleted', {id:m.id,byAdmin:!!m.deleted_by_admin});
  }
}
function moderateMessage(id, admin) {
  if (typeof id !== 'string' || id.length > 100) return {error:'Invalid message ID.', status:400};
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  if (!m) return {error:'Message not found.', status:404};
  if (!m.deleted_at) {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE messages SET deleted_at=?,deleted_by_admin=? WHERE id=?').run(now, admin.admin_id, m.id);
      db.prepare("INSERT INTO message_moderation (message_id,admin_id,action,created_at) VALUES (?,?,'delete',?)").run(m.id, admin.admin_id, now);
    })();
    broadcastDeletion({...m,deleted_by_admin:admin.admin_id});
  }
  return {ok:true};
}
function manageMember(id, action, admin, actorDevice) {
  if (typeof id !== 'string' || id.length > 100) return {error:'Invalid member ID.', status:400};
  const member = db.prepare('SELECT id FROM devices WHERE id=? AND member_name IS NOT NULL').get(id);
  if (!member) return {error:'Member not found.', status:404};
  if (action === 'remove') {
    if (id === actorDevice || db.prepare('SELECT 1 FROM admin_sessions WHERE device_id=? AND revoked_at IS NULL AND expires_at>?').get(id, Date.now())) {
      return {error:'An active admin cannot be removed. Log out that admin first.', status:409};
    }
    if (!banned(id)) db.transaction(() => {
      db.prepare('INSERT INTO member_bans (device_id,banned_at,banned_by) VALUES (?,?,?)').run(id, new Date().toISOString(), admin.admin_id);
      db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(Date.now(), id);
    })();
    for (const client of io.sockets.sockets.values()) if (client.data.device === id) {
      online.delete(client.id);
      client.emit('member-removed', {message:'You have been removed from InnerCircle.'});
      client.disconnect(true);
    }
  } else {
    db.prepare('UPDATE member_bans SET unbanned_at=?,unbanned_by=? WHERE device_id=? AND unbanned_at IS NULL')
      .run(new Date().toISOString(), admin.admin_id, id);
  }
  broadcastMembers();
  return {ok:true};
}

app.use('/api', (req,res,next) => {
  res.setHeader('Cache-Control','no-store');
  if ((req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({error:'Invalid request origin.'});
  }
  req.device = deviceFromCookie(req.headers.cookie);
  if (!req.device) {
    const token = crypto.randomBytes(32).toString('hex');
    req.device = crypto.randomUUID();
    db.prepare('INSERT INTO devices (id,token_hash) VALUES (?,?)').run(req.device, hashToken(token));
    res.cookie('innercircle-device', token, { ...cookieOptions(req), maxAge:31536000000 });
  }
  req.admin = auth.session(req.headers.cookie, req.device);
  next();
});
app.use('/api', express.json({limit:'8kb'}));
function requireAccess(req,res,next) {
  if (banned(req.device)) return res.status(403).json({error:'You have been removed from InnerCircle.', banned:true});
  next();
}
function requireAdmin(req,res,next) {
  if (banned(req.device)) return res.status(403).json({error:'You have been removed from InnerCircle.', banned:true});
  if (!req.admin) return res.status(403).json({error:'Admin access required.'});
  if (req.method !== 'GET' && !equalSecret(req.get('X-CSRF-Token'), req.admin.csrf_token)) return res.status(403).json({error:'Invalid admin action token.'});
  next();
}
app.get('/api/session', (req,res) => {
  const member = db.prepare('SELECT member_name FROM devices WHERE id=?').get(req.device);
  const removed = banned(req.device);
  res.json({role:req.admin && !removed ? 'admin' : 'user', name:member.member_name || '', banned:removed,
    ...(req.admin && !removed ? {csrf:req.admin.csrf_token,expiresAt:req.admin.expires_at} : {})});
});
app.post('/api/admin/login', requireAccess, (req,res,next) => auth.login(req,res).then(() => broadcastMembers()).catch(next));
app.post('/api/admin/logout', requireAdmin, (req,res) => {
  const hash = req.admin.token_hash;
  db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), hash);
  res.clearCookie('innercircle-admin', cookieOptions(req));
  res.json({ok:true});
  for (const client of io.sockets.sockets.values()) if (client.data.adminHash === hash) {
    client.emit('admin-session-ended', {message:'You have logged out as admin.'});
    client.disconnect(true);
  }
  broadcastMembers();
});
app.get('/api/members', requireAccess, (req,res) => res.json(memberSnapshot()));
app.get('/api/admin/members', requireAdmin, (req,res) => res.json(memberSnapshot(true)));
app.post('/api/admin/members/:id/remove', requireAdmin, (req,res) => {
  const result = manageMember(req.params.id, 'remove', req.admin, req.device);
  res.status(result.status || 200).json(result);
});
app.post('/api/admin/members/:id/unban', requireAdmin, (req,res) => {
  const result = manageMember(req.params.id, 'unban', req.admin, req.device);
  res.status(result.status || 200).json(result);
});
app.post('/api/admin/messages/:id/delete', requireAdmin, (req,res) => {
  const result = moderateMessage(req.params.id, req.admin);
  res.status(result.status || 200).json(result);
});
app.get('/api/admin/messages', requireAdmin, (req,res) => {
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({error:'Invalid history cursor.'});
  const rows = db.prepare('SELECT rowid AS cursor,* FROM messages WHERE rowid<? ORDER BY rowid DESC LIMIT 101').all(before);
  const page = rows.slice(0,100);
  res.json({messages:page.map(m => view(m,req.device,true)), nextBefore:rows.length > 100 ? page[page.length-1].cursor : null});
});
app.get('/api/messages', requireAccess, (req,res) => res.json(recent.all(req.device).map(m => view(m,req.device,!!req.admin))));
app.use(express.static(path.join(__dirname,'public')));
app.get('/uploads/:filename', (req,res) => {
  const device = deviceFromCookie(req.headers.cookie);
  if (!device || banned(device)) return res.sendStatus(403);
  const url = '/uploads/' + req.params.filename;
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(req.params.filename)) return res.sendStatus(404);
  const deleted = db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text' AND deleted_at IS NOT NULL").get(url);
  const active = db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text' AND deleted_at IS NULL").get(url);
  const pending = db.prepare('SELECT 1 FROM media_uploads WHERE url=? AND device_id=?').get(url,device);
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (deleted || (!active && !pending)) return res.sendStatus(404);
  res.sendFile(req.params.filename,{root:uploadsDir});
});
const allowedMedia = new Map([['image/jpeg','.jpg'],['image/png','.png'],['image/webp','.webp'],['image/gif','.gif'],['video/mp4','.mp4'],['video/webm','.webm']]);
const upload = multer({storage:multer.diskStorage({destination:uploadsDir,filename:(req,file,cb) => cb(null,crypto.randomUUID()+allowedMedia.get(file.mimetype))}),
  limits:{fileSize:20*1024*1024},fileFilter:(req,file,cb) => cb(null,allowedMedia.has(file.mimetype))});
app.post('/api/upload', requireAccess, upload.single('media'), (req,res) => {
  // Upload parsing is asynchronous; a ban could have occurred in the meantime.
  if (banned(req.device)) {
    if (req.file) fs.unlink(req.file.path,() => {});
    return res.status(403).json({error:'You have been removed from InnerCircle.',banned:true});
  }
  if (!req.file) return res.status(400).json({error:'Choose a JPG, PNG, WebP, GIF, MP4 or WebM file.'});
  const url='/uploads/'+req.file.filename, kind=req.file.mimetype.startsWith('image/') ? 'image' : 'video';
  db.prepare('INSERT INTO media_uploads VALUES (?,?,?)').run(url,req.device,kind);
  res.json({url,kind});
});
app.use('/api', (req,res) => res.status(404).json({error:'API route not found. Check that the current InnerCircle server is running.'}));
app.use((err,req,res,next) => {
  // Never return database errors or account details to the client.
  res.status(err instanceof multer.MulterError || err instanceof SyntaxError ? 400 : 500).json({error:'The request could not be completed.'});
});

io.use((socket,next) => {
  const origin = socket.handshake.headers.origin;
  if ((origin && ![`http://${socket.handshake.headers.host}`,`https://${socket.handshake.headers.host}`].includes(origin)) || socket.handshake.headers['sec-fetch-site'] === 'cross-site') return next(Error('Invalid origin'));
  const device = deviceFromCookie(socket.handshake.headers.cookie);
  if (!device) return next(Error('Load chat history first'));
  if (banned(device)) { const err=Error('You have been removed from InnerCircle.');err.data={banned:true};return next(err); }
  socket.data.device=device;
  const admin = auth.session(socket.handshake.headers.cookie,device);
  socket.data.adminHash=admin?.token_hash || null;
  socket.join('device:'+device);
  next();
});
io.on('connection', socket => {
  function adminAction(payload, ack, action) {
    const reply=typeof ack === 'function' ? ack : () => {};
    const admin=socketAdmin(socket);
    if (!allowed(socket) || !admin) return reply({error:'Admin access required.'});
    if (!equalSecret(payload?.csrf,admin.csrf_token)) return reply({error:'Invalid admin action token.'});
    reply(action(admin));
  }
  socket.on('join',(name,ack) => {
    const reply=typeof ack === 'function' ? ack : () => {};
    if (banned(socket.data.device)) return reply({error:'You have been removed from InnerCircle.',banned:true});
    const admin=socketAdmin(socket);
    if (admin) name=admin.username;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) return reply({error:'Enter a name of 1–30 characters.'});
    name=name.trim();
    db.prepare('UPDATE devices SET member_name=?,joined_at=COALESCE(joined_at,?) WHERE id=?').run(name,new Date().toISOString(),socket.data.device);
    online.set(socket.id,name);
    broadcastMembers();
    reply({ok:true,role:admin ? 'admin' : 'user'});
  });
  socket.on('chat-message',payload => {
    const sender=online.get(socket.id);
    if (!allowed(socket) || !payload || typeof payload.body !== 'string' || !['text','image','video'].includes(payload.kind)) return;
    const body=payload.body.trim();
    if (!body || body.length > 2000) return;
    if (payload.kind !== 'text' && !/^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(body)) return;
    if (payload.kind !== 'text' && (!db.prepare('SELECT 1 FROM media_uploads WHERE url=? AND device_id=? AND kind=?').get(body,socket.data.device,payload.kind)
      || db.prepare("SELECT 1 FROM messages WHERE body=? AND kind!='text'").get(body))) return;
    const message={id:crypto.randomUUID(),sender,kind:payload.kind,body,created_at:new Date().toISOString(),owner_id:socket.data.device};
    insert.run(message);
    for (const client of io.sockets.sockets.values()) if (allowed(client)) client.emit('chat-message',view(message,client.data.device,!!socketAdmin(client)));
  });
  socket.on('delete-message',(payload,ack) => {
    const reply=typeof ack === 'function' ? ack : () => {};
    if (!allowed(socket) || !payload || typeof payload.id !== 'string' || payload.id.length > 100 || !['me','everyone'].includes(payload.scope)) return reply({error:'Invalid deletion request.'});
    const m=db.prepare('SELECT * FROM messages WHERE id=?').get(payload.id);
    if (!m) return reply({error:'Message not found.'});
    if (payload.scope === 'me') {
      db.prepare('INSERT OR IGNORE INTO message_hidden VALUES (?,?)').run(m.id,socket.data.device);
      io.to('device:'+socket.data.device).emit('message-hidden',{id:m.id});
    } else {
      const admin=socketAdmin(socket);
      if (admin) {
        if (!equalSecret(payload.csrf,admin.csrf_token)) return reply({error:'Invalid admin action token.'});
        return reply(moderateMessage(m.id,admin));
      }
      if (m.owner_id !== socket.data.device) return reply({error:'You can only delete messages sent from this device.'});
      if (!m.deleted_at) {
        db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(),m.id);
        broadcastDeletion(m);
      }
    }
    reply({ok:true});
  });
  socket.on('admin-delete-message',(payload,ack) => adminAction(payload,ack,admin => moderateMessage(payload.id,admin)));
  socket.on('admin-remove-member',(payload,ack) => adminAction(payload,ack,admin => manageMember(payload.id,'remove',admin,socket.data.device)));
  socket.on('admin-unban-member',(payload,ack) => adminAction(payload,ack,admin => manageMember(payload.id,'unban',admin,socket.data.device)));
  socket.on('disconnect',() => {online.delete(socket.id);broadcastMembers();});
});
// Connected sockets must not retain privileges beyond session expiry.
setInterval(() => {
  for (const socket of io.sockets.sockets.values()) if (socket.data.adminHash && !socketAdmin(socket)) {
    socket.emit('admin-session-ended',{message:'Your admin session has expired. Please log in again.'});
    socket.disconnect(true);
  }
},30000).unref();
auth.initialize().then(() => {
  server.listen(PORT,'0.0.0.0',() => console.log(`InnerCircle running at http://localhost:${server.address().port}`));
}).catch(err => {console.error(err.message);db.close();process.exitCode=1;});
