/* Seal IPTV — tests for Trending movies / series (trending.js) and finding them in the playlist (catalog.js). */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Trending, titleKey, parseNetflix, merge, serviceOf } = require('../src/main/trending');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

const TSV = ['week\tcategory\tweekly_rank\tshow_title\tseason_title\tweekly_hours_viewed\truntime\tweekly_views\tcumulative_weeks_in_top_10',
  '2026-10-18\tFilms (English)\t2\tDoing Life\tN/A\t1\t1\t1\t3',
  '2026-10-18\tFilms (English)\t1\tAnimals\tN/A\t1\t1\t1\t2',
  '2026-10-18\tFilms (English)\t3\tIce Age\tN/A\t1\t1\t1\t1',
  '2026-10-18\tTV (English)\t1\tBelow\tBelow: Limited Series\t1\t1\t1\t1',
  '2026-10-18\tTV (English)\t2\tThe Diplomat\tThe Diplomat: Season 4\t1\t1\t1\t1',
  '2026-10-18\tFilms (Non-English)\t1\tKatla\tN/A\t1\t1\t1\t1',
  '2026-10-11\tFilms (English)\t1\tLast Week\tN/A\t1\t1\t1\t1'].join('\r\n');
const show = (id, name, channel, weight, premiered = '2024-01-01', extra = {}) => ({ _embedded: { show: { id, name, language: 'English', type: 'Scripted', weight, premiered, webChannel: { name: channel }, ...extra } } });
const SCHEDULE = [show(1, 'VisionQuest', 'Disney+', 100, '2026-10-01'), show(2, 'Dark Matter', 'Apple TV+', 99, '2024-05-08'), show(3, 'The Diplomat', 'Netflix', 97, '2023-04-20'),
  show(4, 'Some Vlog', 'YouTube', 99), show(5, 'Late Talk', 'Hulu', 99, '2020-01-01', { type: 'Talk Show' }), show(6, 'Tiny Show', 'Peacock', 20)];

const calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, ua: opts && opts.headers && opts.headers['User-Agent'] });
  const u = new URL(url);
  const json = b => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.hostname === 'www.netflix.com') return { ok: true, status: 200, text: async () => TSV };
  if (u.hostname === 'api.tvmaze.com') return json(u.searchParams.get('date') === new Date().toISOString().slice(0, 10) ? SCHEDULE : []);
  if (u.hostname === 'api.themoviedb.org') {
    if (u.pathname === '/3/watch/providers/movie') return json({ results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 337, provider_name: 'Disney Plus' }, { provider_id: 99, provider_name: 'Some Rental Store' }] });
    if (u.pathname === '/3/discover/movie' && u.searchParams.get('with_watch_providers') === '337') return json({ results: [{ id: 1, title: 'Moana', release_date: '2016-11-23', original_language: 'en' }] });
    if (u.pathname === '/3/search/movie') return json({ results: u.searchParams.get('query') === 'Animals' ? [{ title: 'Animals', release_date: '2026-10-10' }] : [] });
    return json({ results: [] });
  }
  return { ok: false, status: 404 };
};

