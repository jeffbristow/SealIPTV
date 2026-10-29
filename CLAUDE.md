# CLAUDE.md

Guidance for Claude Code in this folder.

## Project

**Seal IPTV** — a Windows 11 IPTV player (Electron), part of the Seal family
(Sealpost, Seal Chat, Seal PGP at sealpgp.com): same dark theme, Seal green
`#3ccf91`, the same seal artwork (here holding a TV). Similar in purpose to
IPTV Smarters Pro. It plays the user's own IPTV subscription; it ships no
channels or content.

- Sources: **Xtream Codes** logins (server / username / password) and
  **M3U / M3U8** playlists (link or file). A pasted `get.php?username=…` link
  is turned into an Xtream login automatically.
- Live TV / Movies / Series, categories, search, sort.
- TV guide: the full XMLTV guide (Xtream: the provider's own xmltv.php, made
  from the login; any playlist: a guide address of its own, or Off — playlist
  editor) plus the provider's per-channel listings (get_short_epg) for the
  channels the full guide hasn't got. TV Guide page: channels down the side,
  time across, favorites first.
- Favorites, watched marks (manual + automatic at a % of the runtime),
  resume points, "Continue watching", next-episode countdown.
- **VPN guard** (Settings → VPN → "Only play when my VPN is on"): nothing
  reaches the provider unless the VPN is confirmed; fails closed.
- GitHub: **jeffbristow/SealIPTV** (public, since 2026-10-26: the apps check its
  releases for updates without logging in). Ask before every push / release.
  Never commit keys (`*.pem`, `keystore/`, `keystore.properties`), `seal-iptv-server/config.php`
  or anything personal (use example.com) — .gitignore covers the files.

## Layout

