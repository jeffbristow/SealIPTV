/* Seal IPTV self-test: Xtream Codes client + catalogue. Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Xtream, b64 } = require('../src/main/xtream');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const rejects = async (p, re, msg) => { try { await p; } catch (e) { assert.ok(re.test(e.message), msg + ' — got: ' + e.message); passed++; console.log('  ✓ ' + msg); return; } assert.fail(msg + ' — did not throw'); };

/* a fake provider */
const API = {
  '': { user_info: { auth: 1, status: 'Active', exp_date: '1900000000', max_connections: '1', allowed_output_formats: ['ts'] }, server_info: {} },
  get_live_categories: [{ category_id: '1', category_name: 'News' }, { category_id: '2', category_name: 'Sports' }],
  get_live_streams: [{ stream_id: 11, name: 'BBC News', stream_icon: 'http://x/b.png', category_id: '1', num: 1 }, { stream_id: 12, name: 'Sky Sports', category_id: '2', num: 2 }, { stream_id: 13, name: 'Lost Channel', category_id: '99', num: 3 }],
  get_vod_categories: [{ category_id: '5', category_name: 'Action' }],
  get_vod_streams: [{ stream_id: 21, name: 'Alpha (2001)', category_id: '5', rating_5based: 4, added: '100', container_extension: 'mkv' }, { stream_id: 22, name: 'Beta', category_id: '5', rating: '6', added: '300' }],
  get_series_categories: [{ category_id: '7', category_name: 'Drama' }],
  get_series: [{ series_id: 31, name: 'Show One', cover: 'http://x/c.jpg', category_id: '7', releaseDate: '2019-01-01', last_modified: '200' }],
  get_series_info: { seasons: [{ season_number: 1, name: 'Season One' }], info: { name: 'Show One', plot: 'P' }, episodes: { 2: [{ id: '502', episode_num: 1, title: 'Two-One', container_extension: 'mkv' }], 1: [{ id: '402', episode_num: 2, title: 'B', container_extension: 'mp4' }, { id: '401', episode_num: 1, title: 'A', container_extension: 'mp4', info: { duration_secs: 1200 } }] } },
  get_short_epg: { epg_listings: [{ title: Buffer.from('Nachrichten').toString('base64'), description: Buffer.from('Heute').toString('base64'), start_timestamp: '1000', stop_timestamp: '2000' }] }
};
const calls = [];
const fakeFetch = async (url, opts) => {
  const u = new URL(url);
  calls.push({ url, ua: opts && opts.headers && opts.headers['User-Agent'] });
  const body = u.searchParams.get('password') === 'bad' ? { user_info: { auth: 0 } } : API[u.searchParams.get('action') || ''];
  return { ok: true, status: 200, text: async () => JSON.stringify(body === undefined ? [] : body) };
};

