# InnerCircle Android

This small native Android WebView app opens `https://inner-circle-one-woad.vercel.app/`. It preserves the existing chat UI and server features without embedding server credentials or adding a second messaging backend. It supports Android 8.0 and newer, image/video file selection, video fullscreen, HTTPS-only app navigation, persistent WebView cookies, and a connection-error retry screen. It uses the phone's Android System WebView; keep that component updated.

The APK needs internet access. Its cookie identity is separate from Chrome, so enter your name again after installing; sign in separately as admin if needed. Browser notifications are not native background push notifications. This wrapper does not request camera, contacts, microphone, or broad storage permissions.

Build using the repository's **Actions → Build InnerCircle APK → Run workflow**. Normal builds require repository secrets `ANDROID_SIGNING_KEY_B64` and `ANDROID_SIGNING_PASSWORD`. The initialization input is only for the first build when both secrets are absent. The initial backup artifact is encrypted using the committed public transport key; only the private transport key in ignored local `data/android-signing` can recover it. Preserve the recovered signing key securely and configure the secrets before future builds. Never publish the signing key or password. New releases must increment `versionCode` and reuse the same key to install as updates.

The build runs Android lint and verifies the signed APK with `apksigner`. Android-device testing is still required for picker behavior, keyboard sizing, videos, and connection recovery; desktop browser tests do not cover native Android behavior.
