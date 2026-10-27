/* =====================================================================
 * Seal IPTV — sync.js   (Settings → Sync)
 * ---------------------------------------------------------------------
 * Keeps every Seal IPTV that's connected to your own Seal IPTV Sync
 * Server (the PHP files in seal-iptv-server/) the same.
 *
 * ZERO-KNOWLEDGE DESIGN (the same scheme as Sealpost's sync)
 *     master   = PBKDF2-SHA256(passphrase, "sealiptv:" + username, 600 000)
 *     loginKey = HKDF(master, "sealiptv-auth")  -> the server keeps an Argon2id hash
 *     wrapKey  = HKDF(master, "sealiptv-wrap")  -> never leaves this PC
 *   A random 256-bit VAULT KEY encrypts every item (AES-256-GCM; the item
 *   id is bound in as associated data). The server has it only wrapped
 *   with wrapKey. Item ids are "<type>:" + HMAC(vault key, name), so the
 *   server can't see which channel / show / category an item is about.
 *   This PC keeps the vault key and the device token protected by your
 *   Windows login (Electron safeStorage).
 *
 * WHAT SYNCS — small records, each with the time it was changed:
 *   profile:<pid>                 a playlist, with its login (encrypted)
 *   settings:<group>              playback, network, catalog, content, artwork, vpn, parental
 *   fav:<pid>:<key>               a favorite              (key = live:123, movie:9 …)
 *   seen:<pid>:<key>              a watched mark
 *   pos:<pid>:<key>               a resume point
 *   cat:<pid>:<section>:<id>      a category's hide / lock / show-anyway choice
 *   list:<pid>:<list id>          one of the user's own categories (Kids …)
 *   listed:<pid>:<list id>/<key>  a channel / movie / series in one of them
 *   A removal is a record too ({ d: null }), so it reaches every device.
 *   Not synced: the downloaded channel lists, which playlist is in use,
 *   the VPN adapter / home IP, the VLC location, whether the PIN is
 *   entered right now.
 *
 * NEWEST WINS
 *   Each record carries t = when it was changed. Pulling: a record from
 *   the server replaces ours unless ours is waiting to be sent and is
 *   newer. Pushing: if another device changed the same record first,
 *   the server hands back its copy; the newer of the two is kept.
 *
 * Sections:
 *   1. Crypto
 *   2. Saved sync state (sync.json)
 *   3. Server requests
 *   4. Recording local changes / applying remote ones
 *   5. The sync run
 *   6. Connect / disconnect / devices / delete vault
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const pbkdf2 = promisify(crypto.pbkdf2);

const API_VERSION = 1;
const DEFAULT_KDF = { alg: 'pbkdf2-sha256', iter: 600000 };
const WRAP_AAD = 'sealiptv-vault-key';
const TYPES = ['profile', 'settings', 'fav', 'seen', 'pos', 'cat', 'list', 'listed'];
/* Raised when TYPES grows: versions before skipped the new kinds of records while pulling,
   so the vault is read once more from the start (what's known already isn't applied again). */
const PULL_VERSION = 2;

/* =================================================================
 * 1. CRYPTO
 * ================================================================= */
async function deriveKeys(passphrase, username, kdf = DEFAULT_KDF) {
  if (!kdf || kdf.alg !== 'pbkdf2-sha256') throw new Error('This server uses a key setting Seal IPTV doesn\'t know. Update Seal IPTV.');
  const salt = 'sealiptv:' + String(username).trim().toLowerCase();
  const master = await pbkdf2(Buffer.from(String(passphrase).normalize('NFC'), 'utf8'), Buffer.from(salt, 'utf8'), kdf.iter, 32, 'sha256');
  const authKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'sealiptv-auth', 32)).toString('hex');
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'sealiptv-wrap', 32));
  master.fill(0);
  return { authKey, wrapKey };
}

/** AES-256-GCM: "v1." + base64(iv[12] | ciphertext | tag[16]) */
function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return 'v1.' + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

