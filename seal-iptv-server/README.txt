Seal IPTV Sync Server 1.0.0
===========================

Keeps every Seal IPTV install the same: playlists, favorites, watched
marks, resume points, hidden and PIN-locked categories, the parental PIN
and settings. A change on one PC shows up on the others within seconds.

Everything is encrypted by Seal IPTV before it is sent here, with a key
made from your vault passphrase. This server never sees your passphrase,
your playlist logins, what you watch, or your parental PIN - even the
item names are scrambled.

What you need
-------------
  - Any web hosting with PHP 8.0 or newer and SQLite (pdo_sqlite).
    Normal cPanel shared hosting is fine.
  - HTTPS on the address you use (cPanel: SSL/TLS Status -> AutoSSL).

Installing
----------
  1. Make a folder on your site, e.g. public_html/iptv-sync
     (any name works; the address becomes https://your-site/iptv-sync/).
  2. Upload all files from this package into it, including .htaccess
     (in cPanel File Manager: Settings -> Show Hidden Files).
  3. Copy config.example.php to config.php and change setup_code to
     something only you know (the example value is refused).
  4. Open https://your-site/iptv-sync/ in a browser. Every line should be
     green. It also shows the address to type into Seal IPTV.
  5. In Seal IPTV on your first PC: Settings -> Sync -> Create a new vault.
     Enter the address, a username, a vault passphrase (at least 10
     characters - write it down) and the setup code.
  6. On every other PC: Settings -> Sync -> Connect, with the same address,
     username and passphrase.

The vault is stored in a folder called seal-iptv-data next to (not inside)
your public_html, so it can't be downloaded. To put it somewhere else, set
data_dir in config.php.

Updating
--------
  Upload the new files over the old ones, but keep your config.php.
  The vault folder isn't touched.

Good to know
------------
  - One vault per server. To start over, use Settings -> Sync -> Delete
    vault in Seal IPTV (needs the passphrase), then create a new one.
  - Wrong passphrases: after 5 for a username (or 20 from one internet
    address) in 15 minutes, sign-ins wait. Change this in config.php.
  - Settings -> Sync -> Devices lists every signed-in PC; you can sign one
    out from there (for example a lost laptop).
  - Forgot the vault passphrase? It can't be recovered (nobody else has
    it). Delete the seal-iptv-data folder on the server and create a new
    vault; each PC still has its own copy of everything.

Checklist after installing
  [ ] https://your-site/iptv-sync/ shows all green
  [ ] https://your-site/iptv-sync/config.php shows nothing (blocked)
  [ ] the vault folder is outside public_html
