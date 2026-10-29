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
const { parseM3U, buildCatalog, seriesInfoFromShow, streamId } = require('./m3u');
const { categoryLanguage, titleLanguage, languageName } = require('./language');
const { isAdult } = require('./parental');
const franchises = require('./franchises');
const { networkLogo } = require('./networks');
const { Guide } = require('./guide');
const { titleKey } = require('./trending');
const events = require('./events');

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

/* how many of the newest movies / series the summary keeps for Home (filtered there by category) */
const HOME_KEEP = 300;
/** a title as saved: the search keys are worked out again when it's read; plots come with the series page */
const plainItem = ({ _q, _core, _foreign, plot, ...i }) => i;
/* A section's file says which titles are in another language (worked out once, when it's saved: on a TV
   that took longer than reading the file). LANG: the language rules they were found with (language.js). */
const LANG = 1;
const savedItem = i => (foreignOf(i) ? { ...plainItem(i), _foreign: true } : plainItem(i));
/* Saved with letters beyond Latin-1 as \u escapes: the text is then read as one byte a letter, not two
   (a few titles in Greek or Japanese made a TV hold 75 MB instead of 37 MB while reading the file). */
const writeJson = (f, o) => {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o).replace(/[Ā-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')));
  fs.renameSync(tmp, f);
};
/** setTimeout that doesn't keep Node running (tests) */
const EVENT_FRESH = 20 * 60000;   // event channels' names are fetched again after this (Sports / Pay-Per-View)
const later = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; };

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
    this.evFresh = new Map();      // pid -> { at, cats: Map(category id -> its channels now), job } (event channels' new names)
    this.guide = new Guide({ dir: this.dir, vpn, userAgent: this.userAgent, fetch: this.fetch });
  }

  /* =================================================================
   * 1. FILES
   *   catalog/<id>.json            what's needed first: counts, categories, the newest titles
   *                                (Home) and the titles the library points to (favorites,
   *                                Continue watching, my categories)
   *   catalog/<id>.<section>.json  each section's titles, read the first time they're needed —
   *                                a TV with 140 000 movies doesn't hold them until Movies is opened
   * An older catalog/<id>.json with everything in it is read as it is, then saved this way.
   * ================================================================= */
  _file(pid) { return path.join(this.dir, String(pid).replace(/[^\w-]/g, '') + '.json'); }
  _secFile(pid, s) { return this._file(pid).replace(/\.json$/, `.${s}.json`); }
  _files(pid) { return [this._file(pid), ...SECTIONS.map(s => this._secFile(pid, s))]; }

  /** The catalogue (from memory or disk), or an empty one. */
  get(pid) {
    if (!pid) return { ...EMPTY(), fetchedAt: 0 };
    let c = this.mem.get(pid);
    if (c) return c;
    let d;
    try { d = JSON.parse(fs.readFileSync(this._file(pid), 'utf8')); } catch { d = null; }
    if (d && d.v === 2) c = this._lazy(pid, d);
    else {
      c = d && d.live ? d : { ...EMPTY(), fetchedAt: 0 };
      this._index(c);
      if (d && d.live) later(() => { if (this.mem.get(pid) === c) try { this._save(pid, c); } catch { /* next time */ } }, 30000);   // the older single file
    }
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

  /** A catalogue saved in sections: each section's items (and _byId) are read the first time they're asked for. */
  _lazy(pid, d) {
    const c = { fetchedAt: d.fetchedAt || 0, account: d.account || null, counts: d.counts || {}, home: d.home || {}, refs: d.refs || {}, _pid: pid, _byId: {}, _read: {} };
    const set = (o, k, value) => Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true });
    for (const s of SECTIONS) {
      const sec = { cats: (d.cats && d.cats[s]) || [] };
      sec._catNames = new Map(sec.cats.map(x => [x.id, x.name]));
      const read = () => {
        if (c._read[s]) return;
        let items = [];
        try {
          const f = JSON.parse(fs.readFileSync(this._secFile(pid, s), 'utf8'));
          items = f.items || [];
          if (f.lang === LANG) for (const i of items) if (!i._foreign) i._foreign = false;
        } catch { /* missing: empty until a reload */ }
        c._read[s] = true;
        set(sec, 'items', items);
        set(c._byId, s, new Map(items.map(i => [i.id, i])));
        this._warm(c, [items]);
      };
      Object.defineProperty(sec, 'items', { get: () => (read(), sec.items), enumerable: true, configurable: true });
      Object.defineProperty(c._byId, s, { get: () => (read(), c._byId[s]), enumerable: true, configurable: true });
      c[s] = sec;
    }
    return c;
  }

  /** Have this section's titles been read? (an older single-file catalogue: always) */
  _isRead(c, s) { return !c._read || !!c._read[s]; }
  /** the sections not read yet (core.js on a TV reads their files ahead) */
  unread(pid) { const c = this.get(pid); return SECTIONS.filter(s => !this._isRead(c, s)); }

  /** a favorite's / resume point's key -> [section, id] (an episode: its series) */
  static where(key, meta = {}) {
    const kind = key.slice(0, key.indexOf(':')), id = key.slice(key.indexOf(':') + 1);
    return kind === 'live' ? ['live', id] : kind === 'movie' ? ['movies', id] : ['series', kind === 'series' ? id : meta.seriesId ? String(meta.seriesId) : ''];
  }

  /** A title by id. Before its section is read, the copy kept with the summary will do (refs). */
  _find(c, section, id) {
    id = String(id);
    if (!this._isRead(c, section)) {
      const r = c.refs[section];
      if (r && Object.prototype.hasOwnProperty.call(r, id)) return r[id] || undefined;   // null: known not to be in the playlist
      // a new favorite / resume point: the section is read for it, and it's kept for next time
      if (!c._refsSoon) c._refsSoon = later(() => { c._refsSoon = null; if (this.mem.get(c._pid) === c) try { this._saveSummary(c._pid, c); } catch { /* next time */ } }, 5000);
    }
    return c._byId[section].get(id);
  }

  /** The titles the library points to, for _find; null for ones not in the playlist.
      readNew false: a new one from a section not read yet is left for later (not read for it). */
  _refs(pid, c, readNew = true) {
    const out = { live: {}, movies: {}, series: {} };
    const keys = [];
    try {
      for (const k of ['live', 'movie', 'series', 'episode']) keys.push(...this.library.favorites(pid, k));
      keys.push(...this.library.continueWatching(pid, 60));
      for (const l of this.library.lists(pid)) keys.push(...this.library.listItems(pid, l.id));
      keys.push(...this.library.watchlist(pid));
    } catch { return out; }
    for (const m of keys) {
      const [s, id] = Catalog.where(m.key, m);
      if (!id || Object.prototype.hasOwnProperty.call(out[s], id)) continue;
      if (!this._isRead(c, s) && c.refs[s] && Object.prototype.hasOwnProperty.call(c.refs[s], id)) out[s][id] = c.refs[s][id];
      else if (readNew || this._isRead(c, s)) { const it = c._byId[s].get(id); out[s][id] = it ? plainItem(it) : null; }   // a new one: read its section
    }
    return out;
  }

  /** The app was left or came back (after playing something): the summary keeps up with the library,
      from the sections already read. */
  keepRefs(pid) {
    const c = pid && this.mem.get(pid);
    if (!c || !c._read) return false;
    const refs = this._refs(pid, c, false);
    if (JSON.stringify(refs) === JSON.stringify(c.refs)) return false;
    c.refs = refs;
    this._saveSummary(pid, c, refs);
    return true;
  }

  /** After start-up: the per-title search / language / collection keys, a few thousand at a time,
      so the window (on a TV: the remote) keeps answering. Anything needing one sooner works it out then. */
  _warm(c, todo = SECTIONS.map(s => c[s].items)) {
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

  /** The sections first, then the summary (until it's written, the older file is still the one read). */
  _save(pid, c) {
    fs.mkdirSync(this.dir, { recursive: true });
    const counts = {}, home = {};
    for (const s of SECTIONS) {
      const items = c[s].items.map(savedItem);
      writeJson(this._secFile(pid, s), { lang: LANG, items });
      counts[s] = items.length;
      if (s !== 'live') home[s] = items.filter(i => i.added).sort((a, b) => b.added - a.added).slice(0, HOME_KEEP);
    }
    Object.assign(c, { counts, home });
    this._saveSummary(pid, c);
  }

  _saveSummary(pid, c, refs = this._refs(pid, c)) {
    const cats = {};
    for (const s of SECTIONS) cats[s] = c[s].cats;
    writeJson(this._file(pid), { v: 2, fetchedAt: c.fetchedAt, account: c.account || null, counts: c.counts, cats, home: c.home, refs });
    if (c._read) c.refs = refs;
  }

  /** A playlist joined with the same one from another PC: keep the downloaded lists. */
  rename(from, to) {
    this.mem.delete(from); this.mem.delete(to);
    this.guide.forget(from);
    try { fs.unlinkSync(this._trendFile(from)); } catch { /* none */ }
    const have = fs.existsSync(this._file(to));
    const a = this._files(from), b = this._files(to);
    a.forEach((f, n) => { try { if (!have) fs.renameSync(f, b[n]); else fs.unlinkSync(f); } catch { /* nothing downloaded */ } });
  }

  remove(pid) {
    this.mem.delete(pid);
    this.guide.forget(pid);
    try { fs.unlinkSync(this._trendFile(pid)); } catch { /* none */ }
    for (const f of this._files(pid)) try { fs.unlinkSync(f); } catch { /* none */ }
  }

  /** Where the playlist's TV guide comes from ('' for none) — an edit that changes it drops the saved guide. */
  guideAddress(pid) { try { return Guide.address(this.store.getProfile(pid)); } catch { return ''; } }

  summary(pid) {
    const c = this.get(pid);
    const n = s => (this._isRead(c, s) ? c[s].items.length : c.counts[s] || 0);
    return { fetchedAt: c.fetchedAt || 0, account: c.account || null, counts: { live: n('live'), movies: n('movies'), series: n('series') } };
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
    const old = this.get(pid);   // (what the library's titles were: their addresses and names, for _carryOver)
    let c;
    if (p.type === 'xtream') {
      await this.vpn.ensure();
      const x = this.client(p);
      onStep('Signing in…');
      const acc = await x.login();
      c = { ...EMPTY(), account: { ...acc.user, timezone: String((acc.server && acc.server.timezone) || '').slice(0, 60) } };
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
    let carried = 0;
    try { carried = this._carryOver(pid, old, c); } catch { /* the library stays as it was */ }
    this.mem.set(pid, c);
    this._save(pid, c);
    for (const k of [...this.details.keys()]) if (k.startsWith(pid + '|')) this.details.delete(k);
    this.evFresh.delete(pid);
    return { ...this.summary(pid), carried };
  }

  /**
   * After a reload: the titles the library has something about (favorites, watched, resume
   * points, my categories) whose id isn't in the playlist any more — a new playlist link or
   * login, a provider that renumbered, another provider — are found again and the library is
   * moved to them: by the stream's address without the login, else by name (in its category,
   * else the only one of that name); an episode by its show, then the same season and number.
   * -> how many moved
   */
  _carryOver(pid, old, c) {
    const list = this.library.entries(pid);
    if (!list.length) return 0;
    const SEC = { live: 'live', movie: 'movies', series: 'series' };
    const oldItem = (s, id) => (this._isRead(old, s) ? old._byId[s].get(id) : ((old.refs || {})[s] || {})[id]) || null;
    const names = {};
    const byName = (s, name, cat) => {
      if (!name) return null;
      if (!names[s]) {
        names[s] = new Map();
        for (const i of c[s].items) { const k = coreName(i.name); if (!names[s].has(k)) names[s].set(k, []); names[s].get(k).push(i); }
      }
      const hits = names[s].get(coreName(name)) || [];
      const inCat = cat ? hits.filter(i => i.cat === cat) : [];
      return inCat.length === 1 ? inCat[0] : hits.length === 1 ? hits[0] : null;
    };
    const findNew = (s, id, meta) => {
      if (c._byId[s].has(id)) return id;
      const o = oldItem(s, id);
      if (o && o.url) { const sid = streamId(o.url); if (c._byId[s].has(sid)) return sid; }
      const hit = byName(s, (o && o.name) || meta.name, (o && o.cat) || meta.cat);
      return hit ? hit.id : null;
    };
    const moves = new Map(), shows = new Map();
    for (const { key, meta } of list) {
      const kind = key.slice(0, key.indexOf(':')), id = key.slice(key.indexOf(':') + 1);
      const s = SEC[kind];
      if (!s) continue;
      const to = findNew(s, id, meta || {});
      if (kind === 'series' && to) shows.set(id, to);
      if (to && to !== id) moves.set(key, { key: kind + ':' + to });
    }
    for (const { key, meta = {} } of list) {
      if (!key.startsWith('episode:')) continue;
      const id = key.slice(8), was = String(meta.seriesId || '');
      let sid = shows.get(was) || (c._byId.series.has(was) ? was : null);
      if (!sid) { const h = byName('series', meta.seriesName, ''); sid = h && h.id; }
      const show = sid && c._byId.series.get(sid);
      if (!show || !Array.isArray(show.episodes)) continue;   // Xtream: episodes aren't in the playlist (their ids don't change)
      const patch = sid !== was ? { seriesId: sid } : {};
      if (show.episodes.some(e => e.id === id)) { if (sid !== was) moves.set(key, { key, meta: patch }); continue; }
      const oldShow = oldItem('series', was);
      const oldEp = oldShow && Array.isArray(oldShow.episodes) ? oldShow.episodes.find(e => e.id === id) : null;
      let ep = oldEp && oldEp.url ? show.episodes.find(e => e.id === streamId(oldEp.url)) : null;
      if (!ep && meta.season != null && meta.episode != null) ep = show.episodes.find(e => e.season === meta.season && e.num === meta.episode);
      if (ep) moves.set(key, { key: 'episode:' + ep.id, meta: patch });
    }
    return moves.size ? this.library.remap(pid, moves) : 0;
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
    const [section, iid] = Catalog.where(key, meta);
    const it = iid && this._find(this.get(pid), section, iid);
    if (!it) return true;
    return this._visible(it, this.rules(pid, section), this.parental.isUnlocked());
  }

  /**
   * May it be on Home (Continue watching, Recently added, the spotlight)? Only from categories
   * that are open to everyone, whether or not the PIN was entered, and only if its category is
   * known (still in the playlist).
   */
  homeSafe(pid, key, meta = {}) {
    const [section, iid] = Catalog.where(key, meta);
    const it = iid && this._find(this.get(pid), section, iid);
    return !!it && this._homeSafeItem(it, this.rules(pid, section));
  }

  /** The poster of the movie / the episode's series, from the playlist (Home falls back to it) */
  posterFor(pid, key, meta = {}) {
    const [section, iid] = Catalog.where(key, meta);
    const it = section !== 'live' && iid ? this._find(this.get(pid), section, iid) : null;
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
      const i = this._find(c, 'live', f.id);
      const net = i ? networkLogo(i.name, c.live._catNames.get(i.cat)) : networkLogo(f.name);
      return net ? { ...f, image: net } : f;
    });
  }

  /* =================================================================
   * SPORTS + PAY-PER-VIEW (events.js): games and events on now and later
   * ================================================================= */
  /** the categories with event channels ("Pay Per View 04: …"): their names change during the day */
  _eventCats(c) {
    const n = new Map();
    for (const i of c.live.items) if (/^.{1,48}?\d\s*:/.test(i.name)) n.set(i.cat, (n.get(i.cat) || 0) + 1);
    return [...n].filter(([, k]) => k >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([cat]) => cat);
  }

  /**
   * Fetch the event channels' names again (Xtream: one category at a time, four at once),
   * at most every 20 minutes. An M3U playlist has them as of its last reload.
   */
  refreshEvents(pid) {
    const p = this.store.getProfile(pid);
    if (!p || p.type !== 'xtream') return Promise.resolve(false);
    const f = this.evFresh.get(pid);
    if (f && f.job) return f.job;
    if (f && Date.now() - f.at < EVENT_FRESH) return Promise.resolve(false);
    const c = this.get(pid);
    const job = (async () => {
      await this.vpn.ensure();
      const x = this.client(p), cats = new Map(), todo = this._eventCats(c);
      const one = async () => {
        for (let cat; (cat = todo.shift()) !== undefined;) {
          try { cats.set(cat, (await x.streamsIn('live', cat)).map(i => Xtream.normItem('live', i)).filter(i => i.id && i.id !== 'undefined')); }
          catch { /* that category as it was */ }
        }
      };
      await Promise.all([one(), one(), one(), one()]);
      this.evFresh.set(pid, { at: Date.now(), cats });
      return true;
    })().catch(() => { this.evFresh.set(pid, { at: Date.now() - EVENT_FRESH + 3 * 60000, cats: (f && f.cats) || new Map() }); return false; });   // try again in 3 minutes
    this.evFresh.set(pid, { ...(f || { at: 0, cats: new Map() }), job });
    return job;
  }

  /**
   * kind 'sports' | 'ppv' -> events.build(): { live, later, tomorrow, soon, sports, regions }.
   * Only channels that may be shown now (home: only ones that may be on Home).
   */
  events(pid, kind, { home = false } = {}) {
    const c = this.get(pid), p = this.store.getProfile(pid);
    const rules = this.rules(pid, 'live'), open = this.parental.isUnlocked();
    const fresh = (this.evFresh.get(pid) || {}).cats || new Map();
    const ok = i => (home ? this._homeSafeItem(i, rules) : this._visible(i, rules, open));
    const items = c.live.items.filter(i => !fresh.has(i.cat));
    for (const list of fresh.values()) items.push(...list);
    const chans = items.filter(ok).map(i => ({ id: i.id, name: i.name, logo: i.logo, cat: i.cat, epg: i.epg, catName: c.live._catNames.get(i.cat) || '' }));
    // the sports channels that aren't event channels: what the guide has on them
    const want = chans.filter(ch => ch.epg && !events.parseName(ch.name) && (kind === 'ppv' ? events.isPpv(ch.name, ch.catName) : events.isSports(ch.name, ch.catName)));
    const guide = p && want.length ? this._fromGuide(pid, p, want.map(ch => ch.id), false) : {};
    for (const ch of chans) ch.guide = guide[ch.id] || null;
    return events.build(chans, { ppv: kind === 'ppv', zone: (c.account && c.account.timezone) || undefined });
  }

  /** The Sports / Pay-Per-View page: with the event channels' names fetched again first (waited for up to 6 s). */
  async eventsPage(pid, kind) {
    await Promise.race([this.refreshEvents(pid), new Promise(ok => later(ok, 6000))]);
    return this.events(pid, kind);
  }

  /** Home's rows: what's on now (the names fetched again in the background, for next time). */
  eventsHome(pid, limit = 20) {
    this.refreshEvents(pid).catch(() => {});
    return { sports: this.events(pid, 'sports', { home: true }).live.slice(0, limit), ppv: this.events(pid, 'ppv', { home: true }).live.slice(0, limit) };
  }

  /* ---- the watchlist (library.js 6b) ---- */
  /** what's kept with a title put on the watchlist: a series' "last changed" now (newer later = new episodes) */
  watchMeta(pid, key, meta = {}) {
    const [section, id] = Catalog.where(key, meta);
    const it = section === 'series' && this._find(this.get(pid), section, id);
    return it && it.added ? { ...meta, upd: it.added } : meta;
  }

  /**
   * The watchlist's titles that may be shown now (home: only ones that may be on Home), with
   * the playlist's poster / year / rating and newEps for a series changed since it was added.
   */
  watchlist(pid, { home = false } = {}) {
    const c = this.get(pid);
    return this.library.watchlist(pid).filter(w => (home ? this.homeSafe(pid, w.key, w) : this.visibleKey(pid, w.key, w))).map(w => {
      const it = this._find(c, w.kind === 'movie' ? 'movies' : 'series', w.id);
      return {
        kind: w.kind, id: w.id, name: (it && it.name) || w.name, poster: (it && it.poster) || w.image || '', cat: (it && it.cat) || w.cat,
        year: it && it.year, rating: it && it.rating, wl: true,
        newEps: w.kind === 'series' && !!(it && it.added && w.upd && it.added > w.upd)
      };
    });
  }

  item(pid, section, id) {
    const c = this.get(pid);
    const i = this._find(c, section, id);
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
    if (!c._fr || c._frV !== franchises.version()) { c._fr = franchises.match(c.movies.items, c.series.items); c._frV = franchises.version(); }
    return c._fr;
  }

  /** entry -> its versions that may be shown now (hidden / locked categories left out) */
  _franchiseItems(pid) {
    const m = this._franchiseMatches(pid), open = this.parental.isUnlocked();
    const rules = { movie: this.rules(pid, 'movies'), series: this.rules(pid, 'series') };
    return (f, e) => (m.get(f.id + ':' + e.i) || []).filter(i => this._visible(i, rules[e.kind], open));
  }

  /* ---- Trending (trending.js): the titles on the streaming services' lists that this playlist has ---- */
  _trendFile(pid) { return this._file(pid).replace(/\.json$/, '.trend.json'); }
  /** Are there matches kept (a TV finds them in the background the first time)? */
  trendKept(pid) { try { return JSON.parse(fs.readFileSync(this._trendFile(pid), 'utf8')).v === 2; } catch { return false; } }

  /**
   * For Home: { movies: [...], series: [...] }, the most-watched first, each with sub
   * ("Netflix #1 · Hulu"). Only titles Home may show. read: may read a section that isn't
   * read yet (Windows); a TV matches when a section is read anyway (a reload, Movies opened)
   * and keeps the last matches in catalog/<id>.trend.json meanwhile.
   */
  trending(pid, list, { read = true, limit = 20 } = {}) {
    const c = this.get(pid);
    let kept = null;
    try { kept = JSON.parse(fs.readFileSync(this._trendFile(pid), 'utf8')); } catch { /* none yet */ }
    if (kept && kept.v !== 2) kept = null;   // an older format
    const fresh = kept && list && kept.at === list.at && kept.fetchedAt === c.fetchedAt;
    const out = {};
    let changed = false;
    for (const [section, kind] of [['movies', 'movie'], ['series', 'series']]) {
      if (fresh || !list || (!read && !this._isRead(c, section))) { out[section] = (kept && kept[section]) || []; continue; }
      out[section] = this._matchTrending(pid, c, section, list[kind] || []);
      changed = true;
    }
    if (changed) try { writeJson(this._trendFile(pid), { v: 2, at: list.at, fetchedAt: c.fetchedAt, movies: out.movies, series: out.series }); } catch { /* next time */ }
    // what Home may show now (a category may have been hidden or locked since), with today's flags
    const res = {};
    for (const [section, kind] of [['movies', 'movie'], ['series', 'series']]) {
      const rules = this.rules(pid, section), open = this.parental.isUnlocked();
      res[section] = this._decorate(pid, KIND[section], out[section].filter(i => this._visible(i, rules, open) && this._homeSafeItem(i, rules)).slice(0, limit), c[section]);
    }
    return res;
  }

  /** The playlist's copy of each title: the same name (tags, years and "The" aside) and, when the list knows it, the year. */
  _matchTrending(pid, c, section, titles) {
    const sec = c[section];
    if (!sec._trIdx) {
      sec._trIdx = new Map();
      for (const i of sec.items) { const k = titleKey(i.name); if (!k) continue; if (!sec._trIdx.has(k)) sec._trIdx.set(k, []); sec._trIdx.get(k).push(i); }
    }
    const rules = this.rules(pid, section), open = this.parental.isUnlocked();
    const out = [], seen = new Set();
    for (const x of titles) {
      let cands = (sec._trIdx.get(titleKey(x.t)) || []).filter(i => this._visible(i, rules, open) && this._homeSafeItem(i, rules));
      if (x.y) cands = cands.filter(i => !i.year || Math.abs(Number(i.year) - x.y) <= 1);
      // no year to go by and different titles of that name (a 2019 and a 2021 "Animals"): don't guess
      else if (new Set(cands.map(i => Number(i.year) || 0).filter(Boolean)).size > 1) continue;
      cands.sort((a, b) => (foreignOf(a) - foreignOf(b)) || (!!b.poster - !!a.poster));
      const it = cands.find(i => !seen.has(i.id));
      if (!it) continue;
      seen.add(it.id);
      out.push({ ...plainItem(it), sub: x.tags.length ? x.tags.slice(0, 2).join(' · ') : 'Trending' });   // two fit under a poster
      if (out.length >= 30) break;
    }
    return out;
  }

  /**
   * The collections the playlist has something from: [{ id, name, have, total, poster, art, cover }]; q = search text.
   * poster: the cover title's from the playlist, else the first one's. art: the TMDB collection the
   * window looks up (artwork.js) and shows instead; cover: { kind, name, year } to look up when there's no poster.
   */
  collections(pid, q = '') {
    // a search that names no collection: the playlist isn't matched against them (seconds on a TV)
    const wanted = franchises.all().filter(f => !q || franchises.matchesQuery(f, q));
    if (!wanted.length) return [];
    const get = this._franchiseItems(pid);
    const out = [];
    const posterOf = its => (its.find(i => i.poster) || {}).poster || '';
    for (const f of wanted) {
      let have = 0, poster = '';
      for (const n of f.studio ? [...f.release].reverse() : f.release) {   // a studio's card: its newest title's poster
        const its = get(f, f.items[n]);
        if (!its.length) continue;
        have++;
        if (!poster) poster = posterOf(its);
      }
      const c = f.cover === null ? null : f.items[f.cover];
      if (c) poster = posterOf(get(f, c)) || poster;
      if (have) out.push({ id: f.id, name: f.name, have, total: f.items.length, poster, art: f.art, cover: c && { kind: c.kind, name: c.t, year: c.y }, studio: !!f.studio });
    }
    return out.sort((a, b) => b.studio - a.studio);   // Disney, Netflix, Prime first
  }

  /**
   * One collection in order ('release' | 'story'). Every title is listed; item is
   * null when the playlist doesn't have it. next: the place to go on from (the
   * title after the last one watched or started; one half watched itself).
   */
  /**
   * A studio's collection (Disney, Netflix, Prime): only what the playlist has, newest first
   * (order 'oldest': the other way); kind 'movie' / 'series' for one kind only.
   */
  _studio(pid, f, order, kind) {
    const c = this.get(pid), get = this._franchiseItems(pid);
    const started = this.library.seriesStarted(pid);
    const counts = { movie: 0, series: 0 };
    const items = [];
    for (const n of order === 'oldest' ? f.release : [...f.release].reverse()) {
      const e = f.items[n];
      const its = get(f, e);
      if (!its.length) continue;
      counts[e.kind]++;
      if (kind && e.kind !== kind) continue;
      const versions = this._decorate(pid, e.kind, its, c[e.kind === 'series' ? 'series' : 'movies']);
      for (const v of versions) v.started = e.kind === 'series' ? started.has(String(v.id)) : !!(v.watched || v.pos);
      const best = versions.find(v => v.started) || versions.find(v => v.poster) || versions[0];
      items.push({ n: items.length + 1, title: e.t, year: e.y, kind: e.kind, item: best, versions: versions.map(v => ({ id: v.id, name: v.name })) });
    }
    return { id: f.id, name: f.name, studio: true, order: order === 'oldest' ? 'oldest' : 'newest', kind: kind || '', counts, have: counts.movie + counts.series, total: f.items.length, items, next: -1 };
  }

  collection(pid, id, order = 'release', kind = '') {
    const f = franchises.byId(id);
    if (!f) return null;
    if (f.studio) return this._studio(pid, f, order, kind);
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
    const c = this.get(pid), want = homeSafe ? limit * 3 : limit;
    let items = null;
    // the section not read yet: the newest kept with the summary, when enough of them may be shown
    const kept = !this._isRead(c, section) && c.home && c.home[section];
    if (kept) {
      const rules = this.rules(pid, section), open = this.parental.isUnlocked();
      const shown = kept.filter(i => this._visible(i, rules, open));
      if (shown.length >= want || kept.length < HOME_KEEP) items = this._decorate(pid, KIND[section], shown.slice(0, want), c[section]);
    }
    if (!items) items = this.list(pid, { section, sort: 'added', limit: want }).items;
    items = items.filter(i => i.added);
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
        const show = this._find(this.get(pid), 'series', id);
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

  /** Now / next for a channel: from the full guide when it has the channel, else the provider's own listings. */
  async epg(pid, id) {
    const p = this.store.getProfile(pid);
    const full = this._fromGuide(pid, p, [id], false)[id];
    if (full) return full.slice(0, 4);
    if (p.type !== 'xtream') return [];
    await this.vpn.ensure();
    try { return await this.client(p).shortEpg(id); } catch { return []; }
  }

  /**
   * The full guide's programmes for some channels: { id: [...] } for the ones it has.
   * A new copy is fetched when it's due — waited for (wait) only when there's none yet.
   */
  _fromGuide(pid, p, ids, wait) {
    if (!Guide.address(p)) return {};
    const c = this.get(pid);
    const g = this.guide;
    if (g.due(pid)) {
      const want = this._isRead(c, 'live') ? new Set(c.live.items.map(i => i.epg).filter(Boolean)) : null;
      const job = g.refresh(pid, p, want);
      // none yet: wait a little for it (the TV Guide page), then go on with the provider's own listings
      if (wait && !g.get(pid)) return Promise.race([job, new Promise(ok => later(ok, 4000))]).then(() => this._fromGuide(pid, p, ids, false), () => ({}));
    }
    const out = {};
    for (const id of ids) {
      const ch = this._find(c, 'live', id);
      const list = ch && ch.epg ? g.lookup(pid, ch.epg) : null;
      if (list) out[id] = list;
    }
    return wait ? Promise.resolve(out) : out;
  }

  /**
   * The guide for several channels (the TV Guide page): { id: [{ title, desc, start, end }] },
   * from now on. The full guide first; the rest asked of the provider four channels at a time,
   * kept 15 minutes, so scrolling back costs nothing.
   */
  async epgMany(pid, ids, limit = 12) {
    const p = this.store.getProfile(pid);
    if (!Array.isArray(ids) || !ids.length) return {};
    ids = ids.slice(0, 60).map(String);
    const out = await this._fromGuide(pid, p, ids, true);
    if (p.type !== 'xtream') return out;
    await this.vpn.ensure();
    const x = this.client(p), now = Date.now();
    const cache = this._epg || (this._epg = new Map());
    const todo = [];
    for (const id of ids) {
      if (out[id]) continue;
      const c = cache.get(pid + ':' + id);
      if (c && now - c.at < 15 * 60000) out[id] = c.list;
      else todo.push(id);
    }
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        let list = null;
        try { list = await x.shortEpg(id, limit); } catch { /* none for this one */ }
        if (list) cache.set(pid + ':' + id, { at: Date.now(), list });
        out[id] = list || [];
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    while (cache.size > 3000) cache.delete(cache.keys().next().value);
    for (const id of Object.keys(out)) out[id] = out[id].filter(e => !e.end || e.end > now);
    return out;
  }

  /** The address to play. kind: live | movie | episode */
  async streamUrl(pid, { kind, id, ext, seriesId }) {
    const p = this.store.getProfile(pid);
    const c = this.get(pid);
    if (kind === 'live') this.guard(pid, 'live', this._find(c, 'live', id));
    else if (kind === 'movie') this.guard(pid, 'movies', this._find(c, 'movies', id));
    else this.guard(pid, 'series', this._find(c, 'series', seriesId));
    if (p.type === 'xtream') {
      const x = this.client(p);
      if (kind === 'live') {
        const fmts = (c.account && c.account.formats) || [];
        const want = p.liveFormat !== 'auto' ? p.liveFormat : (!fmts.length || fmts.includes('m3u8') ? 'm3u8' : 'ts');
        return { url: x.liveUrl(id, want), live: true };
      }
      if (kind === 'movie') {
        const m = this._find(c, 'movies', id);
        return { url: x.movieUrl(id, ext || (m && m.ext)), live: false };
      }
      return { url: x.episodeUrl(id, ext), live: false };
    }
    // M3U: the address is in the playlist
    if (kind === 'live' || kind === 'movie') {
      const i = this._find(c, kind === 'live' ? 'live' : 'movies', id);
      if (!i) throw new Error('This isn\'t in the playlist any more. Reload the playlist.');
      return { url: i.url, live: kind === 'live', ua: i.ua };
    }
    const show = this._find(c, 'series', seriesId);
    const e = show && show.episodes.find(x => x.id === String(id));
    if (!e) throw new Error('This episode isn\'t in the playlist any more. Reload the playlist.');
    return { url: e.url, live: false, ua: e.ua };
  }
}

module.exports = { Catalog, SECTIONS, KIND, matchRank, coreName };
