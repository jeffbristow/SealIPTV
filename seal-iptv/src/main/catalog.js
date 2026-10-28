/* =====================================================================
 * Seal IPTV — catalog.js
 * ---------------------------------------------------------------------
 * Each playlist's channels, movies and series, kept in memory and on
 * disk (catalog/<profile id>.json) so the app starts without asking the
 * provider. The window asks for pages of it (list), so even providers
 * with 50,000 titles stay fast.
 *
 * Everything that contacts the provider waits for the VPN guard first.
 *
 * Sections:
 *   1. Files
 *   2. Loading from the provider
 *   3. Lists, categories, search
 *   4. Details (movie, series, EPG) + stream addresses
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const { Xtream } = require('./xtream');
const { parseM3U, buildCatalog, seriesInfoFromShow } = require('./m3u');
const { categoryLanguage, titleLanguage, languageName } = require('./language');
const { isAdult } = require('./parental');
const franchises = require('./franchises');
const { networkLogo } = require('./networks');

const SECTIONS = ['live', 'movies', 'series'];
const KIND = { live: 'live', movies: 'movie', series: 'series' };
/**
 * The title without the tags providers put in front ("EN - From", "|US| From",
 * "[4K] From", "FHD: From"), lower case, for "starts with" matching. Tags are
 * upper case, 2–3 letters or 4K / HD / FHD / UHD, so a title like "FROM - Season 1"
 * keeps its first word.
 */
const TAG_RE = /^(?:\[[^\]]{1,12}\]\s*|\|[^|]{1,12}\|\s*|(?:[A-Z]{2,3}|4K|8K|HD|FHD|UHD)\s*(?:[:|]|\s-)\s*)+/;
const coreName = name => String(name).replace(TAG_RE, '').trim().toLowerCase();

/**
 * 0 the whole title is the search ("From", "From (2022)")
 * 1 the title starts with the search ("From Dusk Till Dawn")
 * 2 a word in the title starts with the search ("Far From Home")
 * 3 every search word starts a word of the title, in any order
 * 4 the letters are somewhere ("Fromage" for "rom")
 */
/* worked out per title the first time they're needed (not all 190 000 at start-up), then kept */
const qOf = i => i._q !== undefined ? i._q : (i._q = i.name.toLowerCase());
const coreOf = i => i._core != null ? i._core : (i._core = coreName(i.name));
const foreignOf = i => {
  if (i._foreign === undefined) { const l = titleLanguage(i.name); i._foreign = !!(l && l.lang !== 'en'); }
  return i._foreign;
};

