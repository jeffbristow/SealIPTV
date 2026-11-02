/* Seal IPTV self-test: US age ratings (ratings.js) against a pretend TMDB. Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Ratings, usRating } = require('../src/main/ratings');
const { Xtream } = require('../src/main/xtream');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

// a pretend TMDB: two films called "Heat" (1986, 1995), a series, and what was asked
const asked = [];
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const tmdb = async url => {
  const u = new URL(url);
  asked.push(u.pathname + u.search.replace(/api_key=[^&]+/, 'api_key=…'));
  if (u.searchParams.get('api_key') === 'bad') return json({}, 401);
  if (u.pathname === '/3/search/movie') {
    const q = u.searchParams.get('query');
    if (q === 'Heat') return json({ results: [{ id: 1, title: 'Heat', release_date: '1986-03-01' }, { id: 2, title: 'Heat', release_date: '1995-12-15' }] });
    if (q === 'Nothing Like It') return json({ results: [{ id: 9, title: 'Something Else', release_date: '2001-01-01' }] });
    return json({ results: [] });
  }
  if (u.pathname === '/3/movie/2/release_dates') return json({ results: [
    { iso_3166_1: 'DE', release_dates: [{ type: 3, certification: '16' }] },
    { iso_3166_1: 'US', release_dates: [{ type: 5, certification: '' }, { type: 3, certification: 'R' }] }] });
  if (u.pathname === '/3/movie/1/release_dates') return json({ results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, certification: 'PG-13' }] }] });
  if (u.pathname === '/3/search/tv') return json({ results: [{ id: 7, name: 'Harbor Patrol', first_air_date: '2016-04-01' }] });
  if (u.pathname === '/3/tv/7/content_ratings') return json({ results: [{ iso_3166_1: 'GB', rating: '15' }, { iso_3166_1: 'US', rating: 'TV-14' }] });
  return json({}, 404);
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-ratings-'));
  try {
    ok(usRating('Rated R') === 'R' && usRating('pg-13') === 'PG-13' && usRating('TVMA') === 'TV-MA' && usRating('Unrated') === 'NR', 'ratings written different ways are read as the US ones');
    ok(usRating('16+') === '' && usRating('FSK 12') === '' && usRating('') === '', 'a rating that isn\'t a US one is left out');

    const settings = { artwork: { tmdbKey: '0123456789abcdef0123456789abcdef' } };
    let allowed = true;
    const r = new Ratings({ dir, getSettings: () => settings, allowed: () => allowed, fetch: tmdb });
    const got = await r.find([{ kind: 'movie', name: 'EN | Heat (1995) [4K]', year: 0 }, { kind: 'series', name: 'Harbor Patrol', year: 2016 }, { kind: 'movie', name: 'Nothing Like It', year: 2001 }]);
    ok(got[0] === 'R', 'a movie: the US theatrical certification of the film with that year (not the 1986 one)');
    ok(got[1] === 'TV-14', 'a series: its US TV rating');
    ok(got[2] === '', 'no film by that name: no rating (rather than another film\'s)');
    ok(asked.every(a => !/provider|demo|password/i.test(a)) && asked.some(a => a.includes('query=Heat&year=1995') || a.includes('query=Heat') && a.includes('year=1995')), 'only the cleaned-up title and year are sent');

    const before = asked.length;
    const again = await r.find([{ kind: 'movie', name: 'Heat (1995)' }]);
    ok(again[0] === 'R' && asked.length === before, 'asked once: the answer is kept');
    r.flush();
    const r2 = new Ratings({ dir, getSettings: () => settings, allowed: () => false, fetch: tmdb });
    ok((await r2.find([{ kind: 'series', name: 'Harbor Patrol', year: 2016 }]))[0] === 'TV-14' && asked.length === before, 'kept after a restart, shown even while the VPN guard blocks');

    allowed = false;
    const n = asked.length;
    ok((await r.find([{ kind: 'movie', name: 'Heat', year: 1986 }]))[0] === '' && asked.length === n, 'nothing new is looked up while the VPN guard blocks');
    allowed = true;
    const noKey = new Ratings({ dir: path.join(dir, 'x'), getSettings: () => ({ artwork: {} }), fetch: tmdb });
    ok((await noKey.find([{ kind: 'movie', name: 'Heat', year: 1986 }]))[0] === '' && asked.length === n, 'without a TMDB key: no look-ups');
    ok((await r.find([{ kind: 'movie', name: 'Heat', year: 1986 }]))[0] === 'PG-13', 'the other film of that name, by its year');

    const mi = Xtream.normMovieInfo({ info: { name: 'Heat', mpaa_rating: 'Rated R' }, movie_data: {} });
    const mi2 = Xtream.normMovieInfo({ info: { name: 'Heat', age: '16+' }, movie_data: {} });
    ok(mi.cert === 'R' && mi2.cert === '', 'the provider\'s own rating in a movie\'s details is used when it\'s a US one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nRatings tests: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
