/* =====================================================================
 * Seal IPTV — studios.js   (the Disney, Netflix and Prime collections)
 * ---------------------------------------------------------------------
 * Their lists of titles come from Wikipedia (tools/studios.js builds them,
 * every week on GitHub). Each release ships a copy (studios.dat here); in
 * between, the newest copy is fetched from GitHub every 3 days, so a film
 * that came out last week is in the collection without an update.
 * Nothing is sent but the request for the file; nothing is fetched while
 * the VPN guard blocks the network.
 *
 * The file (studios.dat) is scrambled, not plain JSON: the titles aren't
 * text a search engine or GitHub's search finds. Only this file reads it
 * (pack / unpack). It isn't a secret — just not lying about in the open.
 *
 * Kept in <data>/studios.dat when it's newer than the one shipped.
 * franchises.js turns them into collections (setStudios).
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const URL_ = 'https://raw.githubusercontent.com/jeffbristow/SealIPTV/main/seal-iptv/src/main/studios.dat';
const EVERY_DAYS = 3;

/* ---- the file: "SIS1:" + base64 of the JSON, each byte mixed with a key ---- */
const MAGIC = 'SIS1:';
const KEY = (() => {
  // 32 bytes from a fixed phrase (a small hash, so the same on Windows and a TV without crypto)
  const out = Buffer.alloc(32);
  let h = 2166136261;
  const phrase = 'Seal IPTV studio collections';
  for (let i = 0; i < 32; i++) { for (const ch of phrase + i) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } out[i] = h & 255; }
  return out;
})();
const mix = buf => { for (let i = 0; i < buf.length; i++) buf[i] ^= KEY[i % 32] ^ (i * 131 & 255); return buf; };
/** data -> the file's text */
function pack(data) { return MAGIC + mix(Buffer.from(JSON.stringify(data), 'utf8')).toString('base64') + '\n'; }
/** the file's text -> data (throws when it isn't one) */
function unpack(text) {
  const t = String(text || '').trim();
  if (!t.startsWith(MAGIC)) throw new Error('studios.dat: not a studio list');
  return JSON.parse(mix(Buffer.from(t.slice(MAGIC.length), 'base64')).toString('utf8'));
}
/** the list shipped with the app: on a TV it's in the page's bundle (build.js), on Windows next to this file */
function shippedList() {
  // eslint-disable-next-line no-undef
  const text = typeof SEAL_TV_BUNDLE !== 'undefined' ? require('./studios.dat') : fs.readFileSync(path.join(__dirname, 'studios.dat'), 'utf8');
  return unpack(text);
}

/** Is it a list we can use? (a broken download never replaces a good one) */
function valid(d) {
  return !!(d && typeof d.built === 'string' && Array.isArray(d.studios) && d.studios.length &&
    d.studios.every(s => s && s.id && s.name && Array.isArray(s.items) && s.items.length >= 50 && s.items.every(e => e && typeof e.t === 'string' && e.y)));
}

class Studios {
  /**
   * @param o.dir        data folder
   * @param o.allowed    () => may the app go online now (the VPN guard)
   * @param o.userAgent  () -> User-Agent string
   * @param o.fetch      fetch implementation
   * @param o.shipped    the copy shipped with the app (tests pass their own)
   */
  constructor({ dir, allowed, userAgent, fetch: fetchImpl, shipped }) {
    this.file = path.join(dir, 'studios.dat');
    this.allowed = allowed || (() => true);
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.shipped = shipped || shippedList();
    this.job = null;
  }

  /** The newest list we have: the one fetched (when newer), else the one shipped. */
  data() {
    if (this._data) return this._data;
    let d = null;
    try { d = unpack(fs.readFileSync(this.file, 'utf8')); } catch { /* none fetched yet */ }
    this._data = valid(d) && d.built > this.shipped.built ? d : this.shipped;
    return this._data;
  }

  due() {
    let at = 0;
    try { at = fs.statSync(this.file).mtimeMs; } catch { /* never fetched */ }
    return Date.now() - at > EVERY_DAYS * 86400000;
  }

  /** Fetch the newest list when it's due. -> the new data when it changed, else null */
  refresh({ force = false } = {}) {
    if (this.job) return this.job;
    if ((!force && !this.due()) || !this.allowed()) return Promise.resolve(null);
    this.job = (async () => {
      const res = await this.fetch(URL_, { headers: { 'User-Agent': this.userAgent(), Accept: 'text/plain' }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('studios.dat: GitHub answered ' + res.status);
      const text = await res.text();
      const d = unpack(text);
      if (!valid(d)) throw new Error('studios.dat: not a list we can use');
      fs.writeFileSync(this.file + '.tmp', text);
      fs.renameSync(this.file + '.tmp', this.file);   // (also marks when it was last asked for)
      const before = this.data();
      this._data = null;
      const now = this.data();
      return now !== before && now.built !== before.built ? now : null;
    })().finally(() => { this.job = null; });
    return this.job;
  }
}

module.exports = { Studios, valid, pack, unpack, URL: URL_ };
