async function migrate(db){
await db.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
await db.transaction(async () => {
  const columns = (await db.prepare('PRAGMA table_info(messages)').all()).map(c => c.name);
  for (const [name,type] of [['owner_id','TEXT'],['deleted_at','TEXT'],['deleted_by_admin','TEXT']]) {
    if (!columns.includes(name)) await db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }
  await db.exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL);
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
  const deviceColumns = (await db.prepare('PRAGMA table_info(devices)').all()).map(c => c.name);
  if (!deviceColumns.includes('member_name')) await db.exec('ALTER TABLE devices ADD COLUMN member_name TEXT');
  if (!deviceColumns.includes('joined_at')) await db.exec('ALTER TABLE devices ADD COLUMN joined_at TEXT');
  // Recover only device identities already recorded by the previous deletion feature.
  await db.exec(`UPDATE devices SET member_name=(SELECT sender FROM messages WHERE owner_id=devices.id ORDER BY created_at DESC LIMIT 1),
    joined_at=(SELECT MIN(created_at) FROM messages WHERE owner_id=devices.id)
    WHERE member_name IS NULL AND EXISTS(SELECT 1 FROM messages WHERE owner_id=devices.id);`);
})();

await db.exec(`CREATE TABLE IF NOT EXISTS realtime_events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, target TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presence (connection_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS presence_expiry ON presence(expires_at);
CREATE TABLE IF NOT EXISTS media_objects (url TEXT PRIMARY KEY, pathname TEXT UNIQUE NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT);
CREATE TABLE IF NOT EXISTS upload_tickets (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, url TEXT UNIQUE NOT NULL, pathname TEXT UNIQUE NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER);`);
}
module.exports={migrate};
