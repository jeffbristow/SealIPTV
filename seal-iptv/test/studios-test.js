/* Seal IPTV — tests for the Disney / Netflix / Prime collections: reading Wikipedia's tables (tools/studios.js),
   keeping the list up to date (studios.js) and finding the titles in the playlist (franchises.js, catalog.js). */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { titlesOf } = require('../../tools/studios');
const { Studios, valid } = require('../src/main/studios');
const franchises = require('../src/main/franchises');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

const PAGE = `
<div class="mw-heading"><h2 id="Feature_films">Feature films</h2></div>
<table class="wikitable sortable"><tbody>
<tr><th>Title</th><th>Release date</th><th>Language</th></tr>
<tr><td><i><a href="/wiki/Red_Notice">Red Notice</a></i><sup class="reference">[1]</sup></td><td rowspan="2">November 12, 2021</td><td>English</td></tr>
<tr><td><i>Caf&#233; &amp; Friends</i></td><td>English</td></tr>
<tr><td><i>Untitled heist film</i></td><td>TBA</td><td>English</td></tr>
</tbody></table>
<div class="mw-heading"><h2 id="Exclusive">Exclusive international distribution</h2></div>
<div class="mw-heading"><h3 id="Films2">Feature films</h3></div>
<table class="wikitable"><tbody><tr><th>Title</th><th>Release date</th></tr><tr><td>Annihilation</td><td>March 12, 2018</td></tr></tbody></table>
<div class="mw-heading"><h2 id="Drama">Drama</h2></div>
<table class="wikitable"><tbody><tr><th>Title</th><th>Genre</th><th>Premiere</th></tr>
<tr><td>Stranger Things</td><td>Science fiction</td><td>July 15, 2016</td></tr>
<tr><td>Arrested Development (seasons 4–5)</td><td>Comedy</td><td>May 26, 2013</td></tr></tbody></table>
<table class="wikitable"><tbody><tr><th>Episode</th><th>Notes</th></tr><tr><td>1</td><td>x</td></tr></tbody></table>`;

const many = (n, k = 'movie') => Array.from({ length: n }, (_, i) => ({ t: 'Filler ' + i, y: 2000, k }));
const DATA = built => ({ built, studios: [
  { id: 'netflix', name: 'Netflix', words: ['netflix'], items: [{ t: 'Red Notice', y: 2021, k: 'movie' }, { t: 'Animals', y: 2026, k: 'movie' }, { t: 'Stranger Things', y: 2016, k: 'series' }, { t: 'The Crown', y: 2016, k: 'series' }, { t: 'Barbershop', y: 2026, k: 'series' }, ...many(50)] },
  { id: 'disney', name: 'Disney', words: ['disney'], items: [{ t: 'Frozen', y: 2013, k: 'movie' }, { t: 'Moana', y: 2016, k: 'movie' }, ...many(50)] }] });