function unseal(key, blob, aad) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) throw new Error('Unknown item format');
  const raw = Buffer.from(blob.slice(3), 'base64');
  if (raw.length < 29) throw new Error('Item is damaged');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
}

/** "example.com/iptv-sync" -> "https://example.com/iptv-sync/api.php" */
function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your sync server\'s address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That server address isn\'t valid.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('The server address must start with https://');
  u.search = ''; u.hash = '';
  if (!/\.php$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, '/') + 'api.php';
  return u.toString();
}

const typeOf = k => k.slice(0, k.indexOf(':'));

class SyncService {
  /**
   * @param o.dataDir     data folder (sync.json goes there)
   * @param o.store       Store
   * @param o.library     Library
   * @param o.secure      { encrypt, decrypt } (safeStorage) or null in tests
   * @param o.onApplied   (Set of types, details) => void — after remote changes were applied
   * @param o.onProfileGone (pid) => void — a playlist was deleted on another device
   * @param o.fetch       fetch implementation
   */
  constructor(o) {
    this.store = o.store;
    this.library = o.library;
    this.secure = o.secure || null;
    this.file = path.join(o.dataDir, 'sync.json');
    this.fetch = o.fetch || ((...a) => fetch(...a));
    this.onApplied = o.onApplied || (() => {});
    this.onProfileGone = o.onProfileGone || (() => {});
    this.onProfileJoined = o.onProfileJoined || (() => {});
    this.appVersion = o.appVersion || '';
    this.running = null;
    this.again = false;
    this.state = this._load();
    // local changes from the store / library become pending records
    this.store.onChange = (k, d) => this.record(k, d);
    this.library.onChange = (k, d) => this.record(k, d);
  }

