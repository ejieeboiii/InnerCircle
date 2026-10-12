# InnerCircle

A mobile-first group chat using HTML, CSS, JavaScript, Express, Socket.IO, and SQLite. Regular users enter a display name; admins sign in with a password. No regular-user registration is required.

## Run

## Android APK

Download and share the Android app from [the InnerCircle download page](https://inner-circle-one-woad.vercel.app/download.html). Android 8.0 or newer and internet access are required. Open the downloaded APK, allow installation from that browser if Android asks, and tap Install. The app uses a separate device identity from Chrome; enter your name again on first launch.

The Android source and signed release build instructions are in [android/README.md](android/README.md). Signing credentials are kept outside Git and in encrypted repository secrets. The published APK is universal across device CPU architectures. Native background push notifications are not included.

## Run locally

Use Node.js 22 or 24 and npm:

```powershell
npm install
npm start
```

Open http://localhost:3000. On the same Wi-Fi, use http://YOUR_COMPUTER_LAN_IP:3000 on another phone, allowing port 3000 through the firewall. Use persistent storage and HTTPS for a hosted deployment. Restart the server and reload existing browser tabs after upgrading.

## Vercel deployment

See [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md) for Turso, private Blob storage, existing-history migration, and deployment checks. Cloud credentials are required; local files are not persistent storage on Vercel.

## Initial admin setup

On the first startup with no admin account, supply these environment variables. There are no default credentials, and the app does not automatically load a `.env` file.

```powershell
$env:INNERCIRCLE_ADMIN_USERNAME = 'your-admin-name'
$initialAdminSecret = Read-Host 'Choose an admin password of at least 12 characters' -AsSecureString
$initialAdminCredential = [pscredential]::new($env:INNERCIRCLE_ADMIN_USERNAME, $initialAdminSecret)
$env:INNERCIRCLE_ADMIN_PASSWORD = $initialAdminCredential.GetNetworkCredential().Password
npm start
```

Usernames must be 1–30 characters; initial passwords must be 12–256 characters. After the account has been created, stop the server, remove the bootstrap variables from your process/deployment settings, and start it again:

```powershell
Remove-Item Env:INNERCIRCLE_ADMIN_PASSWORD
Remove-Item Env:INNERCIRCLE_ADMIN_USERNAME
$initialAdminSecret = $null
$initialAdminCredential = $null
npm start
```

The account and password hash remain in SQLite. Changing the bootstrap variables does not overwrite an existing account. If neither variable is set and no account exists, regular chat still works and admin login is disabled. Do not commit credentials, store them in browser localStorage, or expose the database publicly. No password-reset UI is included.

Click **Login as Admin** on the welcome page, or **Admin** in the chat header. Admin login opens the dashboard; **Group chat** lets the admin participate. **Logout** revokes the current session on the server and disconnects sockets using it. Reloading after logout can resume normal name-only chat, without admin privileges.

## Members and moderation

Regular users can open **Members** to see active group members and their online/offline status. Online counts represent distinct browser/device identities, so multiple tabs using one credential count once. Different browsers can use the same display name; the admin dashboard shows a short device identifier to distinguish them. Names remain editable and do not determine privileges.

The dashboard displays active member totals, online totals, and removed totals. **Remove User** opens the confirmation “Are you sure you want to remove this user from InnerCircle?” Confirming records a persistent ban, notifies the affected device, and immediately disconnects every socket using it. The same device is denied history, member lists, uploads, media, login, and reconnects. Public member lists omit removed devices; the admin list retains them with **Unban User**. After unbanning, the member can use **Check access again** or reload to rejoin. History and member records are preserved. Active admins cannot remove themselves or another active admin; that admin must log out first.

The **Messages** tab provides all group history, including messages hidden through a personal Delete for Me preference, with **Load older messages** pagination. Use ⋮ → **Delete** → **Delete for Everyone** to moderate any undeleted message, including legacy messages. The server records the admin action and broadcasts **This message was deleted by admin.** Deleted media URLs return 404. Group chat continues updating while the dashboard is open.

## Existing deletion and chat features

Text, image/video uploads up to 20 MB, purple message bubbles, notifications, offline history caching, and reconnect history refresh remain available. Open a message's ⋮ menu and choose **Delete**:

- **Delete for Me** persists a visibility preference for the requesting browser identity; other members still see the message. Tabs sharing that identity update together. It can also hide deleted placeholders. This does not revoke access to a shared media URL.
- **Delete for Everyone** lets regular users delete only messages sent by their own device credential after device ownership was introduced. The server validates ownership and broadcasts **This message was deleted.** Legacy messages without verified ownership support personal hiding and admin moderation.
- Admin moderation can delete any message for everyone. Personal chat hiding still works for admins, but the moderation view deliberately includes hidden records.

Shared deletion is a soft deletion. Original database content and files remain stored, while app history replaces deleted content with its placeholder and media endpoints deny new requests, including range requests. Do not serve the uploads directory through a separate static server or CDN that bypasses these checks.

## Authentication and deployment

Admin passwords use a per-account random 16-byte salt and a 64-byte hash produced by Node's built-in [crypto.scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), with N=32768, r=8, p=1. Password checks use a timing-safe comparison. Password hashes, salts, session token hashes, and moderation actor account IDs are not exposed through public APIs.

Both device credentials and admin session tokens are random 256-bit values in HttpOnly, SameSite=Strict cookies; SQLite stores hashes of the bearer tokens. Admin sessions expire after eight hours and are bound to the device credential. Logging in again rotates the admin session for that device. Admin permissions are rechecked on every protected HTTP request and Socket.IO action; expired sockets are disconnected during the periodic access check (normally within 20 seconds), and expiration blocks privileged actions immediately. Admin action CSRF tokens live only in page memory. JSON-only login, request-origin checks, CSRF validation, and a persistent five-attempt/15-minute per-IP login limit help protect login and management actions.

Production requires HTTPS. Set `NODE_ENV=production`; the app refuses admin login over plain HTTP and sets Secure cookies. For a TLS-terminating reverse proxy, set `INNERCIRCLE_TRUST_PROXY` to the specific trusted proxy IP/subnet (for example `loopback` only for a proxy on the same host), preserve the original Host header, overwrite forwarded headers correctly, set X-Forwarded-Proto, and forward WebSocket upgrades. Express explains how [trusted proxies affect request IP and protocol](https://expressjs.com/en/guide/behind-proxies/). Development on localhost uses HTTP cookies for local testing. Do not expose that HTTP setup to the internet.

Regular users have device credentials rather than authenticated accounts. A ban prevents reuse of the same credential, but a user can bypass it by clearing cookies/local data, using a different browser/device, or changing the app hostname. There is no reliable person-level ban without regular-user authentication. Anyone with access to a browser profile or stolen credentials can act as that device; display names can still be impersonated. Regular device cookies last one year, and there is no identity recovery after cookie loss.

This remains an open group, not a private authenticated messenger. Upload validation still relies on declared MIME types and extensions, rather than file signatures. There is no encryption at rest or general chat/upload rate limiting. Browser notifications require support/permission and usually HTTPS, and are best-effort while the app is running.

Removal/deletion cannot erase screenshots, previously downloaded files, already delivered responses, old media caches, or backups. Offline history may be stale until reconnection. On a known removal, the client clears its chat cache and hides the composer. Separate offline copies cannot be remotely erased.

## Database migrations

Startup applies additive, idempotent SQLite migrations. Back up `data` and `uploads` before upgrading. Existing message IDs, names, kinds, bodies, timestamps, device credentials, personal deletion preferences, and upload records are preserved.

- `messages`: retains `owner_id` and `deleted_at`, and adds nullable `deleted_by_admin` for admin placeholders.
- `devices`: existing persistent regular-user sessions retain their `id` and `token_hash`; `member_name` and `joined_at` are added for membership. Prior device-owned messages can recover that device's name. Older messages with only display names cannot establish a device identity and remain unclaimed; those users become members when they next join.
- `message_hidden` and `media_uploads`: remain compatible with the deletion feature.
- `admin_accounts`: username, salted password hash, and creation time.
- `admin_sessions`: hashed token, device/account association, server-assigned admin role, CSRF token, creation/expiry/revocation times. Regular role is the default when no valid admin session exists.
- `member_bans`: removal/unban timestamps and acting admin, preserving previous ban records.
- `message_moderation`: message, acting admin, deletion action, and timestamp.
- `admin_login_attempts`: persistent login throttling by request IP.

`INNERCIRCLE_DATA_DIR` and `INNERCIRCLE_UPLOADS_DIR` optionally override storage paths for isolated testing. Default startup continues using `data/innercircle.db` and `uploads`.

## Validation

Run `npm test`. The suites use temporary databases and local servers; they do not alter your real chat data. The build bundles the official Blob upload client. Cloud integration adds the official libSQL and Vercel Blob SDKs.

`tests/deletion.js` checks original-schema migration, text/image/video personal hiding, unauthorized deletion rejection, shared placeholders, protected media, reconnects, and persistence across restart. `tests/admin.js` checks migration from the deletion schema (including device hashes, hidden preferences, and uploads), admin hashing/login/throttling, HTTP and Socket.IO permissions, forged roles/cross-device session misuse, origin/CSRF checks, distinct online identities, full-history pagination, moderation/audit records, multi-tab removal, banned endpoint/reconnect rejection, unban, persistence without bootstrap secrets, logout/replayed-token rejection, expiry, and production HTTPS/Secure cookies. The video fixture validates transport and access control rather than codec playback.

Manual browser validation used separate `127.0.0.1` and `localhost` identities on an isolated server. It covered regular entry/member lists, admin login, moderation and reload persistence, immediate removal notice and banned reload, unban and resumed messaging, admin participation, and logout. Login and dashboard layouts were checked at a 320px viewport with no horizontal document overflow. Proof screenshots are in `output/admin-browser/`.
"# InnerCircle" 

Cloud mode adds durable realtime_events, presence leases, media_objects, and upload_tickets tables. The migration tool also tracks completed imports in migration_imports. tests/cloud.js checks synchronization between two isolated servers and private-media provider fixtures; tests/migration.js checks preserved records, media transfer, repeat imports, and refusal to overwrite populated destinations. Live cloud resources require separate deployment verification.
