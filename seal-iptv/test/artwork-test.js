/* Seal IPTV self-test: missing posters looked up by title (TVmaze / TMDB, faked). Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Artwork, cleanTitle } = require('../src/main/artwork');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

(async () => {
  const t = (n, y) => JSON.stringify(cleanTitle(n, y));
  ok(t('EN | Breaking Bad (2008)') === JSON.stringify({ title: 'Breaking Bad', year: 2008 }), 'title: tag in front and (year) removed');
  ok(t('|US| The Office [MULTI-SUB] 4K') === JSON.stringify({ title: 'The Office', year: 0 }), 'title: [tags] and quality at the end removed');
  ok(t('FHD: Dark - 2017') === JSON.stringify({ title: 'Dark', year: 2017 }), 'title: "- 2017" is the year');
  ok(t('Severance S02', 2022) === JSON.stringify({ title: 'Severance', year: 2022 }), 'title: season tag removed, provider year kept');
  ok(cleanTitle('2001: A Space Odyssey').title === '2001: A Space Odyssey', 'title: a year-like number that is the title stays');
  ok(cleanTitle('FROM - Season 1').title === 'FROM', 'title: "FROM" is a title, not a tag');

  const calls = [];
  let tmdbStatus = 200;
  const fake = async url => {
    calls.push(url);
    const u = new URL(url);
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (u.host === 'api.tvmaze.com') {
      const q = u.searchParams.get('q');
      if (q === 'Breaking Bad') return json([{ show: { name: 'Breaking Bad', premiered: '2008-01-20', image: { medium: 'http://static.tvmaze.com/bb.jpg' } } }]);
      if (q === 'The Office') return json([{ show: { name: 'The Office', premiered: '2001-07-09', image: { medium: 'https://tvm/uk.jpg' } } }, { show: { name: 'The Office', premiered: '2005-03-24', image: { medium: 'https://tvm/us.jpg' } } }]);
      if (q === 'Dark') return json([{ show: { name: 'Darker Than Black', premiered: '2007-04-05', image: { medium: 'https://tvm/dtb.jpg' } } }]);
      return json([]);
    }
    if (u.host === 'api.themoviedb.org') {
      if (tmdbStatus !== 200) return { ok: false, status: tmdbStatus, json: async () => ({}) };
      const q = u.searchParams.get('query');
      if (u.pathname.endsWith('/search/collection')) return json({ results: q === 'Star Wars Collection' ? [{ name: 'Star Wars: The Clone Wars Collection', poster_path: '/cw.jpg' }, { name: 'Star Wars Collection', poster_path: '/sw.jpg' }] : [] });
      if (q === 'Inception') return json({ results: [{ title: 'Inception', release_date: '2010-07-15', poster_path: '/inc.jpg' }] });
      if (q === 'Dark') return json({ results: [{ name: 'Dark', first_air_date: '2017-12-01', poster_path: '/dark.jpg' }] });
      if (q === 'The Matrix') return json({ results: [{ title: 'The Matrix', release_date: '1999-03-30', poster_path: '/m.jpg' }] });
      return json({ results: [] });
    }
    throw new Error('unexpected ' + url);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-art-'));
  try {
    const settings = { artwork: { lookup: true, tmdbKey: '' } };
    let allowed = true;
    const art = new Artwork({ dir, getSettings: () => settings, allowed: () => allowed, fetch: fake });

    let r = await art.find([{ kind: 'series', name: 'EN | Breaking Bad', year: 2008 }, { kind: 'series', name: 'The Office', year: 2005 }, { kind: 'movie', name: 'Inception' }]);
    ok(r[0] === 'https://static.tvmaze.com/bb.jpg', 'series from TVmaze (always https)');
    ok(r[1] === 'https://tvm/us.jpg', 'two shows with the same name: the year picks the right one');
    ok(r[2] === null && !calls.some(c => c.includes('themoviedb')), 'movies without a TMDB key: not looked up');

    r = await art.find([{ kind: 'series', name: 'Dark' }]);
    ok(r[0] === null, 'TVmaze only had a different show: no poster rather than a wrong one');

    const before = calls.length;
    r = await art.find([{ kind: 'series', name: 'Breaking Bad (2008)' }, { kind: 'series', name: 'Dark' }]);
    ok(r[0] === 'https://static.tvmaze.com/bb.jpg' && calls.length === before, 'answers are remembered (found and not found)');

    settings.artwork.tmdbKey = '0123456789abcdef0123456789abcdef';
    r = await art.find([{ kind: 'movie', name: 'FHD: Inception (2010)' }, { kind: 'series', name: 'Dark' }]);
    ok(r[0] === 'https://image.tmdb.org/t/p/w342/inc.jpg', 'movie from TMDB with a key');
    ok(r[1] === 'https://image.tmdb.org/t/p/w342/dark.jpg', 'a series TVmaze missed: asked again at TMDB once a key is set');
    ok(calls.filter(c => c.includes('themoviedb')).every(c => c.includes('api_key=0123')), 'v3 key goes in the address');

    r = await art.find([{ kind: 'collection', name: 'Star Wars Collection' }, { kind: 'collection', name: 'Nothing Collection' }]);
    ok(r[0] === 'https://image.tmdb.org/t/p/w342/sw.jpg' && r[1] === null, 'a collection poster (Collections): the one with the same name');

    allowed = false;
    r = await art.find([{ kind: 'movie', name: 'Something New' }]);
    ok(r[0] === null && !calls.some(c => c.includes('Something')), 'VPN guard blocking: nothing is looked up');
    allowed = true;
    settings.artwork.lookup = false;
    r = await art.find([{ kind: 'movie', name: 'Something New' }]);
    ok(r[0] === null && !calls.some(c => c.includes('Something')), 'switched off: nothing is looked up');
    settings.artwork.lookup = true;

    await Promise.all([art.find([{ kind: 'series', name: 'Severance' }]), art.find([{ kind: 'series', name: 'Severance' }])]);
    ok(calls.filter(c => c.includes('q=Severance')).length === 1, 'the same title asked twice at once: one request');

    art.flush();
    const again = new Artwork({ dir, getSettings: () => settings, fetch: fake });
    const n = calls.length;
    r = await again.find([{ kind: 'movie', name: 'Inception', year: 2010 }]);
    ok(r[0] === 'https://image.tmdb.org/t/p/w342/inc.jpg' && calls.length === n, 'remembered after a restart (artwork.json)');

    tmdbStatus = 401;
    await assert.rejects(() => art.testTmdb('bad-key-eyJ'), /wasn't accepted/);
    ok(true, 'a wrong TMDB key is reported');
    tmdbStatus = 200;
    ok(await art.testTmdb('eyJhbGciOiJIUzI1NiJ9.token') === true, 'a read access token works (sent as a header)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nArtwork tests: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
