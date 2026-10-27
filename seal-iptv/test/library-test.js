/* Seal IPTV self-test: favorites, watched marks, resume points. Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Library } = require('../src/main/library');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-lib-'));
try {
  const lib = new Library(dir);
  const P = 'p1';
  lib.setFavorite(P, 'live:1', true, { name: 'One', image: 'http://x/1.png', junk: 'x'.repeat(10) });
  lib.setFavorite(P, 'movie:9', true, { name: 'Film' });
  ok(lib.favorites(P, 'live').length === 1 && lib.favorites(P, 'live')[0].id === '1' && !('junk' in lib.favorites(P, 'live')[0]), 'favorites per kind; unknown fields dropped');
  lib.setFavorite(P, 'live:1', false);
  ok(lib.favorites(P, 'live').length === 0, 'removing a favorite');

  lib.setProgress(P, 'movie:9', 12, 6000, { name: 'Film' });
  ok(lib.getProgress(P, 'movie:9') === null, 'under 30 seconds isn\'t worth resuming');
  lib.setProgress(P, 'movie:9', 1200, 6000, { name: 'Film' });
  ok(lib.getProgress(P, 'movie:9').pos === 1200, 'resume point saved');
  lib.setProgress(P, 'episode:5', 300, 2400, { name: 'Ep', seriesId: 's1', seriesName: 'Show', season: 1, episode: 5 });
  const cw = lib.continueWatching(P);
  ok(cw.length === 2 && cw[0].key === 'episode:5' && cw[0].seriesName === 'Show' && cw[0].season === 1, 'continue watching: newest first, with series details');
  lib.setProgress(P, 'movie:9', 5990, 6000, {});
  ok(lib.getProgress(P, 'movie:9') === null, 'right at the end: no resume point');

  lib.setProgress(P, 'episode:5', 300, 2400, {});
  lib.setWatched(P, 'episode:5', true, { name: 'Ep' });
  ok(lib.flags(P, ['episode:5'])['episode:5'].watched && lib.getProgress(P, 'episode:5') === null, 'watched clears the resume point');
  ok(lib.continueWatching(P).every(x => x.key !== 'episode:5'), 'watched items leave Continue watching');
  lib.setWatchedMany(P, [{ key: 'episode:6' }, { key: 'episode:7' }], true);
  ok(lib.flags(P, ['episode:6', 'episode:7'])['episode:7'].watched, 'a whole season at once');
  lib.setWatched(P, 'episode:6', false);
  ok(!lib.flags(P, ['episode:6'])['episode:6'].watched, 'mark as not watched');

  lib.flush();
  const again = new Library(dir);
  ok(again.flags(P, ['episode:7'])['episode:7'].watched && again.favorites(P, 'movie').length === 1, 'kept on disk');
  ok(again.flags('p2', ['episode:7'])['episode:7'].watched === false, 'each playlist has its own library');
  again.clearHistory(P);
  ok(!again.flags(P, ['episode:7'])['episode:7'].watched && again.favorites(P, 'movie').length === 1, 'clearing history keeps favorites');
  again.remove(P);
  ok(!fs.existsSync(path.join(dir, 'library-p1.json')), 'deleting the playlist deletes its library');

  for (let i = 0; i < 520; i++) lib.setProgress('p3', 'movie:' + i, 100, 1000, {});
  ok(Object.keys(lib._get('p3').progress).length === 500, 'at most 500 resume points');

  // favorites: newest first, A-Z, the user's order (and what gets synced)
  const S = 'p4', sent = [];
  lib.onChange = (name, d) => sent.push([name, d]);
  for (const [id, name] of [['1', 'Zulu'], ['2', 'alpha'], ['3', 'Movie 10'], ['4', 'Movie 9']]) lib.setFavorite(S, 'movie:' + id, true, { name });
  const ids = sort => lib.favorites(S, 'movie', sort).map(f => f.id).join(',');
  ok(ids() === '4,3,2,1' && ids('added') === '4,3,2,1', 'favorites: newest first by default');
  ok(ids('name') === '2,4,3,1', 'favorites A-Z: ignores case, Movie 9 before Movie 10');
  ok(ids('custom') === '4,3,2,1', 'my order, nothing arranged yet: as newest first');
  sent.length = 0;
  lib.arrangeFavorites(S, 'movie', ['movie:2', 'movie:4', 'movie:3', 'movie:1']);
  ok(ids('custom') === '2,4,3,1' && sent.length === 4 && sent.every(([n, d]) => n.startsWith('fav:p4:movie:') && Number.isFinite(d.order)), 'arranging: saved, and each moved favorite is synced');
  sent.length = 0;
  lib.arrangeFavorites(S, 'movie', ['movie:4', 'movie:2', 'movie:3', 'movie:1']);
  ok(ids('custom') === '4,2,3,1' && sent.length === 2, 'moving one poster sends only the two that changed places');
  lib.setFavorite(S, 'movie:5', true, { name: 'New' });
  ok(ids('custom') === '4,2,3,1,5', 'a new favorite goes at the end of my order');
  lib.arrangeFavorites(S, 'movie', ['movie:1', 'movie:4']);
  ok(ids('custom') === '1,2,3,4,5', 'favorites not shown (hidden categories) keep their places');
  lib.applyRecord('fav', S, 'movie:6', { name: 'From the other PC', at: 1 });
  ok(ids('custom') === '1,2,3,4,5,6', 'a synced favorite without a place goes at the end');
  ok(lib.favorites(S, 'live', 'custom').length === 0 && ids('added').startsWith('5,'), 'other kinds and sorts unaffected');

  // my own categories (Kids …)
  const K = 'p5';
  sent.length = 0;
  assert.throws(() => lib.saveList(K, null, { name: '   ' }), /name/);
  const kids = lib.saveList(K, null, { name: '  Kids  ', icon: '🧸' });
  const xmas = lib.saveList(K, null, { name: 'Christmas' });
  ok(lib.lists(K).map(l => l.name).join() === 'Kids,Christmas' && lib.lists(K)[0].icon === '🧸', 'categories of my own, in the order made');
  lib.setListed(K, kids, 'series:4', true, { name: 'Bluey', image: 'http://x/b.jpg' });
  lib.setListed(K, kids, 'movie:9', true, { name: 'Aladdin' });
  lib.setListed(K, kids, 'live:1', true, { name: 'Cartoon Channel' });
  lib.setListed(K, xmas, 'movie:9', true, { name: 'Aladdin' });
  ok(lib.listItems(K, kids).map(i => i.key).join() === 'movie:9,series:4,live:1' && lib.listItems(K, kids)[1].image === 'http://x/b.jpg', 'channels, movies and series in it, A–Z');
  ok(lib.listsOf(K, 'movie:9').sort().join() === [kids, xmas].sort().join() && lib.lists(K)[0].count === 3, 'one title in two categories');
  ok(sent.some(([n, d]) => n === `list:${K}:${kids}` && d.name === 'Kids') && sent.some(([n]) => n === `listed:${K}:${kids}/series:4`), 'synced: the category and what\'s in it');
  lib.saveList(K, kids, { name: 'Kids & family', icon: '🎈' });
  ok(lib.lists(K)[0].name === 'Kids & family' && lib.lists(K)[0].id === kids, 'renamed, same category');
  lib.setListed(K, kids, 'movie:9', false);
  ok(lib.listItems(K, kids).length === 2 && lib.listItems(K, xmas).length === 1, 'taken out of one, still in the other');
  sent.length = 0;
  ok(lib.setListedTitle(K, kids, 'live:1', '  Toons  ') === 'Toons' && lib.listItems(K, kids).map(i => i.title || i.name).join() === 'Bluey,Toons', 'a channel renamed in one category only: shown and sorted by that name');
  ok(lib.listItems(K, kids).find(i => i.key === 'live:1').name === 'Cartoon Channel' && sent.some(([n, d]) => n === `listed:${K}:${kids}/live:1` && d.title === 'Toons'), '… its own name kept, and the new one synced');
  lib.setListed(K, kids, 'live:1', true, { name: 'Cartoon Channel' });
  ok(lib.listItems(K, kids).find(i => i.key === 'live:1').title === 'Toons', 'added again: keeps the name it was given');
  lib.setListedTitle(K, kids, 'live:1', '');
  ok(!lib.listItems(K, kids).find(i => i.key === 'live:1').title, 'emptied: its own name again');
  assert.throws(() => lib.setListedTitle(K, xmas, 'live:1', 'X'), /isn't in/);
  sent.length = 0;
  lib.removeList(K, kids);
  ok(lib.lists(K).length === 1 && lib.listsOf(K, 'series:4').length === 0, 'a deleted category takes its titles with it');
  ok(sent.filter(([n, d]) => d === null && n.startsWith(`listed:${K}:${kids}/`)).length === 2 && sent.some(([n, d]) => n === `list:${K}:${kids}` && d === null), '… and every device is told');
  assert.throws(() => lib.setListed(K, kids, 'movie:1', true, {}), /gone/);
  lib.applyRecord('list', K, 'other1', { name: 'From the TV', at: Date.now() });
  lib.applyRecord('listed', K, 'other1/movie:7', { name: 'Up', at: 1 });
  ok(lib.lists(K).some(l => l.name === 'From the TV' && l.count === 1), 'a category made on another device');
  lib.applyRecord('list', K, 'other1', null);
  ok(!lib.lists(K).some(l => l.id === 'other1') && !Object.keys(lib._get(K).listed).some(k => k.startsWith('other1/')), 'deleted on another device: gone here, with its titles');
  lib.onChange = null;
  lib.flush();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\nLibrary tests: ${passed} passed`);
