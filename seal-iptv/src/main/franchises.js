/* =====================================================================
 * Seal IPTV — franchises.js
 * ---------------------------------------------------------------------
 * Collections: Marvel, Star Wars, Star Trek … in release order or in
 * story order, movies and the shows that belong with them.
 *
 *   1. The list (franchises.json, kept by hand; ships with each release)
 *   2. Matching the playlist's titles to it
 *   3. Search
 *
 * Matching: the provider's name is cleaned like for posters (artwork.js
 * cleanTitle: "EN | Iron Man (2008) 4K" -> "Iron Man", 2008), then compared
 * letters and digits only, with "Episode IV" left out. Movies only match
 * movies, shows only shows. When both have a year it must be within one
 * (Casino Royale 1967 isn't the Bond film); a title that's in the list twice
 * (Planet of the Apes 1968 / 2001) needs the year to tell them apart.
 * ===================================================================== */
const { cleanTitle, norm } = require('./artwork');

const keyOf = s => norm(String(s || '').replace(/\bepisode\s+[ivx]+\b/gi, ' '));

/* =================================================================
 * 1. THE LIST
 * ================================================================= */
/** Checks and prepares franchises.json (throws on a mistake in it — the tests run this). */
function prepare(data) {
  return data.franchises.map(f => {
    const items = f.items.map((e, i) => ({
      i, t: e.t, kind: e.k === 'series' ? 'series' : 'movie', d: e.d, y: Number(String(e.d).slice(0, 4)) || 0,
      keys: [...new Set([e.t, ...(e.alt || [])].map(keyOf).filter(Boolean))]
    }));
    const release = items.map(e => e.i).sort((a, b) => items[a].d.localeCompare(items[b].d) || a - b);
    // story: titles; one used twice is 'series:Title' / 'movie:Title' or 'Title (1968)'
    const ref = r => {
      let kind = null, t = r;
      const m = /^(series|movie):(.*)$/.exec(t);
      if (m) { kind = m[1]; t = m[2]; }
      const y = /^(.*) \((\d{4})\)$/.exec(t);
      if (y) t = y[1];
      const found = items.filter(e => e.t === t && (!kind || e.kind === kind) && (!y || e.y === Number(y[2])));
      if (found.length !== 1) throw new Error(`${f.id}: story entry "${r}" matches ${found.length} titles`);
      return found[0].i;
    };
    const story = f.story ? f.story.map(ref) : null;
    if (story && (story.length !== items.length || new Set(story).size !== items.length)) throw new Error(`${f.id}: the story order must list every title once`);
    return { id: f.id, name: f.name, words: [f.name, ...(f.words || [])].map(w => w.toLowerCase()), storyNote: f.storyNote || '', items, release, story };
  });
}

let ALL = null;
const all = () => (ALL = ALL || prepare(require('./franchises.json')));
const byId = id => all().find(f => f.id === id) || null;

/* =================================================================
 * 2. MATCHING
 * ================================================================= */
/**
 * movies / series: the catalogue's items ({ id, name, year }).
 * -> Map "<franchise id>:<entry>" -> [items] (more than one = several versions: 4K, HD …)
 */
function match(movies, series, list = all()) {
  const index = { movie: new Map(), series: new Map() };
  for (const f of list) {
    for (const e of f.items) {
      for (const k of e.keys) {
        const m = index[e.kind];
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ f, e });
      }
    }
  }
  const out = new Map();
  const add = (kind, items) => {
    for (const it of items || []) {
      const { title, year } = cleanTitle(it.name, it.year);
      const found = index[kind].get(keyOf(title));
      if (!found) continue;
      // per franchise: the one entry this is (or none when the year can't tell)
      const per = new Map();
      for (const c of found) { if (!per.has(c.f.id)) per.set(c.f.id, []); per.get(c.f.id).push(c.e); }
      for (const [fid, entries] of per) {
        let ok = entries;
        if (year) ok = entries.filter(e => !e.y || Math.abs(e.y - year) <= 1 || (kind === 'series' && entries.length === 1));
        if (ok.length !== 1) continue;
        const key = fid + ':' + ok[0].i;
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(it);
      }
    }
  };
  add('movie', movies);
  add('series', series);   // a show's year is often its latest season: only used to tell two shows apart
  return out;
}

/* =================================================================
 * 3. SEARCH
 * ================================================================= */
/** Does the search text name this franchise? ("star" finds Star Wars and Star Trek) */
function matchesQuery(f, q) {
  const s = String(q || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!s) return false;
  return f.words.some(w => w === s || (s.length >= 3 && w.startsWith(s)));
}

module.exports = { all, byId, match, matchesQuery, prepare, keyOf };