```
seal-iptv/
  package.json             version, scripts, electron-builder config (NSIS)
  src/main/
    bootstrap.js           entry point: runs the newest downloaded update package (updates\*.asar)
                           newer than the installed app, else the installed copy (bad ones set aside)
    asarinfo.js            reads package.json from an .asar without locking it
    updater.js             GitHub releases: signed update.json, download + check the .sealiptv package
    franchises.js/.json    Collections: hand-kept franchise list (release dates, story order, shows),
                           matched to the playlist by cleaned title + year; add new films to the .json
                           (art = TMDB collection poster for the card, cover = stand-in title)
    imagecache.js          Windows: every poster / logo via sealimg://img/?u=… kept in userData/images (600 MB cap;
                           failed addresses remembered 6 h in failed.json). Fire TV: ImageCache.java (300 MB)
    artwork.js             missing posters by title: TVmaze (series), TMDB (key; movies, series, collections), artwork.json cache
                           + the pictures themselves in posters/ (data: text files; the window sends them: art:keep)
    main.js                window, network guard, ipc handlers, VLC, dev screenshots
    preload.js             window.api.invoke(channel, …) whitelist + events
    store.js               settings + playlists (seal-iptv.json; passwords via safeStorage)
    library.js             favorites / watched / resume, one file per playlist
    catalog.js             catalogue per playlist, paging, search. On disk: catalog/<id>.json (summary:
                           counts, categories, newest titles for Home, titles the library points to)
                           + catalog/<id>.<live|movies|series>.json, each read when first needed.
                           An older single-file <id>.json is still read and saved the new way.
    guide.js               the full TV guide (XMLTV): downloaded every 6 h (1 h when it had little
                           ahead of now), read as it arrives (TV: res.pieces, 1 MB at a time), only
                           the next 26 h for the playlist's tvg ids kept -> catalog/<id>.guide.json.
                           catalog.epg / epgMany use it first, then get_short_epg (kept 15 min).
    trending.js            Trending movies / series on Home: Netflix's own Top 10 TSV (needs a browser
                           User-Agent, else it comes cut short), TVmaze's week of streaming episodes per
                           service, TMDB popular-per-service + trending (only with the user's key) ->
                           trending.json (12 h). catalog.trending matches by titleKey + year (no year and
                           two different years in the playlist: skipped); TV: never reads a section for
                           Home — matches after a reload / when a section is read, kept in
                           catalog/<id>.trend.json (first run: read in the background once).
                           FlixPatrol has the other services' Top 10s but sits behind a Cloudflare bot
                           check: not used.
    studios.js             the Disney / Netflix / Prime collections: studios.dat (shipped; scrambled with
                           pack/unpack so the titles aren't searchable text; TV: bundled by build.js'
                           .dat text loader) or a newer copy fetched from GitHub (raw .../main/seal-iptv/
                           src/main/studios.dat) every
                           3 days -> franchises.setStudios (collections "studio-<id>", newest first, only
                           what the playlist has; catalog._studio). Built from Wikipedia's lists by
                           ../tools/studios.js (sections like "Exclusive international distribution" and
                           "(seasons 4–5)" continuations left out; a list 20 % smaller than before fails),
                           weekly by .github/workflows/studios.yml. Wikidata's "distributed by Netflix"
                           was tried: thousands of licensed films, not usable.
    xtream.js              Xtream Codes player_api client + stream URLs + normalizers
    m3u.js                 M3U parser, live/movies/series sorting, show grouping
                           Ids: streamId(url) = hash of the address without the login (Xtream-style
                           user/pass segments, login query values, user:pass@, .ts/.m3u8), host kept —
                           a new password keeps every id. After any reload catalog._carryOver moves the
                           library (favorites, watched, resume, my categories) of titles whose id is gone:
                           by address, else by name (+ category), episodes by show + season/number
                           (library.remap, synced). Editing the playlist in use reloads it.
    vpn.js                 VpnGuard (adapter + Proton API / ipinfo checks, watcher)
    parental.js            parental PIN (salted scrypt hash, unlock timer, wrong-PIN backoff)
    sync.js                Sync with seal-iptv-server: records + newest-wins, E2E encrypted (see header)
    language.js            "not in English" guesses from category tags/names and title tags/scripts
  src/renderer/
    index.html, styles.css app shell (same tokens as Sealpost)
    app.js                 pages: Home, Live TV, Movies, Series, Favorites, Search, Settings
    player.js              player (hls.js / mpegts.js / native, fallback chain)
    avsync.js              audio/video sync: picture delay (frame buffer -> canvas), sound
                           delay (Web Audio), per audio device; sync test + tap measuring
    logo.svg, icon.png     seal + TV
  build/icon.ico, icon.png made by devtest/make-icons.js
  test/                    m3u, xtream (+catalog), library, vpn, store
  devtest/
    fake-xtream.js         pretend provider (demo/demo) with public test streams
    shots.js               end-to-end run: plays streams, saves screenshots
    make-icons.js          logo.svg -> icon.ico / icon.png (Edge headless)
```

../seal-iptv-server/       Seal IPTV Sync Server (PHP 8 + SQLite, for shared hosting; README.txt
                           = install steps). Same design as Sealpost's sync server, no webmail:
                           api.php (ping/prelogin/setup/login/pull/push/devices/revoke/
                           changeAuth/destroy), lib.php, index.php (status page), config.example.php
dist/                      Seal-IPTV-Sync-Server-<ver>.zip (upload; never contains config.php)

