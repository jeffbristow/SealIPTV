# Seal IPTV for Fire TV

The Windows app's features on an Amazon Fire TV Stick / Fire TV: Xtream Codes and M3U playlists, Live TV / Movies / Series, favorites, watched marks, resume, next episode, parental PIN, hidden categories, "not in English", the VPN guard (ProtonVPN app), audio sync, and sync with your Seal IPTV Sync Server.

## Installing on the Fire TV Stick

1. On the Fire TV: **Settings → My Fire TV → About**, select the device name 7 times → *Developer options* appear.
2. **Settings → My Fire TV → Developer options**: turn on **ADB debugging**, and **Apps from Unknown Sources** (newer Fire OS: *Install unknown apps* → allow the app you install with).
3. Install `SealIPTV-FireTV-<version>.apk` (from the [Releases page](https://github.com/jeffbristow/SealIPTV/releases), or `..\dist\` after a build), either way:
   - **From this PC with adb** (same network): note the Fire TV's IP (**Settings → My Fire TV → About → Network**), then
     `C:\Android\Sdk\platform-tools\adb.exe connect <IP>:5555` (allow it on the TV), then
     `C:\Android\Sdk\platform-tools\adb.exe install -r ..\dist\SealIPTV-FireTV-<version>.apk`
   - **With the Downloader app** on the Fire TV: open the APK's address from the Releases page in Downloader.
4. Seal IPTV appears under **Apps** on the Fire TV home screen.

From 1.1.0 on, Seal IPTV updates itself: it checks GitHub when it starts (Settings → About), downloads new pages straight away, and hands a new APK to Android's installer only when the Android part changed. The first APK update asks once to allow Seal IPTV to install apps.

An APK installs over the old version (keeping playlists and settings) only when it's signed with the same key: keep `keystore\` and `keystore.properties` safe and private (never in git).

## The remote

| Button | |
|---|---|
| ← ↑ → ↓ | move |
| OK | select / press (form fields: opens a text box with the keyboard; OK / Done puts the text in the field) |
| Back | back; on Home press twice to leave |
| ☰ Menu | on a category: hide / lock with the PIN. In the player: audio track, subtitles, audio sync, next episode, open in another app |
| In the player: ↑ ↓ or CH+ / CH− | previous / next channel (live) |
| ▶❚❚, ⏪ ⏩ | play / pause, seek |

## How it's built

- `app/` — Android (Java): `MainActivity` (full-screen WebView with the app's pages), `NativeBridge` (`window.SealNative`: files, Keystore, web requests, VPN state, audio device, apps), `PlayerActivity` (Media3 ExoPlayer: HLS / TS / MP4 / MKV, HEVC, AC-3 / E-AC-3; audio sync by offsetting the audio clock).
- `web/` — `build.js` bundles the **same** logic as Windows (`..\seal-iptv\src\main`) with small Node stand-ins (`src/shims/`) into `assets/www/core.js`, and copies the Windows pages (`app.js`, `styles.css`, `avsync.js`) next to `tvnav.js` (remote), `player-tv.js` (Android player) and `tv.css`.
- `web/test-shims.js` — the TV crypto gives the same results as Windows (sync vault, PIN hash).
- `devtest/tv-run.js` — runs the TV pages in a desktop window with a pretend Android side: remote keys, player events, and a sync vault made by the "TV" that the Windows code then reads.
- `build-apk.ps1` — web build + signed APK -> `..\dist\`.
- `UpdateManager.java` — updates: the signed `update.json` of the newest GitHub release, the pages zip (unpacked to `files/web/<version>/`, served as `/update/<version>/`; a version that doesn't start twice is set aside) or the APK (Android's installer via a FileProvider).
