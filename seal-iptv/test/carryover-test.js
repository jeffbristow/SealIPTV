/* Seal IPTV — tests: a new playlist link (a new password, another provider) keeps the library
   (favorites, watched marks, resume points, my categories): m3u.js streamKey, catalog.js _carryOver, library.js remap. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { streamKey, streamId, idOf } = require('../src/main/m3u');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

/* a provider's playlist for a login (host + user/password in every address) */
const playlist = (host, user, pass, { renamed = false } = {}) => `#EXTM3U
#EXTINF:-1 tvg-id="cnn.us" group-title="News",CNN
http://${host}/live/${user}/${pass}/101.ts
#EXTINF:-1 group-title="News",BBC World
http://${host}/live/${user}/${pass}/102.ts
#EXTINF:-1 group-title="Movies",${renamed ? 'EN - ' : ''}Harbor Lights (2021)
http://${host}/movie/${user}/${pass}/2001.mkv
#EXTINF:-1 group-title="Movies",Twin Peaks (1992)
http://${host}/movie/${user}/${pass}/2002.mkv
#EXTINF:-1 group-title="Movies",Twin Peaks (1992)
http://${host}/movie/${user}/${pass}/2003.mkv
#EXTINF:-1 group-title="Shows",Seal Patrol S01E01
http://${host}/series/${user}/${pass}/3001.mkv
#EXTINF:-1 group-title="Shows",Seal Patrol S01E02
http://${host}/series/${user}/${pass}/3002.mkv
`;

