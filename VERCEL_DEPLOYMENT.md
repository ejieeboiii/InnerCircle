# Deploy InnerCircle to Vercel

The application uses Turso for persistent SQLite records and a **private** Vercel Blob store for images and videos. Local development still uses the existing SQLite database and uploads folder. Node.js 22 or 24 is required.

## 1. Create private media storage

In the Vercel team dashboard, open **Storage**, create a **Blob** store, and select **Private** access. Choose Tokyo if available. Copy its `BLOB_READ_WRITE_TOKEN` privately. A public Blob store would bypass the application's deleted-media access checks.

On the project import page, add these environment variables to **Production**:

| Key | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | The database URL from your Turso dashboard |
| `TURSO_AUTH_TOKEN` | Your Turso read/write database token |
| `BLOB_READ_WRITE_TOKEN` | The token for your private Blob store |

Never paste tokens into chat, screenshots, source files, or GitHub. Preview deployments should use separate test databases and stores.

## 2. Preserve and transfer existing history before deploying

Stop the existing local server with **Ctrl+C** so no messages change during the transfer. Keep a backup of both `data` and `uploads`.

In the project folder, copy `.env.example` to `.env.local` and fill in the three tokens privately in a text editor. This file is ignored by Git. The app does not automatically load it.

Run these commands one at a time:

```powershell
npm install
npm run migrate:cloud -- --dry-run
node --env-file=.env.local scripts/migrate-cloud.js --apply
```

The dry run checks the source and creates a database backup under `data/backups`. Apply uploads media privately and imports the records transactionally. The original database and files remain unchanged. Media belonging only to deleted messages is skipped. The destination must be empty: the tool refuses to overwrite a populated database. Repeating the same successful import is safe; changed source data cannot be merged by this tool.

The existing admin username and password hash are copied, so keep using your current credentials. Leave admin bootstrap variables unset when transferring an existing account. New browser cookies on the deployed hostname cannot automatically recover identities from the local hostname. Historical ownership, hides, and bans stay recorded, but those old device identities are not automatically associated with new cookies.

## 3. Push the updated source

Commit and push the updated project to your GitHub repository using GitHub Desktop or Git. Review the changes first. `.env.local`, `data`, `uploads`, `node_modules`, and `output` must remain excluded. Previously tracked test output has been removed from Git tracking; the local files remain available.

## 4. Deploy

On Vercel's import page, keep **Root Directory** as `./` and **Application Preset** as **Express**. The committed `vercel.json` sets the build command to `npm run build` and the region to Tokyo (`hnd1`). Keep the default install command and output settings. Select Node.js 22 or 24 in project settings if needed.

Confirm the three Production variables are present, then click **Deploy**. This implementation uses [Vercel's native WebSocket support](https://vercel.com/changelog/websocket-support-is-now-in-public-beta), including Socket.IO, on Fluid compute. Do not deploy as a static site, since message ownership, admin permissions, and media access require the backend.

## 5. Check the deployed app

1. Open your deployed HTTPS URL. `/api/session` should return JSON and `/api/config` should report `"mediaMode":"blob"`.
2. Use two separate browsers or phones. Send messages and check that both update without refreshing.
3. Test Delete for Me, reload, and verify the other browser still sees the message. Delete your own message for everyone and confirm both show the placeholder after reload.
4. Upload an image and video (maximum 20 MB). Check video playback and seeking. Delete for Everyone and check that the application's media URL returns 404.
5. Sign in with your existing admin account. Test moderation, removal, unban, and logout across both sessions.
6. Switch your phone off Wi-Fi onto mobile data and confirm the HTTPS app still works. Prepare the APK only after these checks pass.

## Operation and limitations

Messages, deletion preferences, admin sessions, and bans are stored in Turso. A durable event journal synchronizes active server instances roughly once per second. Presence uses renewable 60-second leases. Clients reconnect and refresh authoritative history when connections end. This polling approach is intended for a small group; monitor Turso query usage as membership grows.

Browser uploads go directly to private Blob storage through server-issued scoped upload tokens, avoiding the function request-body limit. Downloads pass through the application permission checks. Video byte ranges are supported, but the Blob SDK currently fetches the underlying object before the server slices the requested range; monitor bandwidth for frequent seeking.

Device cookies establish ownership without regular-user registration. Clearing cookies or changing browser/hostname creates a new identity and can bypass device bans. Display names do not establish ownership. Deletion cannot erase already downloaded files, screenshots, backups, or previously delivered responses. Keep the database and Blob credentials private.

Automated checks cover local SQLite, the libSQL adapter, two isolated server instances, and controlled Blob-provider fixtures. Actual Turso networking, private Blob callbacks, and Vercel deployment must be verified with your own configured resources. No live migration or deployment is performed by updating the code.