(async () => {
  /* ---- the lists ---- */
  ok(titleKey('EN - The Diplomat (2023)') === 'diplomat' && titleKey('|US| Diplomat') === 'diplomat', 'titles matched without tags, years and "The"');
  ok(titleKey('Love & Death') === titleKey('Love and Death') && titleKey('Amélie') === titleKey('Amelie'), '"&" = "and"; accents don\'t matter');
  const n = parseNetflix(TSV);
  ok(n.week === '2026-10-18' && n.movie.join() === 'Animals,Doing Life,Ice Age' && n.series.join() === 'Below,The Diplomat', 'Netflix Top 10: the latest week, English, in order');
  ok(serviceOf('Apple TV+') === 'Apple TV' && serviceOf('Disney Plus') === 'Disney+' && serviceOf('Peacock Premium') === 'Peacock' && serviceOf('YouTube') === '', 'services by their TVmaze / TMDB names');
  const m = merge([{ kind: 'series', service: 'Netflix', weight: 3, top: true, titles: [{ t: 'Below' }, { t: 'The Diplomat' }] },
    { kind: 'series', service: 'Netflix', weight: 2, titles: [{ t: 'The Diplomat', y: 2023, pop: 0.97 }] }], 'series');
  const dip = m.find(x => x.t === 'The Diplomat');
  ok(m[0].t === 'Below' && dip.score > 4.5 && dip.y === 2023 && dip.tags.join() === 'Netflix #2', 'a title counts by its best place, a second list adds a little; one tag per service, with its Top 10 place');

  /* ---- fetching ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-trend-'));
  try {
    let settings = { artwork: { trending: true, tmdbKey: '' } };
    let online = true;
    const t = new Trending({ dir, getSettings: () => settings, allowed: () => online, fetch: fakeFetch });
    const d = await t.get({ wait: true });
    ok(d && d.sources.netflix === '2026-10-18' && d.sources.tvmaze && !d.sources.tmdb, 'without a TMDB key: Netflix and TVmaze');
    ok(/Mozilla/.test(calls.find(c => /netflix/.test(c.url)).ua), 'Netflix\'s file is asked for as a browser (it comes cut short otherwise)');
    ok(d.series.some(x => x.t === 'VisionQuest' && x.tags.includes('Disney+') && x.y === 2026) && d.series.some(x => x.t === 'Dark Matter' && x.tags.includes('Apple TV')), 'TVmaze: popular shows with new episodes on the services, with their year');
    ok(!d.series.some(x => /Vlog|Late Talk|Tiny Show/.test(x.t)), 'other sites, talk shows and little-watched shows left out');
    calls.length = 0;
    await t.get({ wait: true });
    ok(!calls.length && fs.existsSync(path.join(dir, 'trending.json')), 'kept: not fetched again for 12 hours');
    settings = { artwork: { trending: true, tmdbKey: '0123456789abcdef0123456789abcdef' } };
    t.data.at = 0;
    const d2 = await t.get({ wait: false }).then(() => t.refresh());
    ok(d2.sources.tmdb && d2.movie.some(x => x.t === 'Moana' && x.tags.includes('Disney+')), 'with a TMDB key: what\'s popular on each service (the service found by name)');
    ok(d2.movie.find(x => x.t === 'Animals').y === 2026, 'Netflix titles get their year from TMDB');
    ok(calls.some(c => /api_key=0123/.test(c.url)) && !calls.some(c => /provider_id|with_watch_providers=99/.test(c.url)), 'a v3 key goes in the address; other services aren\'t asked about');
    settings = { artwork: { trending: false } };
    ok(await t.get() === null, 'turned off: nothing');
    settings = { artwork: { trending: true } };
    online = false; t.data.at = 0; calls.length = 0;
    await t.get({ wait: true });
    ok(!calls.length, 'nothing is fetched while the VPN check is blocking');

    /* ---- in the playlist ---- */
    const store = new Store(dir, null);
    const p = store.saveProfile({ type: 'm3u', name: 'Test', m3uUrl: 'http://x.example.com/a.m3u' });
    const library = new Library(dir);
    const cat = new Catalog({ dir, store, vpn: { ensure: async () => {} }, library, fetch: fakeFetch });
    const c = { fetchedAt: 5, account: null, live: { cats: [], items: [] },
      movies: { cats: [{ id: 'm1', name: 'Movies' }, { id: 'm2', name: 'Adult 18+' }, { id: 'm3', name: 'Kids' }], items: [
        { id: 'a19', name: 'Animals (2019)', year: 2019, cat: 'm1' }, { id: 'a21', name: 'animals (2021)', year: 2021, cat: 'm1' },
        { id: 'dl', name: 'EN - Doing Life (2026)', year: 2026, cat: 'm1' }, { id: 'ia', name: 'Ice Age (2002)', year: 2002, cat: 'm1', poster: 'http://p/i.jpg' },
        { id: 'ia2', name: 'Ice Age (2002)', year: 2002, cat: 'm3' }, { id: 'mo', name: 'Moana (2016)', year: 2016, cat: 'm2' }] },
      series: { cats: [{ id: 's1', name: 'Series' }, { id: 's2', name: 'Hidden one' }], items: [
        { id: 'dm15', name: 'Dark Matter (2015)', year: 2015, cat: 's1' }, { id: 'dm24', name: 'Dark Matter (2024)', year: 2024, cat: 's1' },
        { id: 'vq', name: 'VisionQuest (2026)', year: 2026, cat: 's2' }, { id: 'dip', name: 'The Diplomat (2023)', year: 2023, cat: 's1' }] } };
    cat._index(c); cat.mem.set(p.id, c);
    fs.mkdirSync(path.join(dir, 'catalog'), { recursive: true });   // there once a playlist is loaded
    library.setCatFlag(p.id, 'series:s2', { hide: true });
    const list = { at: 100, movie: [{ t: 'Animals', y: 0, tags: ['Netflix #1'] }, { t: 'Doing Life', y: 0, tags: ['Netflix #2'] }, { t: 'Ice Age', y: 0, tags: ['Netflix #3'] }, { t: 'Moana', y: 2016, tags: ['Disney+'] }],
      series: [{ t: 'VisionQuest', y: 2026, tags: ['Disney+'] }, { t: 'Dark Matter', y: 2024, tags: ['Apple TV'] }, { t: 'The Diplomat', y: 2023, tags: ['Netflix #2', 'Netflix'] }] };
    const r = cat.trending(p.id, list);
    ok(r.movies.map(i => i.id).join() === 'dl,ia', 'movies found by name; the copy with a poster first');
    ok(!r.movies.some(i => /^a\d/.test(i.id)), 'no year to go by and two different "Animals": left out rather than guessed');
    ok(!r.movies.some(i => i.id === 'mo') && !r.series.some(i => i.id === 'vq'), 'only titles Home may show');
    ok(r.series.map(i => i.id).join() === 'dm24,dip', 'series: the copy from the right year');
    ok(r.movies[0].sub === 'Netflix #2' && r.series[1].sub === 'Netflix #2 · Netflix' && r.movies[0].kind === 'movie', 'each says where it\'s popular');
    // a TV: sections not read yet are matched later; the last matches are kept meanwhile
    const kept = JSON.parse(fs.readFileSync(cat._trendFile(p.id), 'utf8'));
    ok(kept.at === 100 && kept.movies.length === 2, 'the matches are kept for the TV');
    c._read = { live: true, movies: false, series: false };
    const r2 = cat.trending(p.id, { ...list, at: 200, movie: [] }, { read: false });
    ok(r2.movies.map(i => i.id).join() === 'dl,ia', 'a TV with the sections not read: the kept matches (nothing read for Home)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nTrending tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