function matchRank(i, words) {
  const phrase = words.join(' ');
  const core = coreOf(i);
  const bare = core.replace(/\s*[([](19|20)\d{2}[)\]]\s*$/, '').trim();
  if (bare === phrase || core === phrase) return 0;
  if (core.startsWith(phrase) && !/[a-z0-9]/.test(core[phrase.length] || ' ')) return 1;
  if (core.startsWith(phrase)) return 1.5;
  const wordStarts = new RegExp('(^|[^\\p{L}\\p{N}])' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u');
  if (wordStarts.test(core)) return 2;
  if (words.every(w => new RegExp('(^|[^\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u').test(core))) return 3;
  return 4;
}

const EMPTY = () => ({ live: { cats: [], items: [] }, movies: { cats: [], items: [] }, series: { cats: [], items: [] } });

class Catalog {
  /**
   * @param o.dir        data folder (catalogs go in <dir>/catalog)
   * @param o.store      Store (profiles)
   * @param o.vpn        VpnGuard
   * @param o.library    Library (favorite / watched flags on lists)
   * @param o.userAgent  () -> User-Agent string
   * @param o.fetch      fetch implementation
   * @param o.parental   Parental (is the PIN entered?) — optional in tests
   */
  constructor({ dir, store, vpn, library, userAgent, fetch: fetchImpl, parental }) {
    this.parental = parental || { isUnlocked: () => false };
    this.dir = path.join(dir, 'catalog');
    this.store = store;
    this.vpn = vpn;
    this.library = library;
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || globalThis.fetch;
    this.mem = new Map();
    this.details = new Map();      // "<pid>|series|<id>" -> info (this session only)
  }

  /* =================================================================
   * 1. FILES
   * ================================================================= */
  _file(pid) { return path.join(this.dir, String(pid).replace(/[^\w-]/g, '') + '.json'); }

  /** The catalogue (from memory or disk), or an empty one. */
  get(pid) {
    if (!pid) return { ...EMPTY(), fetchedAt: 0 };
    let c = this.mem.get(pid);
    if (c) return c;
    try { c = JSON.parse(fs.readFileSync(this._file(pid), 'utf8')); } catch { c = null; }
    c = c && c.live ? c : { ...EMPTY(), fetchedAt: 0 };
    this._index(c);
    this.mem.set(pid, c);
    return c;
  }

  _index(c) {
    c._byId = {};
    for (const s of SECTIONS) {
      c._byId[s] = new Map(c[s].items.map(i => [i.id, i]));
      c[s]._catNames = new Map(c[s].cats.map(x => [x.id, x.name]));
    }
    this._warm(c);
  }

  /** After start-up: the per-title search / language / collection keys, a few thousand at a time,
      so the window (on a TV: the remote) keeps answering. Anything needing one sooner works it out then. */
  _warm(c) {
    const todo = SECTIONS.map(s => c[s].items);
    let s = 0, at = 0;
    const step = () => {
      if (this.mem && ![...this.mem.values()].includes(c)) return;   // replaced by a reload
      const end = Date.now() + 25;
      while (s < todo.length && Date.now() < end) {
        const items = todo[s];
        for (const stop = Math.min(items.length, at + 500); at < stop; at++) { qOf(items[at]); coreOf(items[at]); foreignOf(items[at]); }
        if (at >= items.length) { s++; at = 0; }
      }
      if (s < todo.length) setTimeout(step, 15);
    };
    setTimeout(step, 1500);
  }

  _save(pid, c) {
    fs.mkdirSync(this.dir, { recursive: true });
    const plain = { fetchedAt: c.fetchedAt, account: c.account || null };
    for (const s of SECTIONS) plain[s] = { cats: c[s].cats, items: c[s].items.map(({ _q, _core, _foreign, plot, ...i }) => i) };   // worked out again when loaded; plots come with the series page
    const f = this._file(pid), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(plain));
    fs.renameSync(tmp, f);
  }

  /** A playlist joined with the same one from another PC: keep the downloaded lists. */
  rename(from, to) {
    this.mem.delete(from); this.mem.delete(to);
    try { if (!fs.existsSync(this._file(to))) fs.renameSync(this._file(from), this._file(to)); else fs.unlinkSync(this._file(from)); } catch { /* nothing downloaded */ }
  }

  remove(pid) {
    this.mem.delete(pid);
    try { fs.unlinkSync(this._file(pid)); } catch { /* none */ }
  }

  summary(pid) {
    const c = this.get(pid);
    return { fetchedAt: c.fetchedAt || 0, account: c.account || null, counts: { live: c.live.items.length, movies: c.movies.items.length, series: c.series.items.length } };
  }

  /** Is the saved copy older than the refresh setting? */
  stale(pid) {
    const h = this.store.getSettings().catalog.refreshHours;
    const c = this.get(pid);
    return !c.fetchedAt || (h > 0 && Date.now() - c.fetchedAt > h * 3600000);
  }

  /* =================================================================
   * 2. LOADING FROM THE PROVIDER
   * ================================================================= */
  client(profile) {
    return new Xtream({ server: profile.server, username: profile.username, password: profile.password, userAgent: this.userAgent(), fetch: this.fetch });
  }

  /** Test a login / playlist without saving: -> { counts, account } */
  async test(profile) {
    if (profile.type === 'xtream') {
      await this.vpn.ensure();
      const a = await this.client(profile).login();
      return { account: a.user };
    }
    const c = await this._loadM3u(profile);
    return { counts: { live: c.live.items.length, movies: c.movies.items.length, series: c.series.items.length } };
  }

  async _loadM3u(p) {
    let text;
    if (p.m3uUrl) {
      await this.vpn.ensure();
      let res;
      try {
        res = await this.fetch(p.m3uUrl, { headers: { 'User-Agent': this.userAgent() }, signal: AbortSignal.timeout(120000) });
      } catch (e) {
        throw new Error(`Can't download the playlist (${e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message}).`);
      }
      if (!res.ok) throw new Error(`The playlist server answered HTTP ${res.status}.`);
      text = await res.text();
    } else {
      try { text = fs.readFileSync(p.m3uFile, 'utf8'); } catch { throw new Error('The playlist file can\'t be read: ' + p.m3uFile); }
    }
    if (!/#EXTINF/i.test(text)) throw new Error('This isn\'t an M3U playlist (no #EXTINF lines).');
    return buildCatalog(parseM3U(text));
  }

  /** Reload a playlist from the provider. onStep(text) reports progress. */
  async refresh(pid, onStep = () => {}) {
    const p = this.store.getProfile(pid);
    let c;
    if (p.type === 'xtream') {
      await this.vpn.ensure();
      const x = this.client(p);
      onStep('Signing in…');
      const acc = await x.login();
      c = { ...EMPTY(), account: acc.user };
      for (const s of SECTIONS) {
        onStep(`Loading ${s === 'live' ? 'Live TV' : s === 'movies' ? 'Movies' : 'Series'}…`);
        const [cats, items] = await Promise.all([x.categories(s), x.streams(s)]);
        c[s].cats = Xtream.normCategories(cats);
        c[s].items = items.map(i => Xtream.normItem(s, i)).filter(i => i.id && i.id !== 'undefined');
      }
    } else {
      onStep('Loading the playlist…');
      c = await this._loadM3u(p);
    }
    c.fetchedAt = Date.now();
    this._index(c);
    this.mem.set(pid, c);
    this._save(pid, c);
    for (const k of [...this.details.keys()]) if (k.startsWith(pid + '|')) this.details.delete(k);
    return this.summary(pid);
  }

  /* =================================================================
   * 3. LISTS, CATEGORIES, SEARCH
   *    cat: '' (all) | '*fav' | a category id
   *    sort: '' (provider order) | 'az' | 'added' | 'rating' | 'year'
   * ================================================================= */
  /* ---- parental locks, hidden categories, languages ---- */
  /** catId -> { locked, hidden, foreign, lang, show, lock (the user's choice), adult } */
  rules(pid, section) {
    const c = this.get(pid)[section];
    const flags = this.library.catFlags(pid);
    const s = this.store.getSettings();
    const autoAdult = s.parental.autoAdult !== false, hideForeign = !!s.content.hideNonEnglish;
    const out = new Map();
    for (const cat of c.cats) {
      const f = flags[section + ':' + cat.id] || {};
      const l = categoryLanguage(cat.name);
      const foreign = !!(l && l.lang !== 'en');
      const adult = isAdult(cat.name);
      out.set(cat.id, {
        locked: f.lock === true || (f.lock !== false && autoAdult && adult),
        hidden: !!f.hide || (hideForeign && foreign && !f.show),
        foreign, lang: foreign ? languageName(l.lang) : '', langWhy: foreign ? l.why : '', show: !!f.show, lock: f.lock, hide: !!f.hide, adult
      });
    }
    out.hideForeign = hideForeign;
    return out;
  }

  /** May this item be listed? (open = the PIN was entered) */
  _visible(i, rules, open, allowHidden = false) {
    const r = rules.get(i.cat);
    if (r && r.hidden && !allowHidden) return false;
    if (r && r.locked && !open) return false;
    if (rules.hideForeign && foreignOf(i) && !(r && r.show) && !allowHidden) return false;
    return true;
  }

  /** Is the item only shown because "search hidden categories" is on? */
  _fromHidden(i, rules) {
    const r = rules.get(i.cat);
    return !!((r && r.hidden) || (rules.hideForeign && foreignOf(i) && !(r && r.show)));
  }

  static lockedError(section, cat, name) {
    const e = new Error(`"${name}" is locked. Enter the parental PIN.`);
    e.code = 'LOCKED';
    e.locked = { section, cat, name };
    return e;
  }

  /** Throws LOCKED if the item is in a locked category and the PIN isn't entered. */
  guard(pid, section, item) {
    if (!item || this.parental.isUnlocked()) return;
    const r = this.rules(pid, section).get(item.cat);
    if (r && r.locked) throw Catalog.lockedError(section, item.cat, this.get(pid)[section]._catNames.get(item.cat) || 'This category');
  }

  /** How Favorites of a kind are listed (Settings: favorites.<kind>). */
  favSort(kind) {
    const f = this.store.getSettings && this.store.getSettings().favorites;
    return (f && f[kind]) || 'added';
  }

  /** Favorites / Continue watching: is what this key points to shown right now? */
  visibleKey(pid, key, meta = {}) {
    const kind = key.slice(0, key.indexOf(':')), id = key.slice(key.indexOf(':') + 1);
    const c = this.get(pid);
    const [section, iid] = kind === 'live' ? ['live', id] : kind === 'movie' ? ['movies', id] : ['series', kind === 'series' ? id : meta.seriesId];
    const it = iid && c._byId[section].get(String(iid));
    if (!it) return true;
    return this._visible(it, this.rules(pid, section), this.parental.isUnlocked());
  }

  /**
   * May it be on Home (Continue watching, Recently added, the spotlight)? Only from categories
   * that are open to everyone, whether or not the PIN was entered, and only if its category is
   * known (still in the playlist).
   */
  homeSafe(pid, key, meta = {}) {
    const kind = key.slice(0, key.indexOf(':')), id = key.slice(key.indexOf(':') + 1);
    const c = this.get(pid);
    const [section, iid] = kind === 'live' ? ['live', id] : kind === 'movie' ? ['movies', id] : ['series', kind === 'series' ? id : meta.seriesId];
    const it = iid && c._byId[section].get(String(iid));
    return !!it && this._homeSafeItem(it, this.rules(pid, section));
  }

  /** The poster of the movie / the episode's series, from the playlist (Home falls back to it) */
  posterFor(pid, key, meta = {}) {
    const kind = key.slice(0, key.indexOf(':')), id = key.slice(key.indexOf(':') + 1);
    const c = this.get(pid);
    const it = kind === 'movie' ? c._byId.movies.get(String(id)) : kind === 'episode' || kind === 'series' ? c._byId.series.get(String(kind === 'series' ? id : meta.seriesId)) : null;
    return (it && it.poster) || '';
  }

  _homeSafeItem(it, rules) {
    const r = rules.get(it.cat);
    if (r && (r.adult || r.locked || r.hidden)) return false;
    return !(rules.hideForeign && foreignOf(it) && !(r && r.show));
  }

  /**
   * Categories for the lists (hidden ones left out), or all of them for
   * Settings (all = true). Counts are of what's shown.
   */
  cats(pid, section, { all = false } = {}) {
    const c = this.get(pid)[section];
    const rules = this.rules(pid, section);
    const open = this.parental.isUnlocked();
    const counts = new Map();
    let total = 0;
    for (const i of c.items) {
      const r = rules.get(i.cat);
      if (rules.hideForeign && foreignOf(i) && !(r && r.show)) continue;
      counts.set(i.cat, (counts.get(i.cat) || 0) + 1);
      if (this._visible(i, rules, open)) total++;
    }
    const known = c.cats.filter(x => counts.has(x.id) || all).map(x => ({ ...x, count: counts.get(x.id) || 0, ...rules.get(x.id), open }))
      .filter(x => all || !x.hidden);
    const orphan = [...counts.keys()].filter(id => !c._catNames.has(id));
    if (orphan.length && !all) known.push({ id: '*other', name: 'Other', count: orphan.reduce((n, id) => n + counts.get(id), 0) });
    return { total, cats: known };
  }

  list(pid, { section, cat = '', q = '', sort = '', offset = 0, limit = 120 }) {
    if (!SECTIONS.includes(section)) throw new Error('Unknown section');
    const c = this.get(pid)[section];
    const kind = KIND[section];
    const rules = this.rules(pid, section);
    const open = this.parental.isUnlocked();
    const r = cat && rules.get(cat);
    if (r && r.locked && !open) throw Catalog.lockedError(section, cat, c._catNames.get(cat));
    // hidden categories never show up in search — unless "search hidden categories too" is on (PIN)
    const allowHidden = !!(q && String(q).trim() && this.parental.searchHidden && this.parental.searchHidden());
    let items = c.items.filter(i => this._visible(i, rules, open, allowHidden));
    let favAt = null;
    if (cat === '*fav') {
      // in the order chosen for Favorites, unless another sort is picked
      const favs = this.library.favorites(pid, kind, this.favSort(kind));
      favAt = new Map(favs.map((f, n) => [f.id, n]));
      items = items.filter(i => favAt.has(i.id));
    } else if (cat === '*other') {
      items = items.filter(i => !c._catNames.has(i.cat));
    } else if (cat) {
      items = items.filter(i => i.cat === cat);
    }
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) items = items.filter(i => words.every(w => qOf(i).includes(w)));
    if (favAt && !sort && !words.length) items.sort((a, b) => favAt.get(a.id) - favAt.get(b.id));
    // searching without a chosen sort: best matches first ("From" before "Far From Home")
    if (words.length && !sort) {
      const ranked = items.map(i => ({ i, r: matchRank(i, words) }));
      ranked.sort((a, b) => a.r - b.r || a.i.name.localeCompare(b.i.name));
      items = ranked.map(x => x.i);
    }
    if (sort) {
      const by = {
        az: (a, b) => a.name.localeCompare(b.name),
        added: (a, b) => (b.added || 0) - (a.added || 0),
        rating: (a, b) => (b.rating || 0) - (a.rating || 0),
        year: (a, b) => (b.year || 0) - (a.year || 0)
      }[sort];
      if (by) items = [...items].sort(by);
    }
    const page = items.slice(offset, offset + limit);
    const out = this._decorate(pid, kind, page, c);
    if (allowHidden) page.forEach((i, n) => { if (this._fromHidden(i, rules)) out[n].fromHidden = true; });
    return { total: items.length, items: out };
  }

  /** Adds fav / watched / progress and the category name; drops internal fields. US local stations get their network's logo (networks.js). */
  _decorate(pid, kind, items, c) {
    const flags = this.library.flags(pid, items.map(i => kind + ':' + i.id));
    return items.map(({ _q, _core, _foreign, url, ua, episodes, ...i }) => {
      const catName = c._catNames.get(i.cat) || '';
      const net = kind === 'live' && networkLogo(i.name, catName);
      return { ...i, ...(net ? { logo: net } : {}), kind, catName, ...flags[kind + ':' + i.id] };
    });
  }

  /** Favorites / my categories (saved with the picture they had then): channels with their network's logo too. */
  withLogos(pid, list) {
    const c = this.get(pid);
    return list.map(f => {
      if (!String(f.key || '').startsWith('live:')) return f;
      const i = c._byId.live.get(String(f.id));
      const net = i ? networkLogo(i.name, c.live._catNames.get(i.cat)) : networkLogo(f.name);
      return net ? { ...f, image: net } : f;
    });
  }

  item(pid, section, id) {
    const c = this.get(pid);
    const i = c._byId[section].get(String(id));
    if (i) this.guard(pid, section, i);
    return i ? this._decorate(pid, KIND[section], [i], c[section])[0] : null;
  }

  /** Search all three sections at once (Home). */
  search(pid, q, limit = 30) {
    const out = {};
    for (const s of SECTIONS) out[s] = this.list(pid, { section: s, q, limit });
    return out;
  }

  /* =================================================================
   * COLLECTIONS (franchises.js): Marvel, Star Wars … in order
   * ================================================================= */
  /** Matches per catalogue load (a reload makes a new one). */
  _franchiseMatches(pid) {
    const c = this.get(pid);
    if (!c._fr) c._fr = franchises.match(c.movies.items, c.series.items);
    return c._fr;
  }

  /** entry -> its versions that may be shown now (hidden / locked categories left out) */
  _franchiseItems(pid) {
    const m = this._franchiseMatches(pid), open = this.parental.isUnlocked();
    const rules = { movie: this.rules(pid, 'movies'), series: this.rules(pid, 'series') };
    return (f, e) => (m.get(f.id + ':' + e.i) || []).filter(i => this._visible(i, rules[e.kind], open));
  }

  /**
   * The collections the playlist has something from: [{ id, name, have, total, poster, art, cover }]; q = search text.
   * poster: the cover title's from the playlist, else the first one's. art: the TMDB collection the
   * window looks up (artwork.js) and shows instead; cover: { kind, name, year } to look up when there's no poster.
   */
  collections(pid, q = '') {
    const get = this._franchiseItems(pid);
    const out = [];
    const posterOf = its => (its.find(i => i.poster) || {}).poster || '';
    for (const f of franchises.all()) {
      if (q && !franchises.matchesQuery(f, q)) continue;
      let have = 0, poster = '';
      for (const n of f.release) {
        const its = get(f, f.items[n]);
        if (!its.length) continue;
        have++;
        if (!poster) poster = posterOf(its);
      }
      const c = f.cover === null ? null : f.items[f.cover];
      if (c) poster = posterOf(get(f, c)) || poster;
      if (have) out.push({ id: f.id, name: f.name, have, total: f.items.length, poster, art: f.art, cover: c && { kind: c.kind, name: c.t, year: c.y } });
    }
    return out;
  }

  /**
   * One collection in order ('release' | 'story'). Every title is listed; item is
   * null when the playlist doesn't have it. next: the place to go on from (the
   * title after the last one watched or started; one half watched itself).
   */
  collection(pid, id, order = 'release') {
    const f = franchises.byId(id);
    if (!f) return null;
    const c = this.get(pid), get = this._franchiseItems(pid);
    const started = this.library.seriesStarted(pid);
    order = order === 'story' && f.story ? 'story' : 'release';
    const items = (order === 'story' ? f.story : f.release).map((n, at) => {
      const e = f.items[n], section = e.kind === 'series' ? 'series' : 'movies';
      const its = get(f, e);
      const versions = its.length ? this._decorate(pid, e.kind, its, c[section]) : [];
      for (const v of versions) v.started = e.kind === 'series' ? started.has(String(v.id)) : !!(v.watched || v.pos);
      // the version to open: one already started, else one with a poster
      const best = versions.find(v => v.started) || versions.find(v => v.poster) || versions[0] || null;
      return { n: at + 1, title: e.t, year: e.y, kind: e.kind, item: best, versions: versions.map(v => ({ id: v.id, name: v.name })) };
    });
    let last = -1;
    items.forEach((x, i) => { if (x.item && x.item.started) last = i; });
    let next = -1;
    if (last >= 0 && items[last].kind === 'movie' && !items[last].item.watched) next = last;
    else next = items.findIndex((x, i) => i > last && x.item);
    return { id: f.id, name: f.name, order, hasStory: !!f.story, storyNote: f.storyNote, have: items.filter(x => x.item).length, total: items.length, items, next };
  }

  /** Recently added movies / series (Home). */
  /** the newest titles; homeSafe: only what may be on Home (homeSafe above) */
  recent(pid, section, limit = 20, homeSafe = false) {
    const items = this.list(pid, { section, sort: 'added', limit: homeSafe ? limit * 3 : limit }).items.filter(i => i.added);
    if (!homeSafe) return items;
    const rules = this.rules(pid, section);
    return items.filter(i => this._homeSafeItem(i, rules)).slice(0, limit);
  }

  /* =================================================================
   * 4. DETAILS + STREAM ADDRESSES
   * ================================================================= */
  async movieInfo(pid, id) {
    const base = this.item(pid, 'movies', id);
    const p = this.store.getProfile(pid);
    if (p.type !== 'xtream') return { ...base, info: { name: base ? base.name : '', poster: base ? base.poster : '', plot: '', year: base ? base.year : 0 } };
    await this.vpn.ensure();
    let info = {};
    try { info = await this.client(p).movieInfo(id); } catch (e) { info = { error: e.message }; }
    return { ...base, info };
  }

  async seriesInfo(pid, id) {
    const key = `${pid}|series|${id}`;
    const base = this.item(pid, 'series', id);
    let info = this.details.get(key);
    if (!info) {
      const p = this.store.getProfile(pid);
      if (p.type === 'xtream') {
        await this.vpn.ensure();
        info = await this.client(p).seriesInfo(id);
      } else {
        const show = this.get(pid)._byId.series.get(String(id));
        if (!show) throw new Error('This series isn\'t in the playlist any more.');
        info = seriesInfoFromShow(show);
      }
      this.details.set(key, info);
    }
    // watched / resume flags per episode
    const keys = info.seasons.flatMap(s => s.episodes.map(e => 'episode:' + e.id));
    const flags = this.library.flags(pid, keys);
    const seasons = info.seasons.map(s => ({ ...s, episodes: s.episodes.map(e => ({ ...e, ...flags['episode:' + e.id] })) }));
    return { ...base, info: { ...info, seasons } };
  }

  async epg(pid, id) {
    const p = this.store.getProfile(pid);
    if (p.type !== 'xtream') return [];
    await this.vpn.ensure();
    try { return await this.client(p).shortEpg(id); } catch { return []; }
  }

  /** The address to play. kind: live | movie | episode */
  async streamUrl(pid, { kind, id, ext, seriesId }) {
    const p = this.store.getProfile(pid);
    const c = this.get(pid);
    if (kind === 'live') this.guard(pid, 'live', c._byId.live.get(String(id)));
    else if (kind === 'movie') this.guard(pid, 'movies', c._byId.movies.get(String(id)));
    else this.guard(pid, 'series', c._byId.series.get(String(seriesId)));
    if (p.type === 'xtream') {
      const x = this.client(p);
      if (kind === 'live') {
        const fmts = (c.account && c.account.formats) || [];
        const want = p.liveFormat !== 'auto' ? p.liveFormat : (!fmts.length || fmts.includes('m3u8') ? 'm3u8' : 'ts');
        return { url: x.liveUrl(id, want), live: true };
      }
      if (kind === 'movie') {
        const m = c._byId.movies.get(String(id));
        return { url: x.movieUrl(id, ext || (m && m.ext)), live: false };
      }
      return { url: x.episodeUrl(id, ext), live: false };
    }
    // M3U: the address is in the playlist
    if (kind === 'live' || kind === 'movie') {
      const i = c._byId[kind === 'live' ? 'live' : 'movies'].get(String(id));
      if (!i) throw new Error('This isn\'t in the playlist any more. Reload the playlist.');
      return { url: i.url, live: kind === 'live', ua: i.ua };
    }
    const show = c._byId.series.get(String(seriesId));
    const e = show && show.episodes.find(x => x.id === String(id));
    if (!e) throw new Error('This episode isn\'t in the playlist any more. Reload the playlist.');
    return { url: e.url, live: false, ua: e.ua };
  }
}

module.exports = { Catalog, SECTIONS, KIND, matchRank, coreName };
