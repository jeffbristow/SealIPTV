/* =====================================================================
 * Seal IPTV — artwork.js   (posters the provider doesn't have)
 * ---------------------------------------------------------------------
 * Many providers leave a series' or movie's picture empty, or link to one
 * that's gone. This finds one by title:
 *   series  TVmaze (free, no key) — then TMDB when a key is set
 *   movies  TMDB (needs a free API key: themoviedb.org → Settings → API)
 * Only the cleaned-up title (and year) is sent — never the provider, the
 * login or anything about you. Nothing is looked up while the VPN guard
 * blocks the network, or when "Fill in missing posters" is off.
 *
 * Answers are kept in artwork.json (found: kept; not found: asked again
 * after 14 days), so each title is looked up once.
 *
 * Sections:
 *   1. Titles: "EN | Breaking Bad (2008) [4K]" -> "Breaking Bad", 2008
 *   2. The cache file
 *   3. Looking up (TVmaze, TMDB), one request at a time per site
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

/* =================================================================
 * 1. TITLES
 * ================================================================= */
// provider tags in front: "EN - ", "|US| ", "[4K] ", "FHD: " (same idea as catalog.js)
const FRONT_RE = /^(?:\[[^\]]{1,12}\]\s*|\|[^|]{1,12}\|\s*|(?:[A-Z]{2,3}|4K|8K|HD|FHD|UHD)\s*(?:[:|]|\s-)\s*)+/;
const YEAR_RE = /[([]\s*((?:19|20)\d{2})\s*[)\]]|\s-\s*((?:19|20)\d{2})\s*$|\s((?:19|20)\d{2})\s*$/;
// quality / language / season words at the end
const TAIL_RE = /(?:\s*[-|:]?\s*(?:\b(?:4K|8K|UHD|FHD|HD|SD|HEVC|H\.?265|x265|HDR|MULTI(?:-?SUBS?)?|SUBS?|DUAL|VOSTFR|DUBBED|EN|ENG|US|UK)\b|\bS\d{1,2}(?:\s*E\d{1,3})?\b|\bSeason\s*\d+\b))+\s*$/i;

/** -> { title, year } for searching; title '' when nothing is left. */
function cleanTitle(name, year) {
  let t = String(name || '').replace(FRONT_RE, '');
  let y = Number(year) || 0;
  const m = t.match(YEAR_RE);
  if (m) { y = y || Number(m[1] || m[2] || m[3]); t = t.replace(YEAR_RE, ' '); }
  t = t.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');       // [MULTI-SUB] {web}
  for (let i = 0; i < 3; i++) t = t.replace(TAIL_RE, '');
  t = t.replace(/[\s._|:-]+$/g, '').replace(/^[\s._|:-]+/g, '').replace(/\s+/g, ' ').trim();
  return { title: t, year: y };
}

/** for comparing names: lower case, letters and digits only, "&" = "and" */
const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

/** the best of a site's answers: same name (and year, when both have one), else none */
function pick(results, title, year) {
  const want = norm(title);
  if (!want) return null;
  const same = results.filter(r => r.img && (norm(r.name) === want || (r.alt && norm(r.alt) === want)));
  if (year) {
    const y = same.find(r => r.year && Math.abs(r.year - year) <= 1);
    if (y) return y;
    if (same.length && same.every(r => r.year && Math.abs(r.year - year) > 1)) return null;   // same name, another show
  }
  return same[0] || null;
}

/* =================================================================
 * 2. THE CACHE FILE
 * ================================================================= */
const MISS_DAYS = 14;
const DAY = 86400000;

class Artwork {
  /**
   * @param o.dir          data folder (artwork.json)
   * @param o.getSettings  () => settings (artwork.lookup, artwork.tmdbKey)
   * @param o.allowed      () => may the network be used now (the VPN guard)
   * @param o.userAgent    () => User-Agent for the look-ups
   * @param o.fetch        fetch implementation (tests pass a fake)
   */
  constructor({ dir, getSettings, allowed, userAgent, fetch: fetchImpl }) {
    this.file = path.join(dir, 'artwork.json');
    this.getSettings = getSettings;
    this.allowed = allowed || (() => true);
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.items = null;
    this.pending = new Map();
    this.lanes = { tvmaze: Promise.resolve(), tmdb: Promise.resolve() };
    this.timer = null;
  }

