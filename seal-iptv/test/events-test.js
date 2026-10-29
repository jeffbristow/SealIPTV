/* Seal IPTV — tests for the Sports and Pay-Per-View pages (events.js, catalog.js events):
   event channels' names, time zones, sports, one event on several channels, the guide's games,
   locked categories, and the event channels' names fetched again. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const E = require('../src/main/events');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const H = 3600000;
const et = (t, o) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', ...o });

(async () => {
  /* ---- times in names ---- */
  const now = Date.parse('2026-10-29T18:30:00Z');   // 2:30 PM in New York (EDT)
  const at = (name, o = {}) => E.parseName(name, { now, ...o });
  ok(at('Pay Per View 04: UFC BJJ 13 (10.29 8:00 PM ET)').start === Date.parse('2026-10-30T00:00:00Z'), '"(10.29 8:00 PM ET)": New York time, summer');
  ok(E.parseName('PPV 1: Card (01.15 8:00 PM ET)', { now: Date.parse('2027-01-10T12:00:00Z') }).start === Date.parse('2027-01-16T01:00:00Z'), '… and in winter (EST)');
  ok(at('USA Soccer01: Italy - Serie A: Frosinone vs Lecce @ 01:30 PM EDT').start === Date.parse('2026-10-29T17:30:00Z'), '"@ 01:30 PM EDT": today');
  ok(at('USA ESPN+ 017: Fireballs vs. Devils Oct 29 3:00PM ET (2026-10-29 15:00:00)').start === Date.parse('2026-10-29T19:00:00Z'), '"(2026-10-29 15:00:00)" and "Oct 29 3:00PM ET"');
  ok(at('Flo Sports 02: flograppling: Euro NoGi (Mat 2) @ 30 Oct 03:30 AM ET').start === Date.parse('2026-10-30T07:30:00Z'), '"@ 30 Oct 03:30 AM ET"');
  ok(at('USA MLB 01: Brewers VS Rays (FOX Feed ) @ 20:00').start === Date.parse('2026-10-30T00:00:00Z'), 'no zone: Eastern');
  ok(at('USA NHL 02: UTA VS PIT @ 7:00 pm', { zone: 'America/Chicago' }).start === Date.parse('2026-10-30T00:00:00Z'), 'no zone: the provider\'s zone (Central)');
  ok(E.parseName('USA NHL 05: VAN VS SJS @ 10:00 pm', { now: Date.parse('2026-10-30T04:30:00Z') }).start === Date.parse('2026-10-30T02:00:00Z'), 'an evening game seen after midnight is last night\'s');
  ok(at('Peacock 01: Fowler & Homa @ 18 Jul 05:18 AM ET').start < now - 90 * 24 * H, 'a date without a year: the nearest one (an old name stays old)');

  /* ---- reading the name ---- */
  const p1 = at('USA ESPN+ 016: Football: Panthers vs. Packers (Panthers vs. Packers) (2026-10-29 14:00:10)');
  ok(p1.title === 'Panthers vs. Packers' && p1.league === 'Football' && p1.label === 'USA ESPN+ 016', 'league and event; the title said twice, once');
  const p2 = at('USA NHL 02: UTA VS PIT (TVAS Feed ) @ 7:00 pm');
  ok(p2.title === 'UTA VS PIT' && p2.feed === 'TVAS Feed', 'the feed kept apart');
  ok(at('Flo Sports 02: flograppling: 2026 IBJJF European NoGi (Mat 2) @ 28 Oct 03:30 AM ET').league === 'Grappling', '"flograppling" -> Grappling');
  ok(at('PPV 07: UFC 310: Main Card @ 10:00 PM ET').title === 'UFC 310: Main Card' && !at('PPV 07: UFC 310: Main Card @ 10:00 PM ET').league, '"UFC 310: Main Card" stays whole');
  ok(at('Pay Per View 05:').empty && at('USA MLB 04 :').empty, 'an event channel with nothing on');
  ok(at('EPL: Astro SuperSport 1 HD') === null && at('USA ESPN SD') === null && at('UK: BBC One') === null, 'other channels aren\'t event channels');
  ok(at('Thu_ 10/29 _ Hoops: Lakers vs Celtics @ 7:00 PM ET').title === 'Lakers vs Celtics', 'a day written in front is left out');

  /* ---- sports ---- */
  const sp = (...t) => E.sportOf(...t).id;
  ok(sp('UTA VS PIT', '', 'USA NHL') === 'hockey' && sp('Brewers VS Rays', '', 'USA MLB') === 'baseball' && sp('UFC BJJ 13') === 'fight', 'by the league / category');
  ok(sp('Columbus Blue Jackets vs. Carolina Hurricanes', '', 'ESPN Events') === 'hockey' && sp('New York Jets vs. Buffalo Bills') === 'football' && sp('Winnipeg Jets vs. Tampa Bay Lightning') === 'hockey', 'by both teams (Jets: hockey or football by the other team)');
  ok(sp('Ribadesella vs. Racing Santander (Copa del Rey)') === 'soccer' && sp('The Dirt Track at Charlotte') === 'motor', 'a league\'s name beats a word in a team\'s name');
  ok(sp('Panthers vs. Packers', 'Football', 'ESPN Events', 'USA ESPN+ 016') === 'football' && sp('Arsenal vs Spurs', 'Football', 'UK: Sport') === 'soccer', '"Football": American on a US channel, soccer elsewhere');

  /* ---- the events ---- */
  const ch = (id, name, catName, extra = {}) => ({ id, name, logo: '', cat: catName, catName, ...extra });
  const list = [
    ch('1', 'USA NHL 01: BOS VS STL (NESN Feed ) @ 2:00 PM ET', 'USA NHL'),
    ch('2', 'USA NHL 02: BOS VS STL (SN Feed ) @ 2:00 PM ET', 'USA NHL'),
    ch('3', 'USA NHL 03 HD: BOS VS STL @ 2:00 PM ET', 'USA NHL'),
    ch('4', 'Pay Per View 01: Monsers Ball (10.29 7:30 PM ET)', 'Pay Per View Events'),
    ch('5', 'USA PPV02: IWR: Monsters Ball 2026 @ 06:30 PM EDT', 'PPV-MMA/BOXING/WWE/UFC'),
    ch('6', 'Pay Per View 02:', 'Pay Per View Events'),
    ch('7', 'USA ESPN+ 30: The Pat McAfee Show @ 12:00 PM ET', 'ESPN Events'),
    ch('8', 'USA ESPN+ 31: Kent State vs. Buffalo Oct 29 6:00PM ET', 'ESPN Events'),
    ch('9', 'USA ESPN+ 32: Old Game @ 28 Oct 01:00 PM ET', 'ESPN Events'),
    ch('10', 'USA ESPN HD', 'USA Sports', { guide: [
      { title: 'Lakers vs Celtics', desc: '', start: now - H, end: now + H },
      { title: 'SportsCenter', desc: '', start: now + H, end: now + 2 * H },
      { title: 'NBA Tonight', desc: 'Highlights', start: now + 2 * H, end: now + 3 * H },
      { title: 'Live: Kings vs Suns', desc: '', start: now + 26 * H, end: now + 29 * H }
    ] }),
    ch('11', 'UK: Sky Sports Main Event', 'UK: Sport', { guide: [{ title: 'Arsenal v Spurs', desc: '', start: now - 0.5 * H, end: now + 1.5 * H }] }),
    ch('12', 'CNN', 'News', { guide: [{ title: 'Election Live', desc: '', start: now - H, end: now + H }] }),
    ch('13', 'WWE Royal Rumble', '24/7 Sports Replay')
  ];
  const r = E.build(list, { now });
  const find = t => [...r.live, ...r.later, ...r.tomorrow, ...r.soon].find(e => e.title === t);
  const bos = find('BOS VS STL');
  ok(bos && bos.live && bos.channels.length === 3 && bos.channels[0].id === '3' && bos.channels.map(c => c.feed).includes('NESN Feed'), 'one game on three channels: one event, the HD one first, feeds kept');
  ok(find('Lakers vs Celtics').live && find('Arsenal v Spurs').live && !find('SportsCenter') && !find('NBA Tonight'), 'the guide\'s games on sports channels; shows about them left out');
  ok(!find('Election Live'), 'channels that aren\'t sports aren\'t looked at');
  ok(!find('The Pat McAfee Show') && !find('Old Game'), 'a talk show listed like an event, and an event that is over: left out');
  ok(find('Kent State vs. Buffalo') && !find('Kent State vs. Buffalo').live && r.later.concat(r.tomorrow).includes(find('Kent State vs. Buffalo')), 'later today');
  ok(r.tomorrow.concat(r.soon).some(e => e.title === 'Kings vs Suns'), 'tomorrow, from the guide ("Live:" left out of the name)');
  const mb = r.later.filter(e => /mons/i.test(e.title));
  ok(mb.length === 1 && mb[0].channels.length === 2 && mb[0].start === Date.parse('2026-10-29T22:30:00Z'), 'one event the provider wrote twice, a little differently: one, at the earlier time');
  ok(!find('WWE Royal Rumble') && r.live.every(e => e.channels.every(c => c.id !== '6')), 'replay channels and empty event channels: nothing');
  ok(r.regions.join() === 'US,UK' && find('Arsenal v Spurs').region === 'UK' && bos.region === 'US', 'regions, from the categories');
  ok(r.sports[0].id === 'basketball' || r.sports.some(s => s.id === 'hockey' && s.count === 1), 'counts per sport');
  const pp = E.build(list, { now, ppv: true });
  ok(pp.live.length + pp.later.length === 1 && pp.later[0].ppv && !pp.later.concat(pp.live).some(e => e.title === 'BOS VS STL'), 'Pay-Per-View: only the pay-per-view channels');

  /* ---- in the catalogue: an Xtream provider (Central time), a locked category, names fetched again ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-ev-'));
  try {
    const t = Date.now();
    const clock = ms => et(ms, { hour: 'numeric', minute: '2-digit' });
    const central = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
    const md = ms => et(ms, { month: '2-digit' }) + '.' + et(ms, { day: '2-digit' });
    const start = Math.floor((t - 30 * 60000) / 60000) * 60000;   // started half an hour ago
    let fight = `Pay Per View 01: Big Fight Night (${md(start)} ${clock(start)} ET)`;
    const streamsCalls = [];
    const streams = () => [
      { stream_id: 101, name: fight, category_id: '1' },
      { stream_id: 102, name: 'Pay Per View 02:', category_id: '1' },
      { stream_id: 201, name: 'USA ESPN HD', category_id: '2', epg_channel_id: 'espn.us' },
      { stream_id: 202, name: `USA NHL 01: BOS VS STL (NESN Feed ) @ ${central(start)}`, category_id: '2' },
      { stream_id: 203, name: `USA NHL 02: BOS VS STL (SN Feed ) @ ${central(start)}`, category_id: '2' },
      { stream_id: 301, name: 'CNN', category_id: '3' },
      { stream_id: 401, name: `Club PPV 01: Members Bout (${md(start)} ${clock(start)} ET)`, category_id: '4' }
    ];
    const x = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const xmltv = `<?xml version="1.0"?><tv><channel id="espn.us"/><programme channel="espn.us" start="${x(t - H)}" stop="${x(t + H)}"><title>Lakers vs Celtics</title></programme></tv>`;
    const fakeFetch = async url => {
      const u = new URL(url);
      const body = (() => {
        if (u.pathname.endsWith('xmltv.php')) return xmltv;
        const a = u.searchParams.get('action');
        if (!a) return JSON.stringify({ user_info: { auth: 1, status: 'Active' }, server_info: { timezone: 'America/Chicago' } });
        if (a === 'get_live_categories') return JSON.stringify([{ category_id: '1', category_name: 'Pay Per View Events' }, { category_id: '2', category_name: 'USA Sports' }, { category_id: '3', category_name: 'News' }, { category_id: '4', category_name: 'Club PPV' }]);
        if (a === 'get_live_streams') {
          const c = u.searchParams.get('category_id');
          if (c) streamsCalls.push(c);
          return JSON.stringify(streams().filter(s => !c || s.category_id === c));
        }
        return '[]';
      })();
      return { ok: true, status: 200, text: async () => body };
    };
    const store = new Store(dir, null);
    const p = store.saveProfile({ type: 'xtream', server: 'http://p.example.com', username: 'u', password: 'pw' });
    const library = new Library(dir);
    const cat = new Catalog({ dir, store, vpn: { ensure: async () => {} }, library, fetch: fakeFetch });
    await cat.refresh(p.id);
    ok(cat.get(p.id).account.timezone === 'America/Chicago', 'the provider\'s time zone is kept');
    await cat.epgMany(p.id, ['201']);   // (the full guide fetched)
    let s = await cat.eventsPage(p.id, 'sports');
    const nhl = s.live.find(e => e.title === 'BOS VS STL');
    ok(nhl && nhl.channels.length === 2 && Math.abs(nhl.start - start) < 60000, 'a time with no zone is in the provider\'s zone; two feeds, one game');
    ok(s.live.some(e => e.title === 'Lakers vs Celtics') && s.live.some(e => e.title === 'Big Fight Night'), 'the guide\'s game and the event channel\'s, on now');
    ok(streamsCalls.includes('1') && streamsCalls.includes('2') && !streamsCalls.includes('3'), 'the event channels\' categories are fetched again (not the others)');
    library.setCatFlag(p.id, 'live:4', { lock: true });
    s = cat.events(p.id, 'ppv');
    ok(s.live.length === 1 && s.live[0].title === 'Big Fight Night', 'a locked category\'s events aren\'t shown');
    const home = cat.eventsHome(p.id);
    ok(home.ppv.length === 1 && home.sports.some(e => e.title === 'Lakers vs Celtics') && !home.sports.concat(home.ppv).some(e => /Members/.test(e.title)), 'Home: what\'s on now, nothing from a locked category');
    // later the provider renames its event channels: fetched again after 20 minutes, not before
    fight = 'Pay Per View 01:';
    const before = streamsCalls.length;
    await cat.eventsPage(p.id, 'ppv');
    ok(streamsCalls.length === before, 'not fetched again within 20 minutes');
    cat.evFresh.get(p.id).at -= 21 * 60000;
    s = await cat.eventsPage(p.id, 'ppv');
    ok(streamsCalls.length > before && !s.live.length && !s.later.length, 'after 20 minutes: the new names (the event is gone)');
    library.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nSports / Pay-Per-View tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
