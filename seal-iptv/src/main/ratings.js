/* =====================================================================
 * Seal IPTV — ratings.js   (US age ratings: R, PG-13, TV-MA …)
 * ---------------------------------------------------------------------
 * The rating badge on posters and the movie / series pages. Providers'
 * lists don't carry one; some send it in a movie's details (xtream.js
 * cert, read through usRating here). The rest come from TMDB by title
 * (and year) — the key from Settings → Home page & posters:
 *   movies  /search/movie -> /movie/<id>/release_dates   US certification
 *           (theatrical first, then any US release that has one)
 *   series  /search/tv    -> /tv/<id>/content_ratings     US rating
 * Like artwork.js: only the cleaned-up title and year are sent, nothing
 * while the VPN guard blocks the network, one request at a time to TMDB.
 * Answers are kept in ratings.json: found 60 days, not found 14 days
 * (asked again at once when a TMDB key is added).
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const { cleanTitle, norm } = require('./artwork');

// the US systems: MPA (films) and TV Parental Guidelines; anything else from a provider is ignored
const US = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
/** a provider's or site's text -> one of US, or '' ("Rated R", "pg-13", "TV-MA " …) */
function usRating(s) {
  const t = String(s || '').trim().toUpperCase().replace(/^RATED\s+/, '').replace(/\s+/g, '').replace(/^TV(?=[YGPM1])/, 'TV-').replace(/^PG13$/, 'PG-13').replace(/^NC17$/, 'NC-17');
  if (t === 'UNRATED' || t === 'NOTRATED') return 'NR';
  return US.includes(t) ? t : '';
}

const HIT_DAYS = 60, MISS_DAYS = 14, DAY = 86400000;
const MAX_KEPT = 30000;

class Ratings {
  /**
   * @param o.dir          data folder (ratings.json)
   * @param o.getSettings  () => settings (artwork.tmdbKey)
   * @param o.allowed      () => may the network be used now (the VPN guard)
   * @param o.userAgent    () => User-Agent
   * @param o.fetch        fetch implementation (tests pass a fake)
   */
  constructor({ dir, getSettings, allowed, userAgent, fetch: fetchImpl }) {
    this.file = path.join(dir, 'ratings.json');
    this.getSettings = getSettings;
    this.allowed = allowed || (() => true);
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.items = null;
    this.pending = new Map();
    this.lane = Promise.resolve();
    this.timer = null;
  }

  _load() {
    if (this.items) return this.items;
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || {}; } catch { this.items = {}; }
    return this.items;
  }
  _changed() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 2000); }
  flush() {
    clearTimeout(this.timer);
    if (!this.items) return;
    const keys = Object.keys(this.items);
    if (keys.length > MAX_KEPT) for (const k of keys.slice(0, keys.length - MAX_KEPT)) delete this.items[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, items: this.items }));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  /**
   * list: [{ kind: 'movie' | 'series', name, year }] -> ['R' | 'TV-MA' | '' …] (same order), at most 60.
   * Kept answers come back even without a key or while the VPN guard blocks; new ones need both.
   */
  async find(list) {
    const items = (Array.isArray(list) ? list : []).slice(0, 60);
    const key = ((this.getSettings().artwork || {}).tmdbKey || '').replace(/\s+/g, '');
    const online = !!key && this.allowed();
    return Promise.all(items.map(q => this.one(q, key, online).catch(() => '')));
  }

  async one(q, tmdbKey, online) {
    const kind = q && q.kind === 'movie' ? 'movie' : 'series';
    const { title, year } = cleanTitle(q && q.name, q && q.year);
    if (title.length < 2) return '';
    const k = `${kind}|${norm(title)}|${year || ''}`;
    const items = this._load();
    const c = items[k];
    if (c && (c.r ? Date.now() - c.t < HIT_DAYS * DAY : Date.now() - c.t < MISS_DAYS * DAY && (c.k || !tmdbKey))) return c.r || '';
    if (!online) return c ? c.r || '' : '';
    if (this.pending.has(k)) return this.pending.get(k);
    const job = (async () => {
      const r = kind === 'movie' ? await this.movie(title, year, tmdbKey) : await this.tv(title, year, tmdbKey);
      items[k] = { r, t: Date.now(), k: 1 };
      this._changed();
      return r;
    })().finally(() => this.pending.delete(k));
    this.pending.set(k, job);
    return job;
  }

  /* ---- TMDB ---- */
  async _get(pathAndQuery, key) {
    const bearer = !/^[0-9a-f]{32}$/i.test(key);   // a v3 key in the address, a read access token in a header
    const url = 'https://api.themoviedb.org/3' + pathAndQuery + (bearer ? '' : (pathAndQuery.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key));
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = this.lane.then(() => this.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': this.userAgent(), ...(bearer ? { Authorization: 'Bearer ' + key } : {}) }, signal: AbortSignal.timeout(15000) }));
      this.lane = run.catch(() => {}).then(() => new Promise(z => setTimeout(z, 60)));
      const res = await run;
      if (res.status === 429 && attempt === 0) { await new Promise(z => setTimeout(z, 3000)); continue; }
      if (!res.ok) { const e = new Error(`TMDB answered ${res.status}`); e.status = res.status; throw e; }
      return res.json();
    }
    throw new Error('TMDB: too many requests');
  }

  /** the same title (and year within 1, when both have one); else nothing — a wrong film's rating is worse than none */
  _pick(results, title, year, dateField) {
    const want = norm(title);
    const same = (results || []).filter(r => norm(r.title || r.name) === want || norm(r.original_title || r.original_name) === want);
    const y = r => Number(String(r[dateField] || '').slice(0, 4)) || 0;
    if (year) {
      const hit = same.find(r => y(r) && Math.abs(y(r) - year) <= 1);
      if (hit) return hit;
      if (same.length && same.every(r => y(r) && Math.abs(y(r) - year) > 1)) return null;
    }
    return same[0] || null;
  }

  async _search(type, title, year, key) {
    const yp = year ? (type === 'movie' ? '&year=' : '&first_air_date_year=') + year : '';
    const q = `/search/${type}?include_adult=false&query=${encodeURIComponent(title)}`;
    const date = type === 'movie' ? 'release_date' : 'first_air_date';
    let r = await this._get(q + yp, key);
    let best = this._pick(r && r.results, title, year, date);
    if (!best && year) { r = await this._get(q, key); best = this._pick(r && r.results, title, 0, date); }   // the provider's year can be when it was added
    return best;
  }

  async movie(title, year, key) {
    const m = await this._search('movie', title, year, key);
    if (!m) return '';
    const d = await this._get(`/movie/${m.id}/release_dates`, key);
    const us = ((d && d.results) || []).find(x => x.iso_3166_1 === 'US');
    const dates = ((us && us.release_dates) || []).filter(x => usRating(x.certification));
    // 3 = theatrical, 2 = limited, then digital / physical / TV
    const order = [3, 2, 4, 5, 6, 1];
    dates.sort((a, b) => (order.indexOf(a.type) + 1 || 9) - (order.indexOf(b.type) + 1 || 9));
    return dates.length ? usRating(dates[0].certification) : '';
  }

  async tv(title, year, key) {
    const s = await this._search('tv', title, year, key);
    if (!s) return '';
    const d = await this._get(`/tv/${s.id}/content_ratings`, key);
    const us = ((d && d.results) || []).find(x => x.iso_3166_1 === 'US');
    return us ? usRating(us.rating) : '';
  }
}

module.exports = { Ratings, usRating, US };
