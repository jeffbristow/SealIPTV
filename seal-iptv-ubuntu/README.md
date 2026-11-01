# Seal IPTV for Ubuntu Touch (preview)

The Android phone app's pages and logic, as a click package for **Ubuntu Touch 24.04** (`ubuntu-touch-24.04-1.x` framework, any architecture: QML + Python + web pages, nothing compiled). Playlists, favorites, watched marks, resume, sync, the parental PIN and the VPN guard work as on Android.

## Install

- **OpenStore:** open the `.click` from the [Releases page](https://github.com/jeffbristow/SealIPTV/releases) in the OpenStore app ("Install from file"), or
- **Developer mode** (System Settings → System information → Developer mode; the phone needs a passcode): copy the click to the phone and install it with `click install --user=phablet --allow-unauthenticated <file>.click`, or through the click service:
  `busctl --system call com.lomiri.click /com/lomiri/click com.lomiri.click Install s /home/phablet/Downloads/<file>.click`

It doesn't update itself yet: install each new release's click the same way.

## The VPN

Set the VPN up in Ubuntu Touch itself — a WireGuard configuration (for example Proton VPN's) can be added with NetworkManager: `nmcli connection import type wireguard file <name>.conf` (run from a session terminal, or through `systemd-run --user` over adb). With *Settings → VPN → Only play when my VPN is on*, Seal IPTV checks the VPN connection (a tun / wg / proton… interface) and asks Proton whether the traffic comes from Proton. Streams, posters and requests all go through the app's backend, which refuses them while the guard says no.

## How it's built

- `qml/Main.qml` — the window: a web view with the pages, the Python backend (pyotherside), the native player.
- `qml/Player.qml` — the native player (QtMultimedia / media-hub, hardware decoding). If the media service can't play a stream within 8 s (some phones can't open their sound output, and media-hub then plays nothing), it hands over to `web/utplayer.js`, the backup player in the web view (hls.js / mpegts.js / the browser).
- `backend/backend.py` — what `NativeBridge.java` is on Android: a web server on 127.0.0.1 (two ports — Chromium opens only 6 connections to one, and the page's synchronous calls must never wait behind slow requests) serving the pages, the `SealNative` calls, web requests, pictures, a stream proxy (the provider's User-Agent, the VPN guard) and the "Get it from another device" setup server. Only the page with this launch's token (a cookie) may call it.
- `web/utnative.js` — `window.SealNative` for the shared pages, over that backend.
- `build.js` — the pages from `../seal-iptv-android/web/build.js` + `ut.html`, and with `--click` the click package (`../dist/`). `--debug` adds Chromium's DevTools on the phone's 127.0.0.1:9222 (testing only: never release or leave it installed).
- `devtest/ut-harness.js` — the backend + pages on a PC in a phone-sized Electron window.

Ubuntu Touch 24.04's web engine is Qt 5.15 = Chromium 87: no CSS `aspect-ratio` or `:has()` (`phone.css` has fallbacks).