(async () => {
  /* ---- Wikipedia's tables ---- */
  const got = titlesOf(PAGE, 'movie');
  ok(got.some(x => x.t === 'Red Notice' && x.y === 2021) && got.some(x => x.t === 'Café & Friends' && x.y === 2021), 'title and year from each row; a date spanning two rows, footnotes and entities handled');
  ok(!got.some(x => /Untitled/.test(x.t)), 'films without a date yet are left out');
  ok(!got.some(x => x.t === 'Annihilation'), 'a section of films shown only abroad is left out');
  ok(got.some(x => x.t === 'Stranger Things' && x.y === 2016) && !got.some(x => /Arrested/.test(x.t)), 'shows by their premiere; later seasons of someone else\'s show left out');
  ok(!got.some(x => x.t === '1'), 'tables without a title and a date are skipped');

  /* ---- keeping the list up to date ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-studios-'));
  try {
    let online = true, answer = DATA('2026-11-05');
    const asked = [];
    const fetch = async (url, o) => { asked.push({ url, ua: o.headers['User-Agent'] }); return { ok: true, status: 200, text: async () => JSON.stringify(answer) }; };
    const st = new Studios({ dir, allowed: () => online, fetch, shipped: DATA('2026-10-29'), userAgent: () => 'UA-1' });
    ok(st.data().built === '2026-10-29' && st.due(), 'at first: the list shipped with the app, a newer one due');
    const d = await st.refresh();
    ok(d && d.built === '2026-11-05' && st.data().built === '2026-11-05' && /raw\.githubusercontent\.com\/jeffbristow\/SealIPTV\/main\/seal-iptv\/src\/main\/studios\.json/.test(asked[0].url), 'the newest list fetched from GitHub');
    ok(!st.due() && (await st.refresh()) === null && asked.length === 1, 'then not again for a few days');
    answer = { built: '2026-12-01', studios: [{ id: 'netflix', name: 'Netflix', items: [] }] };
    ok(!valid(answer) && await st.refresh({ force: true }).then(() => false, () => true) && st.data().built === '2026-11-05', 'a broken download never replaces a good list');
    const st2 = new Studios({ dir, fetch, shipped: DATA('2027-01-01') });
    ok(st2.data().built === '2027-01-01', 'an app update that ships a newer list uses it');
    online = false;
    asked.length = 0;
    await new Studios({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-studios2-')), allowed: () => online, fetch, shipped: DATA('2026-10-29') }).refresh();
    ok(!asked.length, 'nothing is fetched while the VPN check is blocking');

    /* ---- in the playlist ---- */
    franchises.setStudios(DATA('2026-11-05'));
    ok(franchises.byId('studio-netflix') && franchises.byId('studio-netflix').studio, 'the studios are collections ("studio-netflix")');
    const store = new Store(dir, null);
    const p = store.saveProfile({ type: 'm3u', name: 'Test', m3uUrl: 'http://x.example.com/a.m3u' });
    const library = new Library(dir);
    const cat = new Catalog({ dir, store, vpn: { ensure: async () => {} }, library });
    const c = { fetchedAt: 5, account: null, live: { cats: [], items: [] },
      movies: { cats: [{ id: 'm1', name: 'Movies' }, { id: 'm2', name: 'Hidden one' }], items: [
        { id: 'rn', name: 'EN - Red Notice (2021)', year: 2021, cat: 'm1', poster: 'http://p/rn.jpg' }, { id: 'an', name: 'Animals (2019)', year: 2019, cat: 'm1' },
        { id: 'fz', name: 'Frozen (2013)', year: 2013, cat: 'm2' }, { id: 'mo', name: 'Moana (2016)', year: 2016, cat: 'm1' }] },
      series: { cats: [{ id: 's1', name: 'Series' }], items: [{ id: 'st', name: 'Stranger Things', year: 2025, cat: 's1' }, { id: 'cr', name: 'The Crown (2016)', year: 2016, cat: 's1' }, { id: 'bb', name: 'Barbershop (2005)', year: 2005, cat: 's1' }] } };
    cat._index(c); cat.mem.set(p.id, c);
    library.setCatFlag(p.id, 'movies:m2', { hide: true });
    const list = cat.collections(p.id);
    const nf = list.find(x => x.id === 'studio-netflix'), di = list.find(x => x.id === 'studio-disney');
    ok(list[0].studio && list[1].studio, 'the studios come first in Collections');
    ok(nf.have === 3 && nf.poster === 'http://p/rn.jpg', 'Netflix: what the playlist has of it; a card picture from it');
    ok(di.have === 1, 'a hidden category\'s titles aren\'t counted');
    const col = cat.collection(p.id, 'studio-netflix');
    ok(col.studio && col.items.length === 3 && col.items[0].item.id === 'rn' && col.items.slice(1).every(x => x.year === 2016), 'newest first');
    ok(!col.items.some(x => x.item && x.item.id === 'an'), 'a title with the same name from another year isn\'t it (Animals 2019 ≠ 2026)');
    ok(col.items.every(x => x.item), 'only what the playlist has (no greyed-out titles)');
    ok(!col.items.some(x => x.item.id === 'bb'), 'a show from years before the one listed started isn\'t it');
    const shows = cat.collection(p.id, 'studio-netflix', 'oldest', 'series');
    ok(shows.items.length === 2 && shows.items.every(x => x.kind === 'series') && shows.counts.movie === 1 && shows.counts.series === 2 && shows.order === 'oldest', 'shows only, oldest first; the counts of each');
    ok(franchises.matchesQuery(franchises.byId('studio-netflix'), 'netflix'), 'searching "netflix" finds the collection');
    // a newer list: matched again
    franchises.setStudios({ built: '2026-12-01', studios: [{ id: 'netflix', name: 'Netflix', words: ['netflix'], items: [{ t: 'Moana', y: 2016, k: 'movie' }, ...many(50)] }] });
    ok(cat.collection(p.id, 'studio-netflix').items.map(x => x.item.id).join() === 'mo', 'a newer list is used at once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nStudio collections tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
