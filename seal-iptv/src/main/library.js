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
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const MAX_PROGRESS = 500;   // oldest resume points are dropped after this
const MIN_RESUME = 30;      // seconds: earlier than this isn't worth resuming

const cleanMeta = m => {
  const out = {};
  for (const k of ['name', 'image', 'seriesId', 'seriesName', 'ext', 'cat']) if (m && m[k] != null) out[k] = String(m[k]).slice(0, 500);
  for (const k of ['season', 'episode']) if (m && Number.isFinite(Number(m[k]))) out[k] = Number(m[k]);
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
    d = { favorites: d.favorites || {}, watched: d.watched || {}, progress: d.progress || {}, cats: d.cats || {} };
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

  /** { fav, watched, pos, dur } for a list of keys. */
  flags(pid, keys) {
    const d = this._get(pid), out = {};
    for (const k of keys) {
      const p = d.progress[k];
      out[k] = { fav: !!d.favorites[k], watched: !!d.watched[k], pos: p ? p.pos : 0, dur: p ? p.dur : 0 };
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

  /* =================================================================
   * 3. WATCHED
   * ================================================================= */
  setWatched(pid, key, on, meta) {
    const d = this._get(pid);
    const hadPos = !!d.progress[key];
    if (on) {
      d.watched[key] = { ...cleanMeta(meta), at: this._now() };
      delete d.progress[key];          // finished: nothing to resume
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

  /** "Continue watching": movies and episodes with a resume point, newest first. */
  continueWatching(pid, limit = 20) {
    const d = this._get(pid);
    return Object.entries(d.progress)
      .filter(([k]) => !d.watched[k])
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, limit)
      .map(([key, p]) => ({ key, kind: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1), ...p }));
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
    d.watched = {};
    d.progress = {};
    this._changed(pid);
  }

  /* =================================================================
   * 6. SYNC (sync.js)
   * ================================================================= */
  /** A record from another PC: type fav | seen | pos | cat; d null = removed. */
  applyRecord(type, pid, key, d) {
    const map = { fav: 'favorites', seen: 'watched', pos: 'progress', cat: 'cats' }[type];
    if (!map || !pid || !key) return;
    const L = this._get(pid);
    if (d && typeof d === 'object') {
      L[map][key] = d;
      if (type === 'seen') delete L.progress[key];
    } else {
      delete L[map][key];
    }
    this._changed(pid);
  }

  /** The same playlist under two ids (set up on two PCs before syncing): move one library into the other. */
  mergeInto(from, to) {
    const a = this._get(from), b = this._get(to);
    for (const map of ['favorites', 'watched', 'progress']) {
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
