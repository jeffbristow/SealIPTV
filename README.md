# Seal IPTV

A player for the IPTV service you subscribe to, for **Windows 11** and **Amazon Fire TV**. Part of the Seal family (Sealpost, Seal Chat). Seal IPTV doesn't come with any channels or content.

| | |
|---|---|
| `seal-iptv/` | the Windows app (Electron) |
| `seal-iptv-android/` | the Fire TV app (same pages and logic, Android's player) — see its [README](seal-iptv-android/README.md) |
| `seal-iptv-server/` | the Seal IPTV Sync Server for your own website (PHP + SQLite) — see its [README.txt](seal-iptv-server/README.txt) |
| `tools/release.js` | makes a release (below) |

## Download and install

Everything is on the [Releases page](https://github.com/jeffbristow/SealIPTV/releases):

- **Windows:** `SealIPTV-Setup-<version>.exe`.
- **Fire TV:** `SealIPTV-FireTV-<version>.apk` — install steps in the [Fire TV README](seal-iptv-android/README.md).
- **Sync server:** `SealIPTV-Sync-Server-<version>.zip` — upload it to your website (steps in its README.txt).

## Updates

Both apps look for a new version on GitHub when they start (Settings → About: **Check for updates**, and the switch to turn it off). When there is one, a bar at the top offers **Update**:

- **Windows** downloads the new app (a few MB, no installer) and asks you to restart. Only when a release needs a newer Electron does it send you to the new installer instead.
- **Fire TV** downloads the new pages and reloads, usually without an APK. When the Android part changed, it downloads the new APK and Android asks you to install it (the first time, Fire OS asks you to allow Seal IPTV to install apps).

Every release carries an `update.json` signed with the release key, and each file must match its checksum in it, so the apps install nothing else.

## Posters

Many providers leave posters empty or link to pictures that are gone. Seal IPTV fills those in by title (Settings → Posters): series from [TVmaze](https://www.tvmaze.com) (no setup), movies and series from [TMDB](https://www.themoviedb.org) with a free API key (themoviedb.org → Settings → API; the key syncs to your other devices). Only the title and year are sent, never your provider or login, and nothing is looked up while the VPN check is blocking. *This product uses the TMDB API but is not endorsed or certified by TMDB.*

## What it does

- **Your provider's playlist:** an Xtream Codes login (server, username, password) or an M3U / M3U8 playlist link or file. Several playlists can be added; switch at the bottom of the sidebar.
- **Live TV, Movies and Series** with the provider's categories, search, sorting and "what's on now" for live channels.
- **Favorites** for channels, movies and series (☆), shown on Home and under Favorites.
- **Watched marks:** mark a movie, an episode or a whole season as watched, or let Seal IPTV mark it when you reach 90% (80–95%, Settings → Playback).
- **Resume:** movies and episodes pick up where you left off; Home shows "Continue watching". The next episode starts by itself after a 10-second countdown (can be turned off).
- **VPN guard:** Settings → VPN → "Only play when my VPN is on". Seal IPTV then loads nothing from your provider (playlist, posters, streams) unless the VPN is confirmed, and tells you why instead of playing.
  - **ProtonVPN:** the ProtonVPN connection must be up and Proton must confirm your traffic comes from a Proton server.
  - **Another VPN:** its network adapter must be up; optionally your home IP must not show and the network name must match.
  - If the VPN drops while something plays, playback stops.
- **Audio sync** for Bluetooth headphones or speakers whose sound is late: ⏱ Sync in the player (or the `[` and `]` keys) holds the picture back until it matches the sound. Each audio device keeps its own value. The **Sync test** (Settings → Playback, or in the player) shows a dot that flashes and beeps at the same moment: move the slider until they're together, or let **Measure for me** work it out from your taps.
- **Parental controls** (Settings → Parental controls): set a PIN; categories with "Adult", "XXX" or "18+" in their name are locked, and you can lock others (right-click a category, or Settings → Categories). Nothing from a locked category shows in lists, search, Home or Favorites until the PIN is entered; after the PIN they stay open until Seal IPTV closes (or 15 min / 1 h / 4 h), and **🔓 Lock** in the sidebar locks them again.
- **Hide categories** you never watch (right-click → Hide, or Settings → Categories), and optionally **hide what isn't in English**, judged from the provider's language tags and names ("FR | Films", "ARABIC MOVIES", "DE - …") and titles in other scripts. "Show anyway" brings back a category it got wrong.
- **Search hidden categories:** hidden categories never show up in search. **🙈 Include hidden** next to the search box (parental PIN) includes them for as long as locked categories stay open after the PIN, or until you press **Lock**.
- **Sync between PCs:** with the **Seal IPTV Sync Server** on your own website (`seal-iptv-server/`, see its README.txt), every connected Seal IPTV keeps the same playlists, favorites, watched marks, resume points, hidden and locked categories, parental PIN and settings (Settings → Sync). Changes reach the other PCs within seconds. Everything is encrypted on the PC first; the server can't read any of it.
- **Open in VLC** for streams the built-in player can't play (for example AC-3 / DTS sound). The VPN rule applies there too.

## Player keys

| Key | |
|---|---|
| Space / K | Play / pause |
| ← / → | Back 10 s / forward 30 s |
| ↑ / ↓ | Volume |
| Page Up / Page Down | Previous / next channel |
| N | Next episode |
| F, double-click | Full screen |
| M | Mute |
| [ / ] | Audio sync −10 / +10 ms (Shift: 50 ms) |
| Esc | Leave full screen / close the player |

## For development

See `CLAUDE.md`. In `seal-iptv/`: `npm install`, `npm start`, `npm test`. `npm run fake-server` starts a pretend provider (login `demo` / `demo` at `http://127.0.0.1:8790`) that plays public test videos. The Fire TV app: `seal-iptv-android/README.md`.

## Making a release

1. Raise `"version"` in `seal-iptv/package.json` (the Fire TV app takes the same version).
2. Write `release-notes/<version>.md` (shown in the apps under **What's new**).
3. `node tools/release.js` builds and checks everything into `dist/release/<version>/`; `node tools/release.js --publish` also creates the GitHub release `v<version>`.

The release key (`%USERPROFILE%\.sealiptv\update-signing-key.pem`) and the Fire TV signing key (`seal-iptv-android/keystore/`) stay on the release PC: never commit or share them, and keep a backup. See the header of `tools/release.js` for when to raise `updateMinInstalled`, the APK's `versionCode` and `MIN_NATIVE`.

## License

GPL-3.0 — see [LICENSE](LICENSE).
