/* =====================================================================
 * Seal IPTV — trending.js   (Trending movies / Trending series on Home)
 * ---------------------------------------------------------------------
 * What people are watching on the streaming services, from sources that
 * publish it openly:
 *   Netflix  its own weekly Top 10 (the files on top10.netflix.com):
 *            English films and series
 *   TVmaze   the week's new episodes on Netflix, Disney+, Apple TV, Hulu,
 *            Peacock, Paramount+, Prime Video and HBO Max, by how popular
 *            each show is (no key needed)
 *   TMDB     with the key from Settings → Posters: what's popular on each
 *            of those services in the US now, and the week's trending titles
 * Nothing about you or your provider is sent — these are the same lists
 * for everyone. Kept in trending.json, fetched again after 12 hours
 * (sooner after a failure). catalog.js finds the titles in the playlist.
 *
 * A title: { t, y, kind: 'movie'|'series', score, tags: ['Netflix #1', 'Hulu'] }
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const EVERY_HOURS = 12;
const RETRY_HOURS = 2;
const REGION = 'US';
const KEEP = 60;                // titles kept per kind
const V = 2;                    // trending.json's format (2: titles count by their best place)
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const NETFLIX_TSV = 'https://www.netflix.com/tudum/top10/data/all-weeks-global.tsv';

// the services, as TVmaze and TMDB name them -> the name shown
const SERVICES = [
  ['Netflix', /^netflix$/i],
  ['Disney+', /^disney(\+| plus)$/i],
  ['Apple TV', /^apple tv(\+| plus)?$/i],
  ['Hulu', /^hulu$/i],
  ['Peacock', /^peacock( premium)?$/i],
  ['Paramount+', /^paramount(\+| plus)( premium)?$/i],
  ['Prime Video', /^(amazon )?prime video$/i],
  ['HBO Max', /^(hbo )?max$/i]
];
/** jobs (functions returning promises), n at a time -> their results in order */
async function pool(jobs, n = 4) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } }));
  return out;
}
const serviceOf = name => { const s = SERVICES.find(([, re]) => re.test(String(name || '').trim())); return s ? s[0] : ''; };

