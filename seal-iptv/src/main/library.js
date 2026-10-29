/* =====================================================================
 * Seal IPTV — library.js
 * ---------------------------------------------------------------------
 * Favorites, watched marks and resume points, one file per playlist
 * (library-<profile id>.json), because stream IDs belong to a provider.
 *
 * Keys:  live:<id>  movie:<id>  series:<id>  episode:<id>
 * meta:  what the Home page needs without the catalogue:
 *        { name, image, seriesId, seriesName, season, episode, ext }
 *
 * Sections:
 *   1. Files (cached, saved shortly after a change)
 *   2. Favorites
 *   3. Watched
 *   4. Resume points
 *   5. Category choices
 *   6. My categories (the user's own: Kids, Date night …)
 *   6b. Watchlist (movies and series to watch later)
 *   6c. Up next (a series' next episode, once one is finished)
 *   7. Sync
 *   8. Titles that got a new id (a new playlist link: catalog.js moves them)
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const MAX_PROGRESS = 500;   // oldest resume points are dropped after this
const MIN_RESUME = 30;      // seconds: earlier than this isn't worth resuming

/** a series' name to tell copies of it apart from other shows: "FROM (2022)" = "From (2022)" = "EN - From" */
const showName = n => String(n || '').toLowerCase().replace(/^\s*[a-z]{2,3}\s*[-:|]\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

const cleanMeta = m => {
  const out = {};
  for (const k of ['name', 'image', 'seriesId', 'seriesName', 'ext', 'cat']) if (m && m[k] != null) out[k] = String(m[k]).slice(0, 500);
  for (const k of ['season', 'episode', 'upd']) if (m && Number.isFinite(Number(m[k]))) out[k] = Number(m[k]);
  return out;
};

class Library {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.timers = new Map();
    this.lastAt = 0;
    this.onChange = null;          // (record name, data | null) — sync.js listens
  }

  _emit(type, pid, key, d) { if (this.onChange) this.onChange(`${type}:${pid}:${key}`, d == null ? null : d); }

  /** Always increasing, so two changes in the same millisecond still sort in order. */
  _now() { this.lastAt = Math.max(Date.now(), this.lastAt + 1); return this.lastAt; }

  /* =================================================================
   * 1. FILES
   * ================================================================= */
  _file(pid) { return path.join(this.dir, `library-${String(pid).replace(/[^\w-]/g, '')}.json`); }

  _get(pid) {
    if (!pid) throw new Error('No playlist selected');
    let d = this.cache.get(pid);
    if (d) return d;
    try { d = JSON.parse(fs.readFileSync(this._file(pid), 'utf8')); } catch { d = {}; }
    d = { favorites: d.favorites || {}, watched: d.watched || {}, progress: d.progress || {}, cats: d.cats || {}, lists: d.lists || {}, listed: d.listed || {}, watch: d.watch || {}, next: d.next || {} };
    this.cache.set(pid, d);
    return d;
  }

  _changed(pid) {
    clearTimeout(this.timers.get(pid));
    this.timers.set(pid, setTimeout(() => this.flush(pid), 400));
  }

  /** Writes now (also called when the app closes). */
  flush(pid) {
    const ids = pid ? [pid] : [...this.cache.keys()];
    for (const id of ids) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      const d = this.cache.get(id);
      if (!d) continue;
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this._file(id), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d));
      fs.renameSync(tmp, f);
    }
  }

  /** Removes a playlist's library (when the playlist is deleted). */
  remove(pid) {
    clearTimeout(this.timers.get(pid));
    this.cache.delete(pid);
    try { fs.unlinkSync(this._file(pid)); } catch { /* none */ }
  }

  /** { fav, watched, pos, dur, wl } for a list of keys (wl: on the watchlist). */
  flags(pid, keys) {
    const d = this._get(pid), out = {};
    for (const k of keys) {
      const p = d.progress[k];
      out[k] = { fav: !!d.favorites[k], watched: !!d.watched[k], pos: p ? p.pos : 0, dur: p ? p.dur : 0, wl: !!d.watch[k] };
    }
    return out;
  }

  /* =================================================================
   * 2. FAVORITES
   * ================================================================= */
  setFavorite(pid, key, on, meta) {
    const d = this._get(pid);
    if (on) {
      const f = d.favorites[key] = { ...cleanMeta(meta), at: this._now() };
      // once the user has arranged this kind, a new favorite goes at the end
      const orders = this._favs(d, key.slice(0, key.indexOf(':'))).map(([, m]) => m.order).filter(Number.isFinite);
      if (orders.length) f.order = Math.max(...orders) + 1;
    } else delete d.favorites[key];
    this._changed(pid);
    this._emit('fav', pid, key, d.favorites[key]);
    return !!on;
  }

  _favs(d, kind) { return Object.entries(d.favorites).filter(([k]) => !kind || k.startsWith(kind + ':')); }

  /**
   * kind: 'live' | 'movie' | 'series'. sort: 'added' (newest first) | 'name' (A–Z) |
   * 'custom' (the user's order: by order; ones without one after, oldest first —
   * none arranged yet = newest first, as 'added').
   */
  favorites(pid, kind, sort = 'added') {
    const list = this._favs(this._get(pid), kind);
    const custom = sort === 'custom' && list.some(([, m]) => Number.isFinite(m.order));
    const by = sort === 'name' ? (a, b) => String(a[1].name || '').localeCompare(String(b[1].name || ''), undefined, { numeric: true, sensitivity: 'base' }) || b[1].at - a[1].at
      : custom ? (a, b) => (Number.isFinite(a[1].order) ? a[1].order : Infinity) - (Number.isFinite(b[1].order) ? b[1].order : Infinity) || a[1].at - b[1].at
        : (a, b) => b[1].at - a[1].at;
    return list.sort(by).map(([key, m]) => ({ key, id: key.slice(key.indexOf(':') + 1), ...m }));
  }

  /**
   * The user's order for one kind. keys: the favorites shown, in their new order;
   * ones not shown (hidden or locked categories) keep their places.
   * Only the favorites whose place changed are saved (and synced).
   */
  arrangeFavorites(pid, kind, keys) {
    const d = this._get(pid);
    const all = this.favorites(pid, kind, 'custom').map(f => f.key);
    const moved = [...new Set((keys || []).map(String))].filter(k => all.includes(k));
    const slots = new Set(moved);
    let n = 0;
    all.forEach((k, i) => {
      const key = slots.has(k) ? moved[n++] : k;
      const f = d.favorites[key];
      if (f.order !== i) { f.order = i; this._emit('fav', pid, key, f); }
    });
    this._changed(pid);
    return this.favorites(pid, kind, 'custom');
  }

  /** ids of the series that have an episode watched or started (Collections: where you are) */
  seriesStarted(pid) {
    const d = this._get(pid), out = new Set();
    for (const map of [d.watched, d.progress]) for (const v of Object.values(map)) if (v && v.seriesId) out.add(String(v.seriesId));
    return out;
  }

  /* =================================================================
   * 3. WATCHED
   * ================================================================= */
  setWatched(pid, key, on, meta) {
    const d = this._get(pid);
    const hadPos = !!d.progress[key];
    if (on) {
      d.watched[key] = { ...cleanMeta(meta), at: this._now() };
      delete d.progress[key];          // finished: nothing to resume
      // a movie watched is off the watchlist (a series stays: there may be more episodes)
      if (key.startsWith('movie:') && d.watch[key]) { delete d.watch[key]; this._emit('watch', pid, key, null); }
    } else {
      delete d.watched[key];
    }
    this._changed(pid);
    this._emit('seen', pid, key, d.watched[key]);
    if (on && hadPos) this._emit('pos', pid, key, null);
    return !!on;
  }

  /** Several at once (a whole season). */
  setWatchedMany(pid, items, on) {
    for (const it of items || []) this.setWatched(pid, it.key, on, it.meta);
    return items ? items.length : 0;
  }

  /* =================================================================
   * 4. RESUME POINTS
   * ================================================================= */
  setProgress(pid, key, pos, dur, meta) {
    const d = this._get(pid);
    pos = Number(pos) || 0;
    dur = Number(dur) || 0;
    const had = !!d.progress[key];
    if (pos < MIN_RESUME || (dur && dur - pos < 20)) {
      delete d.progress[key];          // too early, or right at the end
      if (had) this._emit('pos', pid, key, null);
    } else {
      d.progress[key] = { pos: Math.floor(pos), dur: Math.floor(dur), at: this._now(), ...cleanMeta(meta) };
      const all = Object.entries(d.progress);
      if (all.length > MAX_PROGRESS) {
        all.sort((a, b) => a[1].at - b[1].at).slice(0, all.length - MAX_PROGRESS).forEach(([k]) => delete d.progress[k]);
      }
      this._emit('pos', pid, key, d.progress[key]);
    }
    this._changed(pid);
  }

  getProgress(pid, key) {
    const p = this._get(pid).progress[key];
    return p ? { pos: p.pos, dur: p.dur } : null;
  }

  clearProgress(pid, key) {
    const d = this._get(pid);
    if (!d.progress[key]) return;
    delete d.progress[key];
    this._changed(pid);
    this._emit('pos', pid, key, null);
  }

  /**
   * "Continue watching": movies and episodes with a resume point, and a series' next episode
   * once one is finished (upNext) — newest first, one entry per series (what was done last).
   */
  continueWatching(pid, limit = 20) {
    const d = this._get(pid);
    // a series' episode finished after this one was left half-way: that resume point is behind (S2E3 after S2E7)
    const done = new Map();
    for (const [k, v] of Object.entries(d.watched)) if (k.startsWith('episode:') && v.seriesId && (v.at || 0) > (done.get(String(v.seriesId)) || 0)) done.set(String(v.seriesId), v.at);
    const list = Object.entries(d.progress).filter(([k, p]) => !d.watched[k] && !(k.startsWith('episode:') && p.seriesId && (done.get(String(p.seriesId)) || 0) > p.at))
      .map(([key, p]) => ({ key, kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1), ...p }));
    for (const n of Object.values(d.next)) {
      if (!n || !n.key || d.watched[n.key] || d.progress[n.key]) continue;
      list.push({ ...n, kind: 'episode', id: n.key.slice(n.key.indexOf(':') + 1), pos: 0, dur: 0, upNext: true });
    }
    list.sort((a, b) => b.at - a.at);
    // one entry per series — also when the provider lists it twice ("From (2022)" / "FROM (2022)")
    const shows = new Set();
    return list.filter(p => {
      if (p.kind !== 'episode' || !p.seriesId) return true;
      const ids = [String(p.seriesId), showName(p.seriesName)].filter(Boolean);
      if (ids.some(k => shows.has(k))) return false;
      ids.forEach(k => shows.add(k));
      return true;
    }).slice(0, limit);
  }

  /* =================================================================
   * 5. CATEGORY CHOICES
   *    "<section>:<category id>" -> { hide: true, lock: true | false, show: true }
   *    lock false = unlocked although its name says Adult; show = shown
   *    although it looks like another language.
   * ================================================================= */
  catFlags(pid) { return this._get(pid).cats; }

  setCatFlag(pid, key, patch) {
    const d = this._get(pid);
    const f = { ...(d.cats[key] || {}) };
    for (const k of ['hide', 'lock', 'show']) {
      if (!(k in patch)) continue;
      if (patch[k] === null || patch[k] === undefined || (k !== 'lock' && patch[k] === false)) delete f[k];
      else f[k] = !!patch[k];
    }
    if (Object.keys(f).length) d.cats[key] = f; else delete d.cats[key];
    this._changed(pid);
    this._emit('cat', pid, key, d.cats[key]);
    return f;
  }

  /** Forget every watched mark and resume point of a playlist. */
  clearHistory(pid) {
    const d = this._get(pid);
    for (const k of Object.keys(d.watched)) this._emit('seen', pid, k, null);
    for (const k of Object.keys(d.progress)) this._emit('pos', pid, k, null);
    for (const k of Object.keys(d.next)) this._emit('next', pid, k, null);
    d.watched = {};
    d.progress = {};
    d.next = {};
    this._changed(pid);
  }

  /* =================================================================
   * 6. MY CATEGORIES — the user's own, next to Movies / Series in the menu
   *    lists:  "<list id>" -> { name, icon, at }
   *    listed: "<list id>/<key>" -> meta + at   (key = live:1, movie:9, series:4)
   * ================================================================= */
  /** [{ id, name, icon, count }], in the order they were made */
  lists(pid) {
    const d = this._get(pid), n = {};
    for (const k of Object.keys(d.listed)) { const lid = k.slice(0, k.indexOf('/')); n[lid] = (n[lid] || 0) + 1; }
    return Object.entries(d.lists).sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
      .map(([id, l]) => ({ id, name: l.name, icon: l.icon || '', count: n[id] || 0 }));
  }

  /** a new category (id null) or a new name / icon for one; returns its id */
  saveList(pid, id, { name, icon } = {}) {
    const d = this._get(pid);
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) throw new Error('Give the category a name.');
    if (id && !d.lists[id]) throw new Error('That category is gone (removed on another device?).');
    if (!id) do id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); while (d.lists[id]);
    const l = d.lists[id] = { ...(d.lists[id] || {}), name, icon: String(icon || '').slice(0, 8), at: (d.lists[id] && d.lists[id].at) || this._now() };
    this._changed(pid);
    this._emit('list', pid, id, l);
    return id;
  }

  /** the category and everything in it */
  removeList(pid, id) {
    const d = this._get(pid);
    for (const k of Object.keys(d.listed)) if (k.startsWith(id + '/')) { delete d.listed[k]; this._emit('listed', pid, k, null); }
    delete d.lists[id];
    this._changed(pid);
    this._emit('list', pid, id, null);
  }

  /** put a channel / movie / series in a category, or take it out */
  setListed(pid, lid, key, on, meta) {
    const d = this._get(pid);
    if (!d.lists[lid]) throw new Error('That category is gone (removed on another device?).');
    const k = lid + '/' + key;
    const old = d.listed[k];
    if (on) d.listed[k] = { ...cleanMeta(meta), ...(old && old.title ? { title: old.title } : {}), at: this._now() };
    else if (old) delete d.listed[k];
    else return false;
    this._changed(pid);
    this._emit('listed', pid, k, d.listed[k]);
    return !!on;
  }

  /** the name it's shown with in this category only ("NBC" for "FL | Fort Myers | NBC WBBH"); '' = its own name */
  setListedTitle(pid, lid, key, title) {
    const d = this._get(pid);
    const k = lid + '/' + key, it = d.listed[k];
    if (!it) throw new Error('That isn\'t in this category any more.');
    title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title && title !== it.name) it.title = title; else delete it.title;
    it.at = this._now();
    this._changed(pid);
    this._emit('listed', pid, k, it);
    return it.title || '';
  }

  /** what's in a category: [{ key, kind, id, name, title?, image … }], A–Z by the name shown */
  listItems(pid, lid) {
    const d = this._get(pid);
    const shown = m => String(m.title || m.name || '');
    return Object.entries(d.listed).filter(([k]) => k.startsWith(lid + '/'))
      .map(([k, m]) => { const key = k.slice(lid.length + 1); return { key, kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1), ...m }; })
      .sort((a, b) => shown(a).localeCompare(shown(b), undefined, { numeric: true, sensitivity: 'base' }));
  }

  /** the ids of the categories a key is in */
  listsOf(pid, key) {
    const d = this._get(pid);
    return Object.keys(d.lists).filter(lid => d.listed[lid + '/' + key]);
  }

  /* =================================================================
   * 6b. WATCHLIST — "watch:<key>" -> meta + at   (key = movie:9, series:4)
   *     a series keeps upd: the provider's "last changed" when it was added (or last opened),
   *     so a newer one means new episodes
   * ================================================================= */
  /** add a movie / series, or take it off; on again only updates it (upd), keeping its place */
  setWatchlist(pid, key, on, meta) {
    if (!/^(movie|series):/.test(key)) throw new Error('Only movies and series go on the watchlist.');
    const d = this._get(pid), old = d.watch[key];
    if (on) {
      const w = { ...(old || {}), ...cleanMeta(meta), at: old ? old.at : this._now() };
      if (old && JSON.stringify(w) === JSON.stringify(old)) return true;   // nothing new: nothing to sync
      d.watch[key] = w;
    } else if (old) delete d.watch[key];
    else return false;
    this._changed(pid);
    this._emit('watch', pid, key, d.watch[key]);
    return !!on;
  }

  onWatchlist(pid, key) { return !!this._get(pid).watch[key]; }

  /** [{ key, kind, id, name, image, upd … }], the newest added first */
  watchlist(pid) {
    return Object.entries(this._get(pid).watch).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .map(([key, m]) => ({ key, kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1), ...m }));
  }

  /* =================================================================
   * 6c. UP NEXT — "next:<series id>" -> { key: episode:<id>, name, image, seriesId, seriesName, season, episode, ext, at }
   *     set when an episode is finished (the player knows the next one); null: the series is done
   * ================================================================= */
  setNext(pid, seriesId, ep, at = null) {
    const d = this._get(pid), sid = String(seriesId || '');
    if (!sid) return false;
    if (ep && ep.id) d.next[sid] = { key: 'episode:' + ep.id, ...cleanMeta({ ...ep, seriesId: sid }), at: at || this._now() };
    else if (d.next[sid]) delete d.next[sid];
    else return false;
    this._changed(pid);
    this._emit('next', pid, sid, d.next[sid]);
    return true;
  }

  hasNext(pid, seriesId) { return !!this._get(pid).next[String(seriesId)]; }

  /**
   * Series whose last thing done was finishing an episode, without an up next yet (from before it was
   * kept, or finished without the player's list): [{ seriesId, season, episode, at, meta }], newest first.
   */
  finishedWithoutNext(pid, { days = 30, limit = 5 } = {}) {
    const d = this._get(pid), since = Date.now() - days * 86400000, last = new Map();
    for (const [k, v] of Object.entries(d.watched)) {
      if (!k.startsWith('episode:') || !v.seriesId || (v.at || 0) < since) continue;
      const sid = String(v.seriesId), had = last.get(sid);
      if (!had || v.at > had.at) last.set(sid, { seriesId: sid, season: v.season, episode: v.episode, at: v.at, meta: v });
    }
    for (const [k, v] of Object.entries(d.progress)) {
      const sid = v.seriesId && String(v.seriesId);
      if (sid && last.has(sid) && !d.watched[k] && v.at > last.get(sid).at) last.delete(sid);   // started another since
    }
    // the newest of a series listed twice by the provider is enough
    const names = new Set();
    return [...last.values()].filter(x => !d.next[x.seriesId]).sort((a, b) => b.at - a.at)
      .filter(x => { const n = showName(x.meta.seriesName); if (n && names.has(n)) return false; if (n) names.add(n); return true; }).slice(0, limit);
  }

  /* =================================================================
   * 7. SYNC (sync.js)
   * ================================================================= */
  /** A record from another PC: type fav | seen | pos | cat | list | listed | watch | next; d null = removed. */
  applyRecord(type, pid, key, d) {
    const map = { fav: 'favorites', seen: 'watched', pos: 'progress', cat: 'cats', list: 'lists', listed: 'listed', watch: 'watch', next: 'next' }[type];
    if (!map || !pid || !key) return;
    const L = this._get(pid);
    if (d && typeof d === 'object') {
      L[map][key] = d;
      if (type === 'seen') delete L.progress[key];
    } else {
      delete L[map][key];
      // a category removed: what was in it goes too (those removals come as records as well)
      if (type === 'list') for (const k of Object.keys(L.listed)) if (k.startsWith(key + '/')) delete L.listed[k];
    }
    this._changed(pid);
  }

  /* =================================================================
   * 8. TITLES THAT GOT A NEW ID (a new playlist link, another provider: catalog.js _carryOver)
   * ================================================================= */
  /** Every title the library has something about: [{ key, meta }] (favorites, watched, resume points, watchlist, my categories). */
  entries(pid) {
    const d = this._get(pid), seen = new Map();
    for (const map of ['favorites', 'watched', 'progress', 'watch']) for (const [k, m] of Object.entries(d[map])) if (!seen.has(k)) seen.set(k, m);
    for (const [k, m] of Object.entries(d.listed)) { const key = k.slice(k.indexOf('/') + 1); if (!seen.has(key)) seen.set(key, m); }
    return [...seen].map(([key, meta]) => ({ key, meta }));
  }

  /**
   * Move what the library has about some titles to their new keys: moves = Map(old key -> { key, meta? })
   * (meta: fields to change, e.g. an episode's seriesId). Where the new key already has its own, the newer one stays.
   * Sent to the other devices like any change. -> how many titles moved
   */
  remap(pid, moves) {
    const d = this._get(pid);
    let n = 0, moved = false, any = false;
    const move = (map, type, from, to, patch) => {
      const v = d[map][from];
      if (!v) return;
      moved = any = true;
      const keep = from === to || !d[map][to] || (v.at || 0) > (d[map][to].at || 0);
      delete d[map][from];
      this._emit(type, pid, from, null);
      if (keep) { d[map][to] = { ...v, ...patch }; this._emit(type, pid, to, d[map][to]); }
    };
    for (const [from, { key: to, meta = {} }] of moves) {
      if (!to || (to === from && !Object.keys(meta).length)) continue;
      moved = false;
      move('favorites', 'fav', from, to, meta);
      move('watched', 'seen', from, to, meta);
      move('progress', 'pos', from, to, meta);
      move('watch', 'watch', from, to, meta);
      for (const lid of Object.keys(d.lists)) move('listed', 'listed', lid + '/' + from, lid + '/' + to, meta);
      if (moved && to !== from) n++;
    }
    for (const k of Object.keys(d.progress)) if (d.watched[k] && d.watched[k].at > d.progress[k].at) delete d.progress[k];
    if (any) this._changed(pid);
    return n;
  }

  /** The same playlist under two ids (set up on two PCs before syncing): move one library into the other. */
  mergeInto(from, to) {
    const a = this._get(from), b = this._get(to);
    for (const map of ['favorites', 'watched', 'progress', 'lists', 'listed', 'watch', 'next']) {
      for (const [k, v] of Object.entries(a[map])) if (!b[map][k] || (v.at || 0) > (b[map][k].at || 0)) b[map][k] = v;
    }
    for (const [k, v] of Object.entries(a.cats)) if (!b.cats[k]) b.cats[k] = v;
    for (const k of Object.keys(b.progress)) if (b.watched[k] && b.watched[k].at > b.progress[k].at) delete b.progress[k];
    this._changed(to);
    this.flush(to);
    this.remove(from);
  }
}

module.exports = { Library, MIN_RESUME };