../seal-iptv-android/      Fire TV app (APK; see its README.md). Java shell (WebView + ExoPlayer +
                           NativeBridge) around the SAME src/main logic and src/renderer pages,
                           bundled by web/build.js with Node shims. build-apk.ps1 builds it ->
                           dist/SealIPTV-FireTV-<ver>.apk. Signing key: seal-iptv-android/keystore/
                           + keystore.properties (local only, never share or commit).
                           After changing src/main or src/renderer, rebuild the APK too.
                           TV gotchas (seen on a real Fire TV): the page is laid out 1280 wide and
                           MainActivity scales it with setInitialScale (no initial-scale in the
                           meta). The Fire TV keyboard can't type into WebView fields, so OK on a
                           field opens NativeBridge.editText (an Android EditText dialog) and the
                           text comes back through window.__tvText in tvnav.js.
                           Big data (a provider's movie list can be 50 MB+): never one Java String
                           (OutOfMemory on a Fire TV Stick, 1.1.0). Answers > 512 KB go to a file and
                           the page reads them in 1 MB base64 pieces (blobChunk); big saved files use
                           fileSize/fileChunk/appendFile (shims/fs.js). Test: web/test-pieces.js.
                           Crash logs: adb connect <TV IP>:5555, adb logcat -b crash -d.
                           devtest/tv-harness.js turns off Chromium's window-occlusion check: with the
                           PC's screen locked the page otherwise stops drawing (no screenshots,
                           IntersectionObserver never fires — the TV Guide / lists never load).
                           Start-up steps, slow commands (> 0.5 s) and page errors: adb logcat -s SealWeb
                           (core.js trace() -> console "[seal] …" -> MainActivity.onConsoleMessage).
                           Never change the WebView's own User-Agent: it reloads the page (that was
                           the "page starts twice"); the provider's UA is only for native fetches.
                           Shared-code hooks for it: window.SEAL_TV / TV in app.js (wording, hidden
                           desktop-only options, tabindex on cards), vpn.js vpnActive option,
                           avsync.js asks SealNative.audioOutput().

../tools/release.js        builds + signs a release into dist/release/<ver>/; --publish = gh release v<ver>
../release-notes/<ver>.md  "What's new" for each release (needed for --publish)

## Commands (in `seal-iptv/`)

```bash
npm start                       # run the app
npm test                        # unit tests (no network)
npm run fake-server             # pretend provider on http://127.0.0.1:8790 (demo / demo)
node devtest/shots.js <folder>  # end-to-end run + screenshots (needs internet)
npm run icons                   # redraw the icons after changing logo.svg
npm run dist                    # Windows installer -> dist/
```

`SEAL_IPTV_DATA=<folder>` makes the app use another data folder — use it for
any test run so the user's real settings/library are never touched.

## How things fit

- The window never sees passwords. It asks main for `play:prepare`
  (VPN check → stream URL → resume point); main builds Xtream URLs.