/** "The Diplomat: Season 4", "Love & Death" -> a key for matching ("diplomat", "love and death") */
function titleKey(s) {
  return String(s || '').toLowerCase()
    .replace(/^(?:\[[^\]]{1,12}\]\s*|\|[^|]{1,12}\|\s*|(?:[a-z]{2,3}|4k|8k|hd|fhd|uhd)\s*(?:[:|]|\s-)\s*)+/i, '')   // provider tags in front
    .replace(/\(\s*\d{4}\s*\)|\[\s*\d{4}\s*\]/g, ' ')
    .replace(/&/g, ' and ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Netflix's TSV -> the latest week's English Top 10s: { week, movie: [title…], series: [title…] } */
function parseNetflix(text) {
  const rows = String(text).split(/\r?\n/).map(l => l.split('\t'));
  const head = rows[0] || [];
  const col = n => head.indexOf(n);
  const W = col('week'), C = col('category'), R = col('weekly_rank'), T = col('show_title');
  if (W < 0 || C < 0 || T < 0) throw new Error('Netflix Top 10: not the file expected');
  let week = '';
  for (const r of rows) if (/^\d{4}-\d\d-\d\d$/.test(r[W] || '') && r[W] > week) week = r[W];
  const out = { week, movie: [], series: [] };
  for (const r of rows.filter(x => x[W] === week).sort((a, b) => Number(a[R]) - Number(b[R]))) {
    if (r[C] === 'Films (English)') out.movie.push(r[T]);
    else if (r[C] === 'TV (English)') out.series.push(r[T]);
  }
  return out;
}

class Trending {
  /**
   * @param o.dir          data folder (trending.json)
   * @param o.getSettings  () => settings (artwork.trending, artwork.tmdbKey)
   * @param o.allowed      () => may the app go online now (the VPN guard)
   * @param o.userAgent    () -> User-Agent string
   * @param o.fetch        fetch implementation
   */
  constructor({ dir, getSettings, allowed, userAgent, fetch: fetchImpl }) {
    this.file = path.join(dir, 'trending.json');
    this.getSettings = getSettings;
    this.allowed = allowed || (() => true);
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.data = undefined;
    this.job = null;
  }

  on() { const a = (this.getSettings() || {}).artwork || {}; return a.trending !== false; }

  /** The saved lists (memory, else disk), or null. */
  saved() {
    if (this.data !== undefined) return this.data;
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = d && d.v === V ? d : null; } catch { this.data = null; }
    return this.data;
  }

  due() {
    const d = this.saved();
    if (!d) return true;
    return Date.now() - d.at > (d.partial ? RETRY_HOURS : EVERY_HOURS) * 3600000;
  }

  /** The lists: the saved ones, a new copy fetched when due (wait: for the first one). -> data or null */
  async get({ wait = false } = {}) {
    if (!this.on()) return null;
    if (this.due() && this.allowed()) {
      const job = this.refresh();
      if (wait && !this.saved()) { try { await job; } catch { /* none then */ } }
    }
    return this.saved();
  }

  refresh() {
    if (this.job) return this.job;
    this.job = (async () => {
      const key = ((this.getSettings() || {}).artwork || {}).tmdbKey || '';
      const got = await Promise.allSettled([this.netflix(), this.tvmaze(), key ? this.tmdb(key) : Promise.resolve(null)]);
      const [nf, tm, td] = got.map(g => (g.status === 'fulfilled' ? g.value : null));
      const errors = got.filter(g => g.status === 'rejected').map(g => g.reason && g.reason.message);
      if (!nf && !tm && !td) throw new Error('Trending: nothing could be fetched (' + errors.join('; ') + ')');
      const lists = [...(nf || []), ...(tm || []), ...(td || [])];
      const d = { v: V, at: Date.now(), partial: errors.length > 0, sources: { netflix: nf ? nf.week : '', tvmaze: !!tm, tmdb: !!td }, movie: merge(lists, 'movie'), series: merge(lists, 'series') };
      if (key) await this.years(d.movie.concat(d.series), key).catch(() => {});
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(d));
      fs.renameSync(this.file + '.tmp', this.file);
      this.data = d;
      if (typeof console !== 'undefined') console.log(`[seal] trending: ${d.movie.length} movies, ${d.series.length} series${errors.length ? ' (' + errors.join('; ') + ')' : ''}`);
      return d;
    })().finally(() => { this.job = null; });
    return this.job;
  }

  async _get(url, { json = true, headers = {}, timeout = 20000 } = {}) {
    const res = await this.fetch(url, { headers: { Accept: json ? 'application/json' : '*/*', 'User-Agent': this.userAgent(), ...headers }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) { const e = new Error(`${new URL(url).hostname} answered ${res.status}`); e.status = res.status; throw e; }
    return json ? res.json() : res.text();
  }

  /* ---- Netflix: its weekly Top 10 (the file needs a browser's User-Agent, else it comes cut short) ---- */
  async netflix() {
    const text = await this._get(NETFLIX_TSV, { json: false, headers: { 'User-Agent': BROWSER_UA }, timeout: 60000 });
    const n = parseNetflix(text);
    if (!n.movie.length && !n.series.length) throw new Error('Netflix Top 10: no lists');
    const lists = [
      { kind: 'movie', service: 'Netflix', weight: 3, top: true, titles: n.movie.map(t => ({ t })) },
      { kind: 'series', service: 'Netflix', weight: 3, top: true, titles: n.series.map(t => ({ t })) }
    ];
    lists.week = n.week;
    return lists;
  }

  /* ---- TVmaze: the week's new episodes on the services, the most popular shows first ---- */
  async tvmaze() {
    const shows = new Map();
    for (let i = 0; i < 7; i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const list = await this._get('https://api.tvmaze.com/schedule/web?date=' + day);
      for (const e of Array.isArray(list) ? list : []) {
        const s = e && e._embedded && e._embedded.show;
        if (!s || (s.language && s.language !== 'English')) continue;
        const service = serviceOf((s.webChannel || s.network || {}).name);
        if (!service || /^(news|talk show|sports)$/i.test(s.type || '')) continue;
        if (!shows.has(s.id)) shows.set(s.id, { t: s.name, y: Number(String(s.premiered || '').slice(0, 4)) || 0, service, weight: Number(s.weight) || 0 });
      }
      await new Promise(r => setTimeout(r, 300));   // TVmaze: ~20 requests in 10 s
    }
    const by = new Map();
    for (const s of shows.values()) { if (!by.has(s.service)) by.set(s.service, []); by.get(s.service).push(s); }
    return [...by].map(([service, list]) => ({
      kind: 'series', service, weight: 2, titles: list.filter(s => s.weight >= 60).sort((a, b) => b.weight - a.weight).slice(0, 10).map(s => ({ t: s.t, y: s.y, pop: s.weight / 100 }))
    }));
  }

  /* ---- TMDB: popular on each service in the US, and the week's trending (needs the key) ---- */
  _tmdb(pathAndQuery, key) {
    const bearer = !/^[0-9a-f]{32}$/i.test(key);   // a v3 key goes in the address, a read access token in a header
    const url = `https://api.themoviedb.org/3/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}${bearer ? '' : 'api_key=' + encodeURIComponent(key)}`;
    return this._get(url, { headers: bearer ? { Authorization: 'Bearer ' + key } : {} });
  }

  async tmdb(key) {
    const lists = [];
    const res = r => (r && Array.isArray(r.results) ? r.results : []);
    const titleOf = (m, kind) => ({ t: kind === 'movie' ? m.title : m.name, y: Number(String((kind === 'movie' ? m.release_date : m.first_air_date) || '').slice(0, 4)) || 0, tmdb: m.id });
    // the services' ids in TMDB, by name (they're not fixed numbers everywhere)
    const prov = res(await this._tmdb(`watch/providers/movie?watch_region=${REGION}`, key));
    const ids = new Map();
    for (const p of prov) { const s = serviceOf(p.provider_name); if (s && !ids.has(s)) ids.set(s, p.provider_id); }
    // four at a time (one after another took half a minute through a TV's network bridge)
    const asks = [...ids].flatMap(([service, id]) => ['movie', 'series'].map(kind => async () => {
      const r = await this._tmdb(`discover/${kind === 'movie' ? 'movie' : 'tv'}?watch_region=${REGION}&with_watch_providers=${id}&with_watch_monetization_types=flatrate&sort_by=popularity.desc&include_adult=false&page=1`, key).catch(() => null);
      return r && { kind, service, weight: 1.6, titles: res(r).filter(m => (m.original_language || 'en') === 'en').slice(0, 10).map(m => titleOf(m, kind)) };
    }));
    for (const l of await pool(asks)) if (l) lists.push(l);
    for (const kind of ['movie', 'series']) {
      const r = await this._tmdb(`trending/${kind === 'movie' ? 'movie' : 'tv'}/week`, key).catch(() => null);
      if (r) lists.push({ kind, service: '', weight: 1.4, titles: res(r).filter(m => (m.original_language || 'en') === 'en').slice(0, 20).map(m => titleOf(m, kind)) });
    }
    if (!lists.length) throw new Error('TMDB: no lists');
    return lists;
  }

  /** Netflix gives no years: TMDB's best match for those titles (so "Animals" is this year's film, not one from 2019). */
  async years(titles, key) {
    await pool(titles.filter(t => !t.y).slice(0, 30).map(x => async () => {
      const r = await this._tmdb(`search/${x.kind === 'movie' ? 'movie' : 'tv'}?include_adult=false&query=${encodeURIComponent(x.t)}`, key).catch(() => null);
      const hit = (r && Array.isArray(r.results) ? r.results : []).find(m => titleKey(m.title || m.name) === titleKey(x.t));
      const y = hit && Number(String(hit.release_date || hit.first_air_date || '').slice(0, 4));
      if (y) x.y = y;
    }));
  }
}