(async () => {
  /* ---- addresses ---- */
  ok(Store.normalizeServer('provider.tv:8080/player_api.php?x=1') === 'http://provider.tv:8080', 'server address: http:// added, player_api.php removed');
  ok(Store.normalizeServer('https://p.tv/sub/') === 'https://p.tv/sub', 'server address keeps https and a sub-folder');
  const fl = Xtream.fromM3uUrl('http://p.tv:80/get.php?username=a%40b&password=p%2Fw&type=m3u_plus');
  ok(fl && fl.server === 'http://p.tv' && fl.username === 'a@b' && fl.password === 'p/w', 'get.php link -> Xtream login');
  ok(Xtream.fromM3uUrl('http://p.tv/list.m3u') === null, 'a plain M3U link isn\'t a login');
  const x = new Xtream({ server: 'http://p.tv', username: 'u@x', password: 'p/w', fetch: fakeFetch, userAgent: 'UA-1' });
  ok(x.liveUrl(5, 'ts') === 'http://p.tv/live/u%40x/p%2Fw/5.ts' && x.liveUrl(5) === 'http://p.tv/live/u%40x/p%2Fw/5.m3u8', 'live addresses (user / password escaped)');
  ok(x.movieUrl(6, 'mkv').endsWith('/movie/u%40x/p%2Fw/6.mkv') && x.episodeUrl(7, '../x').endsWith('/series/u%40x/p%2Fw/7.mp4'), 'movie / episode addresses; odd file types become mp4');

  /* ---- login ---- */
  const acc = await x.login();
  ok(acc.user.status === 'Active' && acc.user.maxConnections === 1 && acc.user.expires === 1900000000000, 'login: status, connections, end date');
  ok(calls[0].ua === 'UA-1', 'the User-Agent is sent');
  await rejects(new Xtream({ server: 'http://p.tv', username: 'u', password: 'bad', fetch: fakeFetch }).login(), /Wrong username or password/, 'wrong password is reported');
  await rejects(new Xtream({ server: 'http://p.tv', username: 'u', password: 'p', fetch: async () => ({ ok: true, status: 200, text: async () => '<html>' }) }).login(), /didn't answer like an Xtream/, 'a web page instead of the API is reported');
  await rejects(new Xtream({ server: 'http://p.tv', username: 'u', password: 'p', fetch: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); } }).login(), /Can't reach p\.tv \(ENOTFOUND\)/, 'an unreachable server is reported');

  /* ---- details ---- */
  const si = await x.seriesInfo(31);
  ok(si.seasons.map(s => s.num).join() === '1,2' && si.seasons[0].name === 'Season One', 'series: seasons in order with their names');
  ok(si.seasons[0].episodes.map(e => e.id).join() === '401,402' && si.seasons[0].episodes[0].duration === 1200, 'series: episodes in order with duration');
  const epg = await x.shortEpg(11);
  ok(epg[0].title === 'Nachrichten' && epg[0].start === 1000000, 'EPG titles are base64-decoded; times in ms');
  ok(b64('plain text!') === 'plain text!', 'text that isn\'t base64 is kept');

  /* ---- catalogue ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-cat-'));
  try {
    const store = new Store(dir, null);
    const p = store.saveProfile({ type: 'xtream', server: 'p.tv', username: 'u', password: 'pw' });
    const vpnCalls = [];
    const vpn = { ensure: async () => { vpnCalls.push(1); } };
    const library = new Library(dir);
    const cat = new Catalog({ dir, store, vpn, library, fetch: fakeFetch });
    ok(cat.stale(p.id), 'a new playlist needs loading');
    const sum = await cat.refresh(p.id);
    ok(sum.counts.live === 3 && sum.counts.movies === 2 && sum.counts.series === 1, 'refresh loads all three sections');
    ok(vpnCalls.length >= 1, 'refresh waits for the VPN guard');
    ok(!cat.stale(p.id), 'just loaded: not stale');
    const cats = cat.cats(p.id, 'live');
    ok(cats.total === 3 && cats.cats.map(c => c.name).join() === 'News,Sports,Other', 'categories with an "Other" for unknown ones');
    ok(cat.list(p.id, { section: 'live', cat: '*other' }).items[0].name === 'Lost Channel', '"Other" lists the channel with an unknown category');
    ok(cat.list(p.id, { section: 'live', q: 'sky sp' }).items.map(i => i.name).join() === 'Sky Sports', 'search matches every word');
    ok(cat.list(p.id, { section: 'movies', sort: 'added' }).items[0].name === 'Beta', 'sort by recently added');
    const { matchRank, coreName } = require('../src/main/catalog');
    const rank = (names, q) => names.filter(n => q.split(' ').every(w => n.toLowerCase().includes(w))).map(n => ({ n, r: matchRank({ name: n, _core: coreName(n) }, q.split(' ')) })).sort((a, b) => a.r - b.r || a.n.localeCompare(b.n)).map(x => x.n);
    const order = rank(['Far From Home', 'The Man from Earth', 'From Dusk Till Dawn', 'EN - From', 'Afromania', 'From (2022)'], 'from');
    ok(order.slice(0, 2).join('|') === 'EN - From|From (2022)' && order[2] === 'From Dusk Till Dawn' && order[order.length - 1] === 'Afromania', 'search: the exact title, then titles starting with it, then the rest');
    ok(coreName('|US| From') === 'from' && coreName('[4K] From') === 'from' && coreName('FROM - Season 1') === 'from - season 1', 'provider tags in front are ignored; a title in capitals is kept');
    ok(rank(['Dawn of the Dead', 'From Dusk Till Dawn', 'Dusk'], 'dusk dawn')[0] === 'From Dusk Till Dawn', 'several words: titles with all of them');
    ok(cat.list(p.id, { section: 'movies', sort: 'rating' }).items[0].rating === 8, 'ratings out of 10 (4/5 -> 8)');
    library.setFavorite(p.id, 'live:12', true, { name: 'Sky Sports' });
    ok(cat.list(p.id, { section: 'live', cat: '*fav' }).items.map(i => i.id).join() === '12', 'the Favorites category');
    const page = cat.list(p.id, { section: 'live', offset: 1, limit: 1 });
    ok(page.total === 3 && page.items.length === 1 && page.items[0].fav === true, 'pages + favorite flag on items');
    ok((await cat.streamUrl(p.id, { kind: 'live', id: '11' })).url.endsWith('/11.ts'), 'live: .ts when the provider allows only ts');
    ok((await cat.streamUrl(p.id, { kind: 'movie', id: '21' })).url.endsWith('/21.mkv'), 'movie: the provider\'s file type');
    // loaded again from disk (new process)
    const cat2 = new Catalog({ dir, store, vpn, library, fetch: fakeFetch });
    ok(cat2.summary(p.id).counts.live === 3 && cat2.list(p.id, { section: 'live', q: 'bbc' }).total === 1, 'the catalogue is kept on disk');
    const s2 = await cat.seriesInfo(p.id, '31');
    library.setWatched(p.id, 'episode:401', true, {});
    const s3 = await cat.seriesInfo(p.id, '31');
    ok(s2.info.seasons.length === 2 && s3.info.seasons[0].episodes[0].watched === true, 'series details carry watched flags');

    // M3U file profile
    const f = path.join(dir, 'list.m3u');
    fs.writeFileSync(f, '#EXTM3U\n#EXTINF:-1 group-title="News",One\nhttp://a/1.m3u8\n#EXTINF:-1 group-title="Movies",Film (2020)\nhttp://a/2.mp4\n');
    const pm = store.saveProfile({ type: 'm3u', m3uFile: f });
    const before = vpnCalls.length;
    const sm = await cat.refresh(pm.id);
    ok(sm.counts.live === 1 && sm.counts.movies === 1 && vpnCalls.length === before, 'an M3U file loads without contacting anyone');
    const movieId = cat.list(pm.id, { section: 'movies' }).items[0].id;
    ok((await cat.streamUrl(pm.id, { kind: 'movie', id: movieId })).url === 'http://a/2.mp4', 'M3U: the address from the playlist');
    await rejects(cat.test({ type: 'm3u', m3uFile: path.join(dir, 'missing.m3u') }), /can't be read/, 'a missing playlist file is reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nXtream + catalogue tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
