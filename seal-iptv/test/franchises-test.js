/* Seal IPTV self-test: Collections (franchises.js) — the list, matching provider titles, the order, Next up. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const franchises = require('../src/main/franchises');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

// 1. the list itself (prepare throws on a story entry that's missing, doubled or unclear)
const all = franchises.all();
ok(all.length >= 15 && all.every(f => f.items.length >= 3), `the list: ${all.length} collections, ${all.reduce((n, f) => n + f.items.length, 0)} titles`);
ok(all.every(f => f.items.every(e => /^\d{4}-\d\d-\d\d$/.test(e.d))), 'every title has a release date');
ok(new Set(all.map(f => f.id)).size === all.length, 'collection ids are unique');
for (const f of all) {
  const seen = new Set();
  for (const e of f.items) for (const k of e.keys) { const id = e.kind + k + e.y; assert.ok(!seen.has(id), `${f.id}: "${e.t}" listed twice`); seen.add(id); }
}
ok(true, 'no title is listed twice in a collection');
assert.throws(() => franchises.prepare({ franchises: [{ id: 'x', name: 'X', items: [{ t: 'A', d: '2000-01-01' }, { t: 'B', d: '2001-01-01' }], story: ['A'] }] }), /every title once/);
assert.throws(() => franchises.prepare({ franchises: [{ id: 'x', name: 'X', items: [{ t: 'A', d: '2000-01-01' }], story: ['Nope'] }] }), /matches 0/);
ok(true, 'a story order that misses or invents a title is refused');
const mcu = franchises.byId('mcu');
ok(mcu.items[mcu.release[0]].t === 'Iron Man' && mcu.items[mcu.story[0]].t === 'Captain America: The First Avenger', 'MCU: Iron Man first by release, Captain America first in the story');

// 2. matching messy provider names
const movies = [
  { id: 'm1', name: 'EN | Iron Man (2008) 4K', year: 0 },
  { id: 'm2', name: 'Iron Man', year: 2008, poster: 'http://x/im.jpg' },
  { id: 'm3', name: 'Star Wars: Episode IV - A New Hope (1977)', year: 1977 },
  { id: 'm4', name: 'Spiderman No Way Home', year: 2021 },
  { id: 'm5', name: 'Casino Royale', year: 1967 },
  { id: 'm6', name: 'Casino Royale', year: 2006 },
  { id: 'm7', name: 'Planet of the Apes', year: 2001 },
  { id: 'm8', name: 'Planet of the Apes', year: 0 },
  { id: 'm9', name: 'Harry Potter and the Sorcerer\'s Stone', year: 2001 },
  { id: 'm10', name: 'Thunderbolts*', year: 2025 },
  { id: 'm11', name: 'Loki', year: 2021 },
  { id: 'm12', name: 'Avengers: Endgame', year: 2019 }
];
const series = [
  { id: 's1', name: 'Loki', year: 2023 },
  { id: 's2', name: 'Star Wars: Andor', year: 2022 }
];
const m = franchises.match(movies, series);
const at = (fid, title, kind = 'movie', y = 0) => (m.get(fid + ':' + franchises.byId(fid).items.find(e => e.t === title && e.kind === kind && (!y || e.y === y)).i) || []).map(i => i.id).join(',');
ok(at('mcu', 'Iron Man') === 'm1,m2', 'prefix, year and 4K cleaned off; two versions of one film kept together');
ok(at('starwars', 'Star Wars: A New Hope') === 'm3', '"Episode IV -" in the provider\'s title still matches');
ok(at('mcu', 'Spider-Man: No Way Home') === 'm4', 'Spiderman = Spider-Man');
ok(at('bond', 'Casino Royale') === 'm6', 'same name, another year (Casino Royale 1967): not matched');
ok(at('apes', 'Planet of the Apes', 'movie', 2001) === 'm7' && at('apes', 'Planet of the Apes', 'movie', 1968) === '' && ![...m.values()].some(l => l.some(i => i.id === 'm8')), 'a title in the list twice: the year decides; without a year, no match');
ok(at('wizarding', 'Harry Potter and the Philosopher\'s Stone') === 'm9', 'the US title matches too');
ok(at('mcu', 'Thunderbolts*') === 'm10', 'punctuation like * doesn\'t matter');
ok(at('mcu', 'Loki', 'series') === 's1', 'shows match shows (a show\'s year may be its latest season)');
ok(![...m.values()].some(l => l.some(i => i.id === 'm11')), 'a movie called Loki isn\'t the show');
ok(at('starwars', 'Andor', 'series') === 's2', 'other titles of a show (Star Wars: Andor)');
ok(franchises.matchesQuery(franchises.byId('starwars'), 'Star Wars') && franchises.matchesQuery(franchises.byId('startrek'), 'star') && !franchises.matchesQuery(mcu, 'st'), 'search: "star wars", "star" finds both; two letters find nothing');

// 3. through the catalogue: hidden categories, the order, Next up
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-fr-'));
try {
  const store = new Store(dir, null);
  const library = new Library(dir);
  const cat = new Catalog({ dir, store, vpn: {}, library });
  const P = 'p1';
  const c = {
    fetchedAt: 1,
    live: { cats: [], items: [] },
    movies: { cats: [{ id: '1', name: 'Movies' }, { id: '9', name: 'Hidden' }], items: movies.map(i => ({ ...i, cat: i.id === 'm12' ? '9' : '1' })) },
    series: { cats: [{ id: '2', name: 'Shows' }], items: series.map(i => ({ ...i, cat: '2' })) }
  };
  cat._index(c);
  cat.mem.set(P, c);
  library.setCatFlag(P, 'movies:9', { hide: true });
  const list = cat.collections(P);
  const mc = list.find(x => x.id === 'mcu');
  ok(mc && mc.total === mcu.items.length && list.every(x => x.have > 0), 'Collections lists only the ones the playlist has something from');
  ok(cat.collections(P, 'star wars').map(x => x.id).join() === 'starwars', 'Collections search');
  let col = cat.collection(P, 'mcu', 'release');
  ok(col.items.length === mcu.items.length && col.items[0].title === 'Iron Man' && col.items[0].item.id === 'm2' && col.items[0].versions.length === 2, 'every title listed in order; the version with a poster is opened');
  ok(col.items[1].item === null, 'titles the playlist doesn\'t have: item null (shown greyed out)');
  ok(col.items.find(x => x.title === 'Avengers: Endgame').item === null, 'a film in a hidden category stays hidden here too');
  ok(col.next === 0, 'Next up: nothing watched yet = the first one you have');
  library.setWatched(P, 'movie:m1', true, { name: 'Iron Man' });
  col = cat.collection(P, 'mcu', 'release');
  ok(col.items[0].item.id === 'm1' && col.items[col.next].title === 'Loki', 'after watching Iron Man (the 4K one): that version is shown, Next up skips to the next one you have (the show Loki)');
  library.setProgress(P, 'episode:77', 600, 2400, { seriesId: 's1', seriesName: 'Loki', season: 1, episode: 1 });
  col = cat.collection(P, 'mcu', 'story');
  ok(col.order === 'story' && col.items[0].title === 'Captain America: The First Avenger', 'story order');
  ok(col.items[col.next].title === 'Spider-Man: No Way Home' && col.items.find(x => x.title === 'Loki').item.started, 'story order: a show you\'ve started counts as where you are');
  ok(cat.collection(P, 'bond', 'story').order === 'release', 'no story order for this one: release order');
  ok(cat.collection(P, 'nope') === null, 'an unknown collection: null');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\nCollections tests: ${passed} passed`);