- **Network guard** (main.js §3): every http(s) request from the window is
  provider traffic (the app's own files are file://), so while the VPN is
  required and not confirmed they're all cancelled. The same hook sets the
  User-Agent, strips Origin/Referer and adds CORS headers (providers rarely
  send them; hls.js / mpegts.js need them).
- Main-process requests to the provider (catalog, details, EPG) call
  `vpn.ensure()` first; errors carry `code: 'VPN'` + `vpn` status, and the
  window shows the "VPN required" dialog for those (`fail()` in app.js).
- VPN checks: ProtonVPN = adapter named "ProtonVPN" up + `api.protonvpn.ch/
  vpn/location` answering Code 86081 (= on a Proton server), else ipinfo.io
  org contains "Proton". Other VPN = adapter up (+ optional home-IP and
  network-name checks). Adapter polled every 4 s, full check every 60 s;
  a drop closes the player.
- Library keys: `live:<id>`, `movie:<id>`, `series:<id>`, `episode:<id>`,
  per playlist (stream IDs belong to a provider).
- Big providers: the window pages through `catalog:list` (120–150 at a
  time, infinite scroll); never send whole lists to the window.
- Audio sync (avsync.js): value in ms, > 0 = sound late (Bluetooth) -> frames are read
  from video.captureStream() with MediaStreamTrackProcessor (every frame, even pace), timed
  by their own timestamps + delay and drawn on #pCanvas, which covers the <video> (left
  visible so Chromium keeps it running; subtitles go to an overlay). Backup when that API
  is missing: requestVideoFrameCallback + VideoFrame. Check smoothness with
  `node devtest/shots.js <folder> smooth` (paint gaps vs. no delay; never read canvas
  pixels to measure — the readback itself stutters); < 0 -> MediaElementSource ->
  DelayNode. Saved in settings.playback.avSync { def, devices: { <output name>: ms } };
  the <video> uses crossOrigin=anonymous (the network guard's CORS headers make it work).
- Parental / categories (catalog.js rules()): a category is locked if its library flag
  says lock:true, or its name matches ADULT_RE while parental.autoAdult (lock:false =
  unlocked on purpose); hidden if hide:true, or hideNonEnglish and it looks foreign
  (show:true = shown anyway). Items are filtered in main (list, cats, search, recent,
  favorites, continue watching); item(), details and streamUrl throw code 'LOCKED' with
  .locked = { section, cat, name } -> the window asks for the PIN and retries. The PIN
  hash never reaches the window (store.getSettings() gives parental.hasPin only), and
  settings:set can't change parental; locking/unlocking categories needs
  parental.allowChange().
- Sync (sync.js): every change is a record — profile:<pid>, settings:<group> (store.js
  SYNC_GROUPS: per-PC things like activeProfile, VPN adapter/home IP, VLC path never
  sync), fav/seen/pos:<pid>:<key>, cat:<pid>:<section>:<id>; removals are records with
  d:null. Store/Library call onChange(name, data); applying remote records sets
  sync.applying so they aren't sent back. Item ids on the server = type + HMAC(vault
  key, name). Newest t wins (pull: unless our pending copy is newer; push conflict: the
  server's copy comes back, newer kept). First connect: pull, join duplicate playlists
  (same provider+user / same M3U -> library.mergeInto + catalog.rename), snapshot local
  records with old timestamps (vault wins on settings), push. main.js: push 1.5 s after
  a change (resume points 20 s), pull every 15 s and on window focus; the window gets
  'sync:applied' and reloads app:init. Tests: test/sync-test.js runs the real PHP server
  (php -S; needs PHP with pdo_sqlite, PHP=…); devtest/sync-shots.js runs two app windows.
- Hidden categories never match searches; parental.setSearchHidden(true, pin) lets
  catalog.list(q) include them (fromHidden flag on items) until Lock / the keep-open time.
- Codecs: Chromium can't decode AC-3/DTS audio and some containers; the
  player offers "Open in VLC" (same VPN rule, passes UA + start time).
- Posters (artwork.js): the window marks a missing / broken poster with data-ak/an/ay
  (pic() in app.js); `Art` looks up the ones on screen in batches (art:find). TVmaze ~20
  requests / 10 s (one lane, 550 ms gap); misses kept 14 days (retried at once when a
  TMDB key is added). Only while vpn.allowed() and settings.artwork.lookup; the key syncs
  (SYNC_GROUPS.artwork).
- Updates: releases v<ver> carry update.json + update.json.sig (ECDSA P-256 over the exact
  bytes; private key %USERPROFILE%\.sealiptv\update-signing-key.pem — never commit/share;
  public key in updater.js PUBLIC_KEY and UpdateManager.java PUBLIC_KEY). manifest.version
  must equal the tag. Windows: .sealiptv = app.asar -> <data>/updates/seal-iptv-<ver>.asar,
  bootstrap.js runs it (boot.json counts starts until the window shows; 2 failures = bad);
  windows.minInstalled (package.json updateMinInstalled) > installed -> 'installer'.
  Fire TV: web zip -> files/web/<ver> (MainActivity loads /update/<ver>/index.html;
  core.js calls webReady via window.__sealStarted), or the APK when web.minNative >
  versionCode. Tests: test/update-test.js (fake GitHub), artwork-test.js (fake sites).
  Dev runs from source ignore downloaded packages unless SEAL_IPTV_TEST_UPDATES=1.

## Conventions

Same as Sealpost: plain JS, no framework, sectioned file headers, short
user-facing text in plain English, CSP in index.html (no inline scripts).
Test files print `✓` lines and a "N passed" total.
