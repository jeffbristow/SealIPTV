/* =====================================================================
 * Seal IPTV — studios.js   (the Disney, Netflix and Prime collections)
 * ---------------------------------------------------------------------
 * Their lists of titles come from Wikipedia (tools/studios.js builds them,
 * every week on GitHub). Each release ships a copy (studios.json here); in
 * between, the newest copy is fetched from GitHub every 3 days, so a film
 * that came out last week is in the collection without an update.
 * Nothing is sent but the request for the file; nothing is fetched while
 * the VPN guard blocks the network.
 *
 * Kept in <data>/studios.json when it's newer than the one shipped.
 * franchises.js turns them into collections (setStudios).
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const URL_ = 'https://raw.githubusercontent.com/jeffbristow/SealIPTV/main/seal-iptv/src/main/studios.json';
const EVERY_DAYS = 3;

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
    this.file = path.join(dir, 'studios.json');
    this.allowed = allowed || (() => true);
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.shipped = shipped || require('./studios.json');
    this.job = null;
  }

  /** The newest list we have: the one fetched (when newer), else the one shipped. */
  data() {
    if (this._data) return this._data;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none fetched yet */ }
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
      const res = await this.fetch(URL_, { headers: { 'User-Agent': this.userAgent(), Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('studios.json: GitHub answered ' + res.status);
      const d = JSON.parse(await res.text());
      if (!valid(d)) throw new Error('studios.json: not a list we can use');
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(d));
      fs.renameSync(this.file + '.tmp', this.file);   // (also marks when it was last asked for)
      const before = this.data();
      this._data = null;
      const now = this.data();
      return now !== before && now.built !== before.built ? now : null;
    })().finally(() => { this.job = null; });
    return this.job;
  }
}

module.exports = { Studios, valid, URL: URL_ };