/**
 * The lists of one kind -> one list, the most-watched first. A title counts by its best
 * place; being on more lists adds a little (an old favourite on five services shouldn't
 * pass Netflix's #1). Tags say where ("Netflix #1", "Hulu").
 */
function merge(lists, kind) {
  const all = new Map();
  for (const l of lists.filter(x => x.kind === kind)) {
    const n = l.titles.length;
    l.titles.forEach((x, i) => {
      const k = titleKey(x.t);
      if (!k) return;
      const pts = l.weight * (1 + (n - i) / n) * (x.pop != null ? x.pop : 1);
      const e = all.get(k) || { t: x.t, y: 0, kind, tags: [], _seen: new Set(), _pts: [] };
      e._pts.push(pts);
      if (!e.y && x.y) e.y = x.y;
      // where: the service; its own Top 10 says the place ("Netflix #1")
      const tag = l.top ? `${l.service} #${i + 1}` : l.service;
      if (l.service && !e._seen.has(l.service)) { e._seen.add(l.service); e.tags.push(tag); }
      else if (l.top) e.tags = e.tags.map(t => (t === l.service ? tag : t));
      all.set(k, e);
    });
  }
  for (const e of all.values()) { const best = Math.max(...e._pts); e.score = best + 0.35 * (e._pts.reduce((a, b) => a + b, 0) - best); }
  return [...all.values()].sort((a, b) => b.score - a.score).slice(0, KEEP).map(({ _seen, _pts, ...e }) => ({ ...e, score: Math.round(e.score * 100) / 100 }));
}

module.exports = { Trending, titleKey, parseNetflix, merge, serviceOf };
