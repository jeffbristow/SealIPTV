/* =====================================================================
 * Seal IPTV — store.js
 * ---------------------------------------------------------------------
 * Settings and playlists (profiles), in seal-iptv.json in the app's data
 * folder. Passwords are encrypted with Windows' secure storage
 * (Electron safeStorage) when it's available.
 *
 * A profile is one IPTV source:
 *   { id, name, type: 'xtream', server, username, password, liveFormat }
 *   { id, name, type: 'm3u', m3uUrl | m3uFile, liveFormat }
 *
 * Sections:
 *   1. Defaults
 *   2. Load / save
 *   3. Settings
 *   4. Profiles
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* =================================================================
 * 1. DEFAULTS
 * ================================================================= */
const DEFAULTS = {
  activeProfile: null,
  vpn: {
    required: false,        // only contact the provider while the VPN is confirmed
    provider: 'proton',     // 'proton' | 'other'
    adapter: '',            // '' = find it automatically
    homeIp: '',             // 'other': your IP without the VPN (blocked if seen)
    ispMatch: ''            // 'other': the VPN's network name must contain this
  },
  playback: {
    autoWatched: true,      // mark movies / episodes as watched near the end
    watchedPercent: 90,
    autoNext: true,         // play the next episode after a countdown
    resume: 'ask',          // 'ask' | 'always' | 'never'
    externalPlayer: '',     // '' = find VLC
    // audio/video sync in ms (> 0: the picture waits for late sound, e.g. Bluetooth;
    // < 0: the sound waits). Per audio output device; def = when Windows gives no name.
    avSync: { def: 0, devices: {} }
  },
  network: {
    userAgent: 'seal',      // 'seal' | 'vlc' | 'custom'
    customUserAgent: ''
  },
  catalog: {
    refreshHours: 12        // reload the playlist when it's older than this (0 = only by hand)
  },
  // parental controls (parental.js). pinHash / pinSalt never leave the main process.
  parental: {
    pinHash: '', pinSalt: '',
    autoAdult: true,        // lock every category with "Adult" (XXX, 18+) in its name
    unlockMinutes: 0        // after the PIN: 0 = until Seal IPTV closes, else minutes
  },
  content: {
    hideNonEnglish: false   // hide categories / titles that look like another language (language.js)
  },
  // posters the provider doesn't have, looked up by title (artwork.js)
  artwork: {
    lookup: true,           // TVmaze for series (no key needed)
    tmdbKey: ''             // TMDB API key (v3) or read access token: movies too
  },
  updates: {
    check: true             // look for a new version on GitHub when the app starts (updater.js)
  },
  // how Favorites are listed, per kind: 'added' (newest first) | 'name' (A–Z) | 'custom'
  favorites: { live: 'added', movie: 'added', series: 'added' }
};
const FAV_SORTS = ['added', 'name', 'custom'];

const LIVE_FORMATS = ['auto', 'm3u8', 'ts'];
/* Settings that sync between PCs (sync.js), by group. The rest is per PC
   (playlist in use, VPN adapter / home IP / network name, VLC location). */
const SYNC_GROUPS = {
  playback: ['autoWatched', 'watchedPercent', 'autoNext', 'resume', 'avSync'],
  network: ['userAgent', 'customUserAgent'],
  catalog: ['refreshHours'],
  content: ['hideNonEnglish'],
  artwork: ['lookup', 'tmdbKey'],
  favorites: ['live', 'movie', 'series'],
  vpn: ['required', 'provider'],
  parental: ['pinHash', 'pinSalt', 'autoAdult', 'unlockMinutes']
};
const clone = o => JSON.parse(JSON.stringify(o));

class Store {
  /**
   * @param dir     the app's data folder
   * @param secure  { available(), encrypt(string) -> string, decrypt(string) -> string }
   */
  constructor(dir, secure) {
    this.dir = dir;
    this.secure = secure || null;
    this.file = path.join(dir, 'seal-iptv.json');
    this.data = this._load();
    this.onChange = null;          // (record name, data | null) — sync.js listens
  }