  /* =================================================================
   * 2. SAVED SYNC STATE (sync.json)
   *    { server, username, deviceId, deviceName, token*, vaultKey*, keyVersion,
   *      seq, known: { name: { id, seq, t } }, pending: { name: { t, d } },
   *      lastSync, lastError, needs }               (* = protected by Windows login)
   * ================================================================= */
  _load() {
    try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (s && s.server) return { known: {}, pending: {}, ...s }; } catch { /* none */ }
    return null;
  }

  _save() {
    if (!this.state) { try { fs.unlinkSync(this.file); } catch { /* gone */ } return; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  _protect(buf) {
    const s = Buffer.from(buf).toString('base64');
    return this.secure ? 'enc:' + this.secure.encrypt(s) : 'b64:' + s;
  }

  _unprotect(v) {
    if (!v) return null;
    if (v.startsWith('enc:') && this.secure) { try { return Buffer.from(this.secure.decrypt(v.slice(4)), 'base64'); } catch { return null; } }
    if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64');
    return null;
  }

  _token() { const b = this._unprotect(this.state && this.state.token); return b ? b.toString('utf8') : null; }
  _vaultKey() { return this._unprotect(this.state && this.state.vaultKey); }
  connected() { return !!(this.state && this.state.token && this.state.vaultKey); }

  status() {
    const s = this.state;
    if (!s) return { connected: false };
    return {
      connected: true,
      server: s.server.replace(/api\.php$/i, ''),
      username: s.username,
      deviceName: s.deviceName,
      lastSync: s.lastSync || null,
      lastError: s.lastError || null,
      needs: s.needs || null,
      items: Object.keys(s.known || {}).length,
      waiting: Object.keys(s.pending || {}).length,
      running: !!this.running
    };
  }

  /* =================================================================
   * 3. SERVER REQUESTS
   * ================================================================= */
  async _api(action, body, { server, auth = true, timeout = 30000 } = {}) {
    const url = (server || this.state.server) + '?action=' + encodeURIComponent(action);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'SealIPTV/' + this.appVersion };
    if (auth) headers['X-SealIPTV-Token'] = this._token() || '';
    let res, text;
    try {
      res = await this.fetch(url, {
        method: action === 'ping' ? 'GET' : 'POST', headers,
        body: action === 'ping' ? undefined : JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeout), redirect: 'error'
      });
      text = await res.text();
    } catch (e) {
      const err = new Error('Can\'t reach the sync server (' + (e.cause && e.cause.code ? e.cause.code : e.name === 'TimeoutError' ? 'timed out' : e.message) + ').');
      err.code = 'NETWORK';
      throw err;
    }
    let json;
    try { json = JSON.parse(text); } catch {
      const err = new Error(res.status === 404 ? 'There\'s no Seal IPTV Sync Server at that address.' : `The server sent an unexpected reply (HTTP ${res.status}).`);
      err.code = 'BAD_SERVER';
      throw err;
    }
    if (!json.ok) {
      const err = new Error(json.message || json.error || 'Server error');
      err.code = json.error || 'SERVER';
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /* =================================================================
   * 4. LOCAL CHANGES / REMOTE CHANGES
   * ================================================================= */
  /** A change on this PC (from store / library). d = the record, or null = removed. */
  record(name, d, t = Date.now()) {
    if (!this.state || this.applying) return;
    this.state.pending[name] = { t, d: d == null ? null : d };
    this._save();
    if (this.onLocalChange) this.onLocalChange(typeOf(name));
  }

  _idOf(name, key) {
    return typeOf(name) + ':' + crypto.createHmac('sha256', key).update(name).digest('hex');
  }

  /** Everything on this PC as pending records (first sync). Older records lose to the vault's. */
  snapshot() {
    const add = (name, d, t) => { if (!this.state.pending[name]) this.state.pending[name] = { t, d }; };
    for (const p of this.store.listProfiles()) add('profile:' + p.id, this.store.syncProfile(p.id), 1);
    for (const [g, d] of Object.entries(this.store.syncSettings())) add('settings:' + g, d, 1);
    for (const p of this.store.listProfiles()) {
      const L = this.library._get(p.id);
      for (const [k, v] of Object.entries(L.favorites)) add(`fav:${p.id}:${k}`, v, v.at || 1);
      for (const [k, v] of Object.entries(L.watched)) add(`seen:${p.id}:${k}`, v, v.at || 1);
      for (const [k, v] of Object.entries(L.progress)) add(`pos:${p.id}:${k}`, v, v.at || 1);
      for (const [k, v] of Object.entries(L.cats)) add(`cat:${p.id}:${k}`, v, 1);
      for (const [k, v] of Object.entries(L.lists)) add(`list:${p.id}:${k}`, v, v.at || 1);
      for (const [k, v] of Object.entries(L.listed)) add(`listed:${p.id}:${k}`, v, v.at || 1);
    }
    this._save();
  }

  /** Apply one record from the server here (without recording it as a local change). */
  _apply(name, d) {
    const type = typeOf(name);
    const rest = name.slice(type.length + 1);
    this.applying = true;
    try {
      if (type === 'profile') {
        if (d) this.store.applyProfile(d);
        else if (this.store.listProfiles().some(p => p.id === rest)) { this.store.deleteProfile(rest); this.library.remove(rest); this.onProfileGone(rest); }
      } else if (type === 'settings') {
        this.store.applySettings(rest, d);
      } else {
        const pid = rest.slice(0, rest.indexOf(':'));
        const key = rest.slice(pid.length + 1);
        this.library.applyRecord(type, pid, key, d);
      }
    } finally { this.applying = false; }
    return type;
  }

  /* =================================================================
   * 5. THE SYNC RUN: pull, apply, push (up to 3 rounds for conflicts)
   * ================================================================= */
  sync() {
    if (!this.connected()) return Promise.resolve(null);
    if (this.running) { this.again = true; return this.running; }
    this.running = this._run().finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.sync().catch(() => {}); }
    });
    return this.running;
  }

  async _run() {
    const s = this.state;
    const key = this._vaultKey();
    if (!key) { s.needs = 'signin'; this._save(); return null; }
    if ((s.pullVersion || 1) < PULL_VERSION) { s.seq = 0; s.pullVersion = PULL_VERSION; }
    const changed = new Set();
    const stats = { pulled: 0, pushed: 0, conflicts: 0 };
    try {
      /* ---- pull ---- */
      for (let page = 0; page < 200; page++) {
        const r = await this._api('pull', { since: s.seq || 0, limit: 500 });
        if (r.keyVersion !== s.keyVersion) { s.needs = 'passphrase'; throw Object.assign(new Error('The vault passphrase was changed on another device. Connect again with the new passphrase.'), { code: 'key_changed' }); }
        for (const it of r.items) this._incoming(it, key, changed, stats);
        s.seq = Math.max(s.seq || 0, r.items.length ? r.items[r.items.length - 1].seq : r.seq);
        if (!r.more) { s.seq = Math.max(s.seq, r.seq); break; }
      }

      /* ---- push ---- */
      for (let round = 0; round < 3; round++) {
        const names = Object.keys(s.pending);
        if (!names.length) break;
        let retry = false;
        for (let i = 0; i < names.length; i += 200) {
          const batch = names.slice(i, i + 200).map(name => {
            const p = s.pending[name];
            const id = this._idOf(name, key);
            return { name, t: p.t, id, base: (s.known[name] && s.known[name].seq) || 0, data: seal(key, Buffer.from(JSON.stringify({ k: name, t: p.t, d: p.d })), id) };
          });
          const r = await this._api('push', { keyVersion: s.keyVersion, items: batch.map(({ id, base, data }) => ({ id, base, data })) });
          r.results.forEach((res, j) => {
            const sent = batch[j];
            if (res.ok) {
              s.known[sent.name] = { id: sent.id, seq: res.seq, t: sent.t };
              if (s.pending[sent.name] && s.pending[sent.name].t === sent.t) delete s.pending[sent.name];
              stats.pushed++;
            } else if (res.conflict) {
              stats.conflicts++;
              const before = s.pending[sent.name];
              this._incoming(res.server, key, changed, stats);
              if (s.pending[sent.name] && s.pending[sent.name] === before) retry = true;   // ours is newer: push again on the server's version
            }
          });
          s.seq = Math.max(s.seq || 0, r.seq || 0);
        }
        if (!retry) break;
      }
      s.lastSync = Date.now();
      s.lastError = null;
      s.needs = null;
    } catch (e) {
      s.lastError = e.message;
      if (e.status === 401) { s.needs = 'signin'; }
      this._save();
      throw e;
    } finally {
      this._save();
    }
    if (changed.size) this.onApplied(changed, stats);
    return stats;
  }

  /** One item from the server (pull, or the server's copy in a conflict). */
  _incoming(it, key, changed, stats) {
    const s = this.state;
    if (it.deleted || !it.data) return;           // Seal IPTV never deletes server items; removals are records
    let rec;
    try { rec = JSON.parse(unseal(key, it.data, it.id).toString('utf8')); } catch { return; }
    if (!rec || typeof rec.k !== 'string' || !TYPES.includes(typeOf(rec.k)) || this._idOf(rec.k, key) !== it.id) return;
    const mine = s.pending[rec.k];
    const known = s.known[rec.k];
    if (known && known.seq >= it.seq) return;     // already have it
    s.known[rec.k] = { id: it.id, seq: it.seq, t: rec.t };
    if (mine && mine.t > rec.t) return;           // ours is newer and will be pushed (on top of this version)
    if (mine) delete s.pending[rec.k];
    changed.add(this._apply(rec.k, rec.d));
    stats.pulled++;
  }

  /* =================================================================
   * 6. CONNECT / DISCONNECT / DEVICES / DELETE VAULT
   * ================================================================= */
  async probe(serverInput) {
    const server = normalizeServer(serverInput);
    const r = await this._api('ping', null, { server, auth: false, timeout: 15000 });
    if (r.app !== 'seal-iptv-sync') throw new Error('There\'s no Seal IPTV Sync Server at that address.');
    if (r.api > API_VERSION) throw new Error('This server is newer than this Seal IPTV. Update Seal IPTV first.');
    return { server, vault: !!r.vault, setupOpen: !!r.setupOpen };
  }

  /**
   * Create the vault (create = true, needs setupCode) or sign in to it.
   * Then the first sync: the vault's records come in, playlists that are
   * the same as one here are joined, and this PC's data goes up.
   */
  async connect({ server: serverInput, username, passphrase, create = false, setupCode = '', deviceName }) {
    const server = normalizeServer(serverInput);
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._@+-]{3,64}$/.test(username)) throw new Error('Usernames are 3–64 characters: letters, numbers and . _ @ + -');
    if (!passphrase || passphrase.length < 10) throw new Error('Use a vault passphrase of at least 10 characters.');
    deviceName = String(deviceName || os.hostname() || 'Seal IPTV').slice(0, 64);

    let vaultKey, r;
    if (create) {
      const { authKey, wrapKey } = await deriveKeys(passphrase, username);
      vaultKey = crypto.randomBytes(32);
      r = await this._api('setup', { setupCode, username, authKey, kdf: DEFAULT_KDF, wrappedKey: seal(wrapKey, vaultKey, WRAP_AAD), deviceName }, { server, auth: false });
    } else {
      const pre = await this._api('prelogin', { username }, { server, auth: false });
      const { authKey, wrapKey } = await deriveKeys(passphrase, username, pre.kdf);
      r = await this._api('login', { username, authKey, deviceName }, { server, auth: false });
      try { vaultKey = unseal(wrapKey, r.wrappedKey, WRAP_AAD); } catch { throw new Error('The vault key couldn\'t be opened with that passphrase.'); }
    }
    this.state = {
      server, username, deviceId: r.deviceId, deviceName,
      token: this._protect(Buffer.from(r.token, 'utf8')), vaultKey: this._protect(vaultKey),
      keyVersion: r.keyVersion || 1, seq: 0, pullVersion: PULL_VERSION, known: {}, pending: {}, lastSync: null, lastError: null, needs: null
    };
    this._save();
    // 1. what's in the vault already
    await this.sync();
    // 2. the same playlist set up here and elsewhere: keep one (the vault's), with both libraries
    const joined = this.joinDuplicates();
    // 3. everything here goes up (older than the vault's records, so the vault wins on settings)
    this.snapshot();
    await this.sync();
    return { ...this.status(), joined };
  }

  /** Same provider + login (or same M3U) under two ids: move ours into the vault's. */
  joinDuplicates() {
    const ident = p => (p.type === 'xtream' ? `x|${p.server}|${p.username}`.toLowerCase() : `m|${p.m3uUrl || p.m3uFile}`.toLowerCase());
    const fromVault = new Set(Object.keys(this.state.known).filter(k => k.startsWith('profile:')).map(k => k.slice(8)));
    const profiles = this.store.listProfiles();
    const joined = [];
    for (const mine of profiles.filter(p => !fromVault.has(p.id))) {
      const twin = profiles.find(p => fromVault.has(p.id) && ident(p) === ident(mine));
      if (!twin) continue;
      this.library.mergeInto(mine.id, twin.id);
      this.applying = true;
      try { this.store.deleteProfile(mine.id); } finally { this.applying = false; }
      if (this.store.getSettings().activeProfile == null || this.store.getSettings().activeProfile === mine.id) this.store.setSettings({ activeProfile: twin.id });
      this.onProfileJoined(mine.id, twin.id);
      joined.push(twin.name);
    }
    return joined;
  }

  async disconnect({ signOut = true } = {}) {
    if (this.state && signOut) { try { await this._api('logout', {}, { timeout: 10000 }); } catch { /* offline: forget anyway */ } }
    this.state = null;
    this._save();
  }

  async devices() { return (await this._api('devices', {})).devices; }
  async revoke(id) { return (await this._api('revoke', { id })).removed; }

  /** Delete the whole vault on the server (this PC keeps its data). */
  async destroy(passphrase) {
    const pre = await this._api('prelogin', { username: this.state.username }, { auth: false });
    const { authKey } = await deriveKeys(passphrase, this.state.username, pre.kdf);
    await this._api('destroy', { authKey });
    this.state = null;
    this._save();
  }
}

module.exports = { SyncService, normalizeServer, deriveKeys, seal, unseal };
