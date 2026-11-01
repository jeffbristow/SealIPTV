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

## Android phones

The same app for phones: `SealIPTV-Android-<version>.apk` (app id `com.sealiptv.mobile`, so it can sit next to the TV one). Same playlists, favorites, sync and VPN guard; the pages are laid out for a phone:

- **Tabs at the bottom:** Home, Live TV, Guide, Movies, Series, and **More** (Sports, Pay-Per-View, Collections, Favorites, Watchlist, your categories, Settings, the playlist and the VPN status).
- **Categories:** the *Category* button above a list opens them in a sheet, with a box to find one.
- **Tap** a channel to watch it, a poster to open it; **press and hold** for its menu (favorite, watchlist, your categories).
- **Settings:** a list of sections; one opens over it (‹ or Back goes back to the list).
- **The player** is always sideways. Tap: controls. Top bar: ← Back, ☰ Channels (live), ▲ ▼ the channel before / after. ⚙ in the controls: audio track, subtitles, speed, picture size, audio sync, another app. Double-tap the left / right of the picture: back / forward 10 s (the middle: pause). Drag up / down on the right: volume, on the left: brightness. Home or another app while it plays: a picture-in-picture window.
- **Back** (gesture or button) closes a sheet or dialog, then goes back a page, then Home, then leaves.
- **Setting it up from your PC or TV:** on the phone, **📲 Get it from another device** (welcome screen, Settings → Sync, Settings → Playlists) shows a short code. On a Seal IPTV that's already in sync: **Settings → Sync → 📺 Connect a TV or phone**, pick the phone (same Wi-Fi) and type the code — the phone joins the vault as a device of its own. Nothing in sync yet: the same window has a QR code / address to open on another phone or computer and type in the sync server or a playlist login. If nothing finds the phone, allow LAN connections in Proton VPN.

Install: allow installing from your browser / file manager (Android asks the first time), then open the APK — or from this PC with USB debugging on: `C:\Android\Sdk\platform-tools\adb.exe install -r ..\dist\SealIPTV-Android-<version>.apk`. It updates itself like the TV app (its own APK in each release, the shared pages zip).

**VPN guard on a phone:** with *Settings → VPN → Only play when my VPN is on*, Seal IPTV checks Android's VPN connection and asks Proton's server whether the traffic comes from Proton. Proton's own *always-on VPN / block connections without VPN* (Android Settings → Network → VPN) is a good extra: nothing gets out at all while Proton is off.

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
