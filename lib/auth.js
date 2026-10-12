const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const SCRYPT_OPTIONS = { N:32768, r:8, p:1, maxmem:64 * 1024 * 1024 };

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function tokenFromCookie(cookie = '', name) {
  const token = cookie.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function cookieOptions(req) {
  return { httpOnly:true, sameSite:'strict', secure:req.secure || process.env.NODE_ENV === 'production', path:'/' };
}

function createAdminAuth(db) {
  let dummy;
  let verifying = 0;
  const lookup = db.prepare(`SELECT s.*, a.username FROM admin_sessions s JOIN admin_accounts a ON a.id=s.admin_id
    WHERE s.token_hash=? AND s.device_id=? AND s.role='admin' AND s.revoked_at IS NULL AND s.expires_at>?`);
  async function byHash(hash, device) {
    return hash ? (await lookup.get(hash, device, Date.now())) || null : null;
  }
  async function session(cookie, device) {
    const token = tokenFromCookie(cookie, 'innercircle-admin');
    return token ? (await byHash(hashToken(token), device)) : null;
  }
  async function initialize() {
    const username = process.env.INNERCIRCLE_ADMIN_USERNAME;
    const password = process.env.INNERCIRCLE_ADMIN_PASSWORD;
    if (!(await db.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get())) {
      if (username || password) {
        if (!username?.trim() || username.trim().length > 30 || !password || password.length < 12 || password.length > 256) {
          throw Error('Initial admin setup requires INNERCIRCLE_ADMIN_USERNAME (1–30 characters) and INNERCIRCLE_ADMIN_PASSWORD (12–256 characters).');
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = (await scrypt(password, salt, 64, SCRYPT_OPTIONS)).toString('hex');
        await db.prepare(`INSERT INTO admin_accounts (id,username,password_salt,password_hash,created_at)
          SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_accounts)`)
          .run(crypto.randomUUID(), username.trim(), salt, hash, new Date().toISOString());
        console.log('Initial admin account created. Remove the bootstrap password from the environment after setup.');
      } else console.log('Admin login disabled until initial admin environment variables are configured.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    dummy = { password_salt:salt, password_hash:(await scrypt(crypto.randomBytes(32), salt, 64, SCRYPT_OPTIONS)).toString('hex') };
  }
  async function login(req, res) {
    if (process.env.NODE_ENV === 'production' && !req.secure) return res.status(400).json({error:'HTTPS is required for admin login.'});
    if (!req.is('application/json')) return res.status(415).json({error:'Send a JSON login request.'});
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 30 || typeof password !== 'string' || !password || password.length > 256) {
      return res.status(400).json({error:'Enter a valid admin username and password.'});
    }
    if (!(await db.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get())) return res.status(503).json({error:'Admin login has not been configured.'});
    const now = Date.now();
    const attempt = await db.transaction(async()=>{
      await db.prepare('DELETE FROM admin_login_attempts WHERE window_started<?').run(now-WINDOW_MS);
      return db.prepare(`INSERT INTO admin_login_attempts (address,window_started,attempts) VALUES (?,?,1)
        ON CONFLICT(address) DO UPDATE SET attempts=attempts+1 RETURNING attempts,window_started`).get(req.ip,now);
    })();
    if (attempt.attempts > 5 || verifying >= 4) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(((attempt?.window_started || now) + WINDOW_MS - now) / 1000)));
      return res.status(429).json({error:'Too many login attempts. Please try again later.'});
    }
    const account = (await db.prepare('SELECT * FROM admin_accounts WHERE username=?').get(username.trim()));
    const check = account || dummy;
    verifying++;
    let valid;
    try {
      const hash = (await scrypt(password, check.password_salt, 64, SCRYPT_OPTIONS)).toString('hex');
      valid = equalSecret(hash, check.password_hash) && !!account;
    } finally { verifying--; }
    if (!valid) return res.status(401).json({error:'Invalid admin username or password.'});
    // Recheck after asynchronous password hashing: a concurrent ban must win.
    if ((await db.prepare('SELECT 1 FROM member_bans WHERE device_id=? AND unbanned_at IS NULL').get(req.device))) {
      return res.status(403).json({error:'You have been removed from InnerCircle.', banned:true});
    }
    (await db.prepare('DELETE FROM admin_login_attempts WHERE address=?').run(req.ip));
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    const permitted=await db.transaction(async () => {
      if(await db.prepare('SELECT 1 FROM member_bans WHERE device_id=? AND unbanned_at IS NULL').get(req.device))return false;
      (await db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(now, req.device));
      (await db.prepare(`INSERT INTO admin_sessions (token_hash,device_id,admin_id,role,csrf_token,created_at,expires_at)
        VALUES (?,?,?,'admin',?,?,?)`).run(hashToken(token), req.device, account.id, csrf, now, now + SESSION_MS));
      return true;
    })();
    if(!permitted)return res.status(403).json({error:'You have been removed from InnerCircle.',banned:true});
    (await db.prepare('UPDATE devices SET member_name=?, joined_at=COALESCE(joined_at,?) WHERE id=?')
      .run(account.username, new Date().toISOString(), req.device));
    res.cookie('innercircle-admin', token, { ...cookieOptions(req), maxAge:SESSION_MS });
    res.json({ role:'admin', name:account.username, csrf, expiresAt:now + SESSION_MS });
  }
  return { initialize, login, session, byHash };
}

module.exports = { createAdminAuth, hashToken, tokenFromCookie, equalSecret, cookieOptions };