  _load() {
    if (this.items) return this.items;
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || {}; } catch { this.items = {}; }
    return this.items;
  }

  _changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.items) return;
    const keys = Object.keys(this.items);
    if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete this.items[k];   // oldest first
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, items: this.items }));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  /** Forget everything found (Settings → "Look up again"). */
  clear() { this.items = {}; this.flush(); }

  /* =================================================================
   * 3. LOOKING UP
   * ================================================================= */
  /**
   * list: [{ kind: 'movie' | 'series', name, year }] -> [url | null] (same order).
   * At most 60 at a time; the window asks for what's on screen.
   */
  async find(list) {
    const a = this.getSettings().artwork || {};
    const items = (Array.isArray(list) ? list : []).slice(0, 60);
    if (!a.lookup || !this.allowed()) return items.map(() => null);
    return Promise.all(items.map(q => this.one(q, a.tmdbKey || '').catch(() => null)));
  }

  async one(q, tmdbKey) {
    const kind = q && ['movie', 'collection'].includes(q.kind) ? q.kind : 'series';
    const { title, year } = kind === 'collection' ? { title: String(q.name || '').trim(), year: 0 } : cleanTitle(q && q.name, q && q.year);
    if (title.length < 2) return null;
    const key = `${kind}|${norm(title)}|${year || ''}`;
    const items = this._load();
    const c = items[key];
    if (c && c.u) return c.u;
    // a miss is asked again after 14 days, or straight away once there's a TMDB key it didn't have
    if (c && Date.now() - c.t < MISS_DAYS * DAY && (c.k || !tmdbKey)) return null;
    if (kind !== 'series' && !tmdbKey) return null;
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      let url = null;
      if (kind === 'series') url = await this.tvmaze(title, year);
      if (!url && tmdbKey) url = kind === 'collection' ? await this.tmdbCollection(title, tmdbKey) : await this.tmdb(kind === 'movie' ? 'movie' : 'tv', title, year, tmdbKey);
      items[key] = url ? { u: url, t: Date.now() } : { u: '', t: Date.now(), k: tmdbKey ? 1 : 0 };
      this._changed();
      return url;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  /** One request at a time per site, with a gap (TVmaze allows ~20 per 10 s). */
  _queue(lane, gapMs, fn) {
    const run = this.lanes[lane].then(fn);
    this.lanes[lane] = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, gapMs)));
    return run;
  }

  async _json(lane, gap, url, headers = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this._queue(lane, gap, () => this.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': this.userAgent(), ...headers }, signal: AbortSignal.timeout(15000) }));
      if (res.status === 429 && attempt === 0) { await new Promise(r => setTimeout(r, 3000)); continue; }
      if (!res.ok) { const e = new Error(`${lane} answered ${res.status}`); e.status = res.status; throw e; }
      return res.json();
    }
    throw new Error(`${lane}: too many requests`);
  }

  async tvmaze(title, year) {
    const r = await this._json('tvmaze', 550, 'https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(title));
    const shows = (Array.isArray(r) ? r : []).map(x => x && x.show).filter(Boolean).map(s => ({
      name: s.name, year: Number(String(s.premiered || '').slice(0, 4)) || 0,
      img: s.image && (s.image.medium || s.image.original) ? String(s.image.medium || s.image.original).replace(/^http:/, 'https:') : ''
    }));
    const best = pick(shows, title, year);
    return best ? best.img : null;
  }

  async tmdb(type, title, year, apiKey) {
    // a v3 API key (32 hex) goes in the address, a read access token (long, "eyJ…") in a header
    const bearer = !/^[0-9a-f]{32}$/i.test(apiKey);
    const yearParam = year ? (type === 'movie' ? '&year=' : '&first_air_date_year=') + year : '';
    let url = `https://api.themoviedb.org/3/search/${type}?include_adult=false&query=${encodeURIComponent(title)}${yearParam}`;
    if (!bearer) url += '&api_key=' + encodeURIComponent(apiKey);
    let r;
    try { r = await this._json('tmdb', 60, url, bearer ? { Authorization: 'Bearer ' + apiKey } : {}); }
    catch (e) { if (e.status === 401) { const x = new Error('The TMDB key wasn\'t accepted.'); x.code = 'TMDB_KEY'; throw x; } throw e; }
    let list = (r && Array.isArray(r.results) ? r.results : []).map(m => ({
      name: m.title || m.name, alt: m.original_title || m.original_name,
      year: Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || 0,
      img: m.poster_path ? 'https://image.tmdb.org/t/p/w342' + m.poster_path : ''
    }));
    let best = pick(list, title, year);
    if (!best && year) {
      // the provider's year is sometimes the year it was added: try without it
      r = await this._json('tmdb', 60, url.replace(yearParam, ''), bearer ? { Authorization: 'Bearer ' + apiKey } : {});
      list = (r && Array.isArray(r.results) ? r.results : []).map(m => ({ name: m.title || m.name, alt: m.original_title || m.original_name, year: 0, img: m.poster_path ? 'https://image.tmdb.org/t/p/w342' + m.poster_path : '' }));
      best = pick(list, title, 0);
    }
    return best ? best.img : null;
  }

  /** A collection's poster (Collections: "Star Wars Collection"): the same name, else one whose name has it in. */
  async tmdbCollection(name, apiKey) {
    const bearer = !/^[0-9a-f]{32}$/i.test(apiKey);
    let url = `https://api.themoviedb.org/3/search/collection?query=${encodeURIComponent(name)}`;
    if (!bearer) url += '&api_key=' + encodeURIComponent(apiKey);
    let r;
    try { r = await this._json('tmdb', 60, url, bearer ? { Authorization: 'Bearer ' + apiKey } : {}); }
    catch (e) { if (e.status === 401) { const x = new Error('The TMDB key wasn\'t accepted.'); x.code = 'TMDB_KEY'; throw x; } throw e; }
    const list = (r && Array.isArray(r.results) ? r.results : []).filter(c => c.poster_path);
    const bare = s => norm(String(s || '').replace(/\bcollection\b/gi, ''));
    const want = bare(name);
    const best = list.find(c => bare(c.name) === want) || list.find(c => want && bare(c.name).includes(want));
    return best ? 'https://image.tmdb.org/t/p/w342' + best.poster_path : null;
  }

  /** Settings → "Test key": -> true, or throws with the reason. */
  async testTmdb(apiKey) {
    const key = String(apiKey || '').replace(/\s+/g, '');
    if (!key) throw new Error('Paste your TMDB API key first.');
    await this.tmdb('movie', 'The Matrix', 1999, key);
    return true;
  }
}

module.exports = { Artwork, cleanTitle, pick, norm };