(async () => {
  /* ---- the id: the stream's address without the login ---- */
  ok(streamKey('http://p.example.com:8080/live/jeff/pw1/101.ts') === streamKey('http://p.example.com:8080/live/jeff/pw2/101.m3u8'), 'a new password (and .ts / .m3u8) keeps a channel\'s id');
  ok(streamKey('http://p.example.com/movie/a/b/2001.mkv') === 'p.example.com/movie/2001' && streamKey('http://p.example.com/a/b/77') === 'p.example.com/77', 'Xtream-style addresses: the login segments left out');
  ok(streamKey('http://u:pw@cdn.example.com/hls/news.m3u8?token=1&q=hd') === streamKey('http://cdn.example.com/hls/news.m3u8?token=2&q=hd') && /q=hd/.test(streamKey('http://cdn.example.com/x?q=hd')), 'a login or token in the address left out; other parts kept');
  ok(streamKey('http://other.example.com/live/a/b/101.ts') !== streamKey('http://p.example.com/live/a/b/101.ts'), 'another provider\'s channel 101 isn\'t this one');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-carry-'));
  try {
    let body = playlist('p.example.com', 'jeff', 'pw1');
    const fetch = async () => ({ ok: true, status: 200, text: async () => body });
    const store = new Store(dir, null);
    const p = store.saveProfile({ type: 'm3u', name: 'My TV', m3uUrl: 'http://p.example.com/get.php?username=jeff&password=pw1&type=m3u_plus' });
    const library = new Library(dir);
    const synced = [];
    library.onChange = (name, d) => synced.push([name, d]);
    const cat = new Catalog({ dir, store, vpn: { ensure: async () => {} }, library, fetch });
    await cat.refresh(p.id);
    const id = (s, name) => cat.list(p.id, { section: s, limit: 50 }).items.find(i => i.name === name).id;
    const cnn = id('live', 'CNN'), harbor = id('movies', 'Harbor Lights (2021)'), show = id('series', 'Seal Patrol');
    const ep1 = (await cat.seriesInfo(p.id, show)).info.seasons[0].episodes[0].id;
    const list = { id: library.saveList(p.id, null, { name: 'Kids' }) };
    library.setFavorite(p.id, 'live:' + cnn, true, { name: 'CNN', cat: cat.list(p.id, { section: 'live', limit: 1 }).items[0].cat });
    library.setFavorite(p.id, 'movie:' + harbor, true, { name: 'Harbor Lights (2021)' });
    library.setProgress(p.id, 'movie:' + harbor, 600, 5400, { name: 'Harbor Lights (2021)' });
    library.setWatched(p.id, 'episode:' + ep1, true, { name: 'Seal Patrol S01E01', seriesId: show, seriesName: 'Seal Patrol', season: 1, episode: 1 });
    library.setListed(p.id, list.id, 'live:' + cnn, true, { name: 'CNN' });

    // the provider gives a new password: the playlist link and every stream address change
    body = playlist('p.example.com', 'jeff', 'pw2');
    store.saveProfile({ id: p.id, type: 'm3u', name: 'My TV', m3uUrl: 'http://p.example.com/get.php?username=jeff&password=pw2&type=m3u_plus' });
    let r = await cat.refresh(p.id);
    ok(id('live', 'CNN') === cnn && id('movies', 'Harbor Lights (2021)') === harbor && r.carried === 0, 'a new password: every title keeps its id (nothing to move)');
    ok(library.flags(p.id, ['live:' + cnn])['live:' + cnn].fav && library.getProgress(p.id, 'movie:' + harbor).pos === 600 && library.listItems(p.id, list.id).length === 1, 'favorites, resume points and my categories are all still there');

    // an older version's ids (the whole address, login and all): moved by address on the next reload
    const oldId = idOf('http://p.example.com/live/jeff/pw2/102.ts');
    const c = cat.get(p.id);
    const bbc = c.live.items.find(i => i.name === 'BBC World');
    c._byId.live.delete(bbc.id); bbc.id = oldId; c._byId.live.set(oldId, bbc);
    library.setFavorite(p.id, 'live:' + oldId, true, { name: 'BBC World' });
    synced.length = 0;
    r = await cat.refresh(p.id);
    const bbcNow = id('live', 'BBC World');
    ok(bbcNow === streamId('http://p.example.com/live/jeff/pw2/102.ts') && r.carried === 1 && library.flags(p.id, ['live:' + bbcNow])['live:' + bbcNow].fav && !library.flags(p.id, ['live:' + oldId])['live:' + oldId].fav, 'titles saved with an older version\'s ids move to the new ones');
    ok(synced.some(([n, d]) => n === `fav:${p.id}:live:${oldId}` && d === null) && synced.some(([n, d]) => n === `fav:${p.id}:live:${bbcNow}` && d), 'and the move is sent to the other devices');

    // another provider: other addresses, other numbers — found by name (and category)
    body = playlist('other.example.com', 'jb', 'x9', { renamed: true }).replace(/\/(\d+)\./g, (m, n) => `/9${n}.`);
    library.setFavorite(p.id, 'movie:' + id('movies', 'Twin Peaks (1992)'), true, { name: 'Twin Peaks (1992)' });
    r = await cat.refresh(p.id);
    const cnn2 = id('live', 'CNN'), harbor2 = id('movies', 'EN - Harbor Lights (2021)');
    ok(cnn2 !== cnn && library.flags(p.id, ['live:' + cnn2])['live:' + cnn2].fav && library.listItems(p.id, list.id)[0].key === 'live:' + cnn2, 'another provider: a favorite channel and one in my category found by name');
    ok(library.flags(p.id, ['movie:' + harbor2])['movie:' + harbor2].fav && library.getProgress(p.id, 'movie:' + harbor2).pos === 600, 'a movie found by name ("EN - " in front doesn\'t matter), its resume point with it');
    const twins = cat.list(p.id, { section: 'movies', limit: 50 }).items.filter(i => i.name === 'Twin Peaks (1992)').map(i => 'movie:' + i.id);
    ok(!twins.some(k => library.flags(p.id, [k])[k].fav), 'two of the same name: not guessed (left as it was)');
    const show2 = id('series', 'Seal Patrol');
    const ep1b = (await cat.seriesInfo(p.id, show2)).info.seasons[0].episodes[0];
    ok(library.flags(p.id, ['episode:' + ep1b.id])['episode:' + ep1b.id].watched && library.seriesStarted(p.id).has(show2), 'an episode found by its show, season and number; it knows its show\'s new id');
    ok(r.carried >= 3, `the reload says how many titles were kept (${r.carried})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nNew playlist link tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