  _emit(name, d) { if (this.onChange) this.onChange(name, d); }

  /* =================================================================
   * 2. LOAD / SAVE
   * ================================================================= */
  _load() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first start */ }
    const settings = clone(DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
      if (d.settings && d.settings[k] !== undefined) {
        settings[k] = typeof DEFAULTS[k] === 'object' && DEFAULTS[k] ? { ...DEFAULTS[k], ...d.settings[k] } : d.settings[k];
      }
    }
    return { settings, profiles: Array.isArray(d.profiles) ? d.profiles : [] };
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _protect(plain) {
    if (!plain) return '';
    if (this.secure && this.secure.available()) return 'enc:' + this.secure.encrypt(plain);
    return 'plain:' + plain;
  }

  _unprotect(stored) {
    if (!stored) return '';
    if (stored.startsWith('plain:')) return stored.slice(6);
    if (stored.startsWith('enc:') && this.secure) {
      try { return this.secure.decrypt(stored.slice(4)); } catch { return ''; }
    }
    return '';
  }

  /* =================================================================
   * 3. SETTINGS
   * ================================================================= */
  /** For the window: everything except the PIN hash (hasPin instead). */
  getSettings() {
    const s = clone(this.data.settings);
    s.parental = { autoAdult: s.parental.autoAdult !== false, unlockMinutes: s.parental.unlockMinutes || 0, hasPin: !!s.parental.pinHash };
    return s;
  }

  /** parental.js only. */
  getParental() { return clone(this.data.settings.parental); }
  setParental(patch) {
    const p = this.data.settings.parental;
    for (const k of ['pinHash', 'pinSalt']) if (typeof patch[k] === 'string') p[k] = patch[k];
    if (typeof patch.autoAdult === 'boolean') p.autoAdult = patch.autoAdult;
    if (Number.isFinite(patch.unlockMinutes)) p.unlockMinutes = patch.unlockMinutes;
    this._save();
    this._emit('settings:parental', this.syncSettings().parental);
  }

  /* ---- sync (sync.js) ---- */
  /** The synced settings, by group. */
  syncSettings() {
    const s = this.data.settings, out = {};
    for (const [g, keys] of Object.entries(SYNC_GROUPS)) { out[g] = {}; for (const k of keys) if (s[g] && s[g][k] !== undefined) out[g][k] = clone(s[g][k]); }
    return out;
  }

  /** A settings group from another PC. */
  applySettings(group, d) {
    if (!d || !SYNC_GROUPS[group]) return;
    if (group === 'parental') {
      const p = this.data.settings.parental;
      if (typeof d.pinHash === 'string' && /^([0-9a-f]{64})?$/.test(d.pinHash)) p.pinHash = d.pinHash;
      if (typeof d.pinSalt === 'string' && /^([0-9a-f]{32})?$/.test(d.pinSalt)) p.pinSalt = d.pinSalt;
      if (typeof d.autoAdult === 'boolean') p.autoAdult = d.autoAdult;
      if ([0, 15, 60, 240].includes(d.unlockMinutes)) p.unlockMinutes = d.unlockMinutes;
      return this._save();
    }
    const patch = {};
    for (const k of SYNC_GROUPS[group]) if (k !== 'avSync' && d[k] !== undefined) patch[k] = d[k];
    this.setSettings({ [group]: patch });
    if (group === 'playback' && d.avSync && typeof d.avSync === 'object') {
      const devices = {};
      for (const [n, v] of Object.entries(d.avSync.devices || {}).slice(0, 30)) if (Number.isFinite(v)) devices[String(n).slice(0, 120)] = Math.max(-500, Math.min(1000, Math.round(v)));
      this.data.settings.playback.avSync = { def: Number.isFinite(d.avSync.def) ? Math.max(-500, Math.min(1000, d.avSync.def)) : 0, devices };
      this._save();
    }
  }

  /** A playlist as it syncs: everything, with the password in plain text (the vault encrypts it). */
  syncProfile(id) {
    const p = this.getProfile(id);
    const out = { ...p };
    if (p.type !== 'xtream') delete out.password;
    return out;
  }

  /** A playlist from another PC (same id). */
  applyProfile(d) {
    if (!d || !d.id) return;
    try { this.saveProfile(d); } catch { /* a broken record is ignored */ }
  }

  /** Merges known keys only; values are checked. */
  setSettings(patch) {
    const before = this.onChange ? JSON.stringify(this.syncSettings()) : '';
    const out = this._setSettings(patch);
    if (this.onChange) {
      const was = JSON.parse(before), now = this.syncSettings();
      for (const g of Object.keys(now)) if (JSON.stringify(was[g]) !== JSON.stringify(now[g])) this._emit('settings:' + g, now[g]);
    }
    return out;
  }

  _setSettings(patch) {
    const s = this.data.settings;
    patch = patch || {};
    if ('activeProfile' in patch) s.activeProfile = patch.activeProfile ? String(patch.activeProfile) : null;
    if (patch.vpn) {
      const v = patch.vpn;
      if (typeof v.required === 'boolean') s.vpn.required = v.required;
      if (['proton', 'other'].includes(v.provider)) s.vpn.provider = v.provider;
      if (typeof v.adapter === 'string') s.vpn.adapter = v.adapter.trim().slice(0, 200);
      if (typeof v.homeIp === 'string') s.vpn.homeIp = v.homeIp.trim().slice(0, 64);
      if (typeof v.ispMatch === 'string') s.vpn.ispMatch = v.ispMatch.trim().slice(0, 100);
    }
    if (patch.playback) {
      const p = patch.playback;
      if (typeof p.autoWatched === 'boolean') s.playback.autoWatched = p.autoWatched;
      if (Number.isFinite(Number(p.watchedPercent))) s.playback.watchedPercent = Math.min(99, Math.max(50, Math.round(Number(p.watchedPercent))));
      if (typeof p.autoNext === 'boolean') s.playback.autoNext = p.autoNext;
      if (['ask', 'always', 'never'].includes(p.resume)) s.playback.resume = p.resume;
      if (typeof p.externalPlayer === 'string') s.playback.externalPlayer = p.externalPlayer.trim();
      if (p.avSync && typeof p.avSync === 'object') {
        const a = s.playback.avSync = { def: 0, devices: {}, ...(s.playback.avSync || {}) };
        a.devices = { ...a.devices };
        const name = typeof p.avSync.device === 'string' ? p.avSync.device.trim().slice(0, 120) : '';
        if (p.avSync.forget && name) delete a.devices[name];
        else if (Number.isFinite(Number(p.avSync.ms))) {
          const ms = Math.max(-500, Math.min(1000, Math.round(Number(p.avSync.ms) / 10) * 10));
          if (name) a.devices[name] = ms; else a.def = ms;
          const names = Object.keys(a.devices);
          if (names.length > 30) delete a.devices[names[0]];
        }
      }
    }
    if (patch.network) {
      const n = patch.network;
      if (['seal', 'vlc', 'custom'].includes(n.userAgent)) s.network.userAgent = n.userAgent;
      if (typeof n.customUserAgent === 'string') s.network.customUserAgent = n.customUserAgent.trim().slice(0, 300);
    }
    if (patch.content && typeof patch.content.hideNonEnglish === 'boolean') s.content.hideNonEnglish = patch.content.hideNonEnglish;
    if (patch.artwork) {
      const a = patch.artwork;
      if (typeof a.lookup === 'boolean') s.artwork.lookup = a.lookup;
      if (typeof a.tmdbKey === 'string') s.artwork.tmdbKey = a.tmdbKey.replace(/\s+/g, '').slice(0, 400);
    }
    if (patch.updates && typeof patch.updates.check === 'boolean') s.updates.check = patch.updates.check;
    if (patch.favorites) for (const k of ['live', 'movie', 'series']) if (FAV_SORTS.includes(patch.favorites[k])) s.favorites[k] = patch.favorites[k];
    // patch.parental is ignored on purpose: that goes through parental.js (needs the PIN)
    if (patch.catalog && Number.isFinite(Number(patch.catalog.refreshHours))) {
      s.catalog.refreshHours = Math.min(168, Math.max(0, Math.round(Number(patch.catalog.refreshHours))));
    }
    this._save();
    return this.getSettings();
  }

  /* =================================================================
   * 4. PROFILES
   * ================================================================= */
  /** For the window: no passwords. */
  listProfiles() {
    return this.data.profiles.map(({ password, ...p }) => ({ ...p, hasPassword: !!password }));
  }

  /** Full profile with the password — main process only. */
  getProfile(id) {
    const p = this.data.profiles.find(x => x.id === id);
    if (!p) throw new Error('Playlist not found');
    return { ...p, password: this._unprotect(p.password) };
  }

  /** Checks a profile from the form; throws with a message for the user. Returns the clean record (plain password). */
  static cleanProfile(p, existing) {
    const type = p.type === 'm3u' ? 'm3u' : 'xtream';
    const out = {
      id: (existing && existing.id) || p.id || crypto.randomUUID(),
      type,
      name: String(p.name || '').trim().slice(0, 80),
      liveFormat: LIVE_FORMATS.includes(p.liveFormat) ? p.liveFormat : 'auto'
    };
    if (type === 'xtream') {
      out.server = Store.normalizeServer(p.server);
      out.username = String(p.username || '').trim();
      out.password = String(p.password || '');
      if (!out.username) throw new Error('Enter the username.');
      if (!out.password && !(existing && existing.password)) throw new Error('Enter the password.');
      if (!out.name) out.name = new URL(out.server).hostname;
    } else {
      const url = String(p.m3uUrl || '').trim();
      const file = String(p.m3uFile || '').trim();
      if (url) {
        let u;
        try { u = new URL(url); } catch { throw new Error('The playlist link isn\'t a web address.'); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('The playlist link must start with http:// or https://');
        out.m3uUrl = u.href;
        if (!out.name) out.name = u.hostname;
      } else if (file) {
        out.m3uFile = file;
        if (!out.name) out.name = path.basename(file).replace(/\.m3u8?$/i, '');
      } else {
        throw new Error('Enter the playlist link or choose a playlist file.');
      }
    }
    return out;
  }

  /** "provider.com:8080/player_api.php?…" -> "http://provider.com:8080" */
  static normalizeServer(input) {
    let s = String(input || '').trim();
    if (!s) throw new Error('Enter the server address.');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try { u = new URL(s); } catch { throw new Error('The server address isn\'t valid.'); }
    let p = u.pathname.replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '').replace(/\/+$/, '');
    return u.protocol + '//' + u.host + p;
  }

  saveProfile(p) {
    const existing = p.id ? this.data.profiles.find(x => x.id === p.id) : null;
    const clean = Store.cleanProfile(p, existing);
    const record = { ...clean, password: clean.password ? this._protect(clean.password) : (existing ? existing.password || '' : '') };
    if (clean.type === 'm3u') delete record.password;
    if (existing) {
      for (const k of Object.keys(existing)) delete existing[k];
      Object.assign(existing, record);
    } else {
      this.data.profiles.push(record);
    }
    if (!this.data.settings.activeProfile) this.data.settings.activeProfile = record.id;
    this._save();
    this._emit('profile:' + record.id, this.syncProfile(record.id));
    return this.listProfiles().find(x => x.id === record.id);
  }

  deleteProfile(id) {
    this.data.profiles = this.data.profiles.filter(x => x.id !== id);
    if (this.data.settings.activeProfile === id) this.data.settings.activeProfile = this.data.profiles[0] ? this.data.profiles[0].id : null;
    this._save();
    this._emit('profile:' + id, null);
  }
}

module.exports = { Store, DEFAULTS, SYNC_GROUPS };
