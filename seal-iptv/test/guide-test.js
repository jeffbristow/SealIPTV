/* Seal IPTV — tests for the full TV guide (guide.js) and how Live TV / the TV Guide page use it (catalog.js). */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Guide, xmltvReader, xmltvTime } = require('../src/main/guide');
const { Catalog } = require('../src/main/catalog');
const { Library } = require('../src/main/library');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const rejects = async (p, re, msg) => { try { await p; } catch (e) { assert.ok(re.test(e.message), msg + ' — got: ' + e.message); passed++; console.log('  ✓ ' + msg); return; } assert.fail(msg + ' — did not throw'); };

const H = 3600000;
const now = Date.now();
const stamp = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`; };
const prog = (ch, from, to, title, desc = '') => `<programme start="${stamp(from)}" stop="${stamp(to)}" channel="${ch}">\n  <title lang="en">${title}</title>${desc ? `\n  <desc>${desc}</desc>` : ''}\n</programme>\n`;
const XML = '<?xml version="1.0" encoding="utf-8"?>\n<tv generator-info-name="test">\n<channel id="bbc.uk"><display-name>BBC</display-name></channel>\n' +
  prog('bbc.uk', now - 3 * H, now - 2 * H, 'Over Already') +
  prog('bbc.uk', now - 0.5 * H, now + 0.5 * H, 'News &amp; Weather', '<![CDATA[Today\'s news]]>') +
  prog('bbc.uk', now + 0.5 * H, now + 1.5 * H, 'Caf&#233; Talk &#x2615;') +
  prog('bbc.uk', now + 30 * H, now + 31 * H, 'Too Far Ahead') +
  prog('other.us', now, now + H, 'Not In The Playlist') +
  '</tv>\n';

/* a fake provider: the playlist, its own listings (get_short_epg) and its guide (xmltv.php) */
const API = {
  '': { user_info: { auth: 1, status: 'Active', exp_date: '1900000000', allowed_output_formats: ['ts'] }, server_info: {} },
  get_live_categories: [{ category_id: '1', category_name: 'News' }],
  get_live_streams: [{ stream_id: 11, name: 'BBC News', category_id: '1', num: 1, epg_channel_id: 'bbc.uk' }, { stream_id: 12, name: 'Local One', category_id: '1', num: 2, epg_channel_id: 'local.us' }],
  get_vod_categories: [], get_vod_streams: [], get_series_categories: [], get_series: [],
  get_short_epg: { epg_listings: [{ title: Buffer.from('Local Hour').toString('base64'), description: '', start_timestamp: String(Math.floor(now / 1000) - 60), stop_timestamp: String(Math.floor(now / 1000) + 3540) }] }
};
const calls = [];
let guideBody = XML;
const fakeFetch = async (url, opts) => {
  const u = new URL(url);
  calls.push(u.pathname + (u.searchParams.get('action') ? '?' + u.searchParams.get('action') + ':' + (u.searchParams.get('stream_id') || '') : ''));
  if (u.pathname.endsWith('/xmltv.php') || u.pathname.endsWith('.xml')) {
    // in pieces cut in awkward places, as a TV hands them over
    return { ok: true, status: 200, pieces: async fn => { for (let i = 0; i < guideBody.length; i += 37) fn(guideBody.slice(i, i + 37)); } };
  }
  const body = API[u.searchParams.get('action') || ''];
  return { ok: true, status: 200, text: async () => JSON.stringify(body === undefined ? [] : body) };
};

(async () => {
  /* ---- reading XMLTV ---- */
  ok(xmltvTime('20261029100000 +0000') === Date.UTC(2026, 9, 29, 10) && xmltvTime('20261029100000 -0500') === Date.UTC(2026, 9, 29, 15) && xmltvTime('202610291000 +0130') === Date.UTC(2026, 9, 29, 8, 30), 'XMLTV times with their time zones');
  const got = [];
  const r = xmltvReader(e => got.push(e));
  for (let i = 0; i < XML.length; i += 5) r.push(XML.slice(i, i + 5));
  r.end();
  ok(got.length === 5 && got[1].title === 'News & Weather' && got[1].desc === 'Today\'s news' && got[2].title === 'Café Talk ☕', 'programmes read from pieces cut anywhere; entities and CDATA decoded');
  ok(got[1].start === Math.floor((now - 0.5 * H) / 60000) * 60000, 'start time read');
  const bad = xmltvReader(() => {});
  let threw = '';
  try { bad.push('{"user_info":{}}' + ' '.repeat(5000)); } catch (e) { threw = e.message; }
  ok(/isn't an XMLTV guide/.test(threw), 'something that isn\'t a guide is reported');
  try { xmltvReader(() => {}).push('\x1f\x8b' + 'x'.repeat(5000)); threw = ''; } catch (e) { threw = e.message; }
  ok(/compressed/.test(threw), 'a .gz guide is reported as compressed');

  /* ---- where the guide comes from ---- */
  ok(Guide.address({ type: 'xtream', server: 'http://p.tv:8080', username: 'a b', password: 'p&w' }) === 'http://p.tv:8080/xmltv.php?username=a%20b&password=p%26w', 'Xtream: the provider\'s own xmltv.php, from the login');
  ok(Guide.address({ type: 'xtream', server: 'http://p.tv', username: 'u', guide: 'off' }) === '' && Guide.address({ type: 'm3u', m3uUrl: 'http://x/a.m3u' }) === '', 'off, or an M3U playlist without a guide address: none');
  ok(Guide.address({ type: 'm3u', guide: 'http://g.example.com/guide.xml' }) === 'http://g.example.com/guide.xml', 'a guide address of its own');
  ok(Store.cleanProfile({ type: 'xtream', server: 'p.tv', username: 'u', password: 'p', guide: ' off ' }).guide === 'off' && !('guide' in Store.cleanProfile({ type: 'xtream', server: 'p.tv', username: 'u', password: 'p', guide: '' })), 'the playlist keeps its guide choice');
  let msg = '';
  try { Store.cleanProfile({ type: 'xtream', server: 'p.tv', username: 'u', password: 'p', guide: 'ftp://x/g.xml' }); } catch (e) { msg = e.message; }
  ok(/TV guide address/.test(msg), 'a guide address that isn\'t http(s) is refused');

  /* ---- the guide in use ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-guide-'));
  try {
    const store = new Store(dir, null);
    const p = store.saveProfile({ type: 'xtream', server: 'p.tv', username: 'u', password: 'pw' });
    const vpnCalls = [];
    const vpn = { ensure: async () => { vpnCalls.push(1); } };
    const cat = new Catalog({ dir, store, vpn, library: new Library(dir), fetch: fakeFetch });
    await cat.refresh(p.id);
    calls.length = 0;
    const m = await cat.epgMany(p.id, ['11', '12']);
    ok(calls.filter(c => c === '/xmltv.php').length === 1, 'the TV Guide page waits for the first copy of the guide');
    ok(m['11'].length === 2 && m['11'][0].title === 'News & Weather' && m['11'][1].title === 'Café Talk ☕', 'a channel in the guide: what\'s on now and next (not what\'s over, not more than a day ahead)');
    ok(m['12'].length === 1 && m['12'][0].title === 'Local Hour' && calls.includes('/player_api.php?get_short_epg:12') && !calls.includes('/player_api.php?get_short_epg:11'), 'a channel the guide hasn\'t got: the provider\'s own listings');
    const saved = JSON.parse(fs.readFileSync(cat.guide._file(p.id), 'utf8'));
    ok(saved.ch['bbc.uk'] && !saved.ch['other.us'] && saved.programmes === 2, 'only the playlist\'s channels are kept');
    ok(vpnCalls.length >= 2, 'the guide is fetched behind the VPN check');
    calls.length = 0;
    await cat.epgMany(p.id, ['11', '12']);
    const one = await cat.epg(p.id, '11');
    ok(!calls.length && one[0].title === 'News & Weather', 'then from the saved copy (and the provider\'s answers for 15 minutes); Live TV uses it too');
    const cat2 = new Catalog({ dir, store, vpn, library: new Library(dir), fetch: fakeFetch });
    calls.length = 0;
    ok((await cat2.epg(p.id, '11'))[0].title === 'News & Weather' && !calls.includes('/xmltv.php'), 'the saved copy is read after a restart');
    // changing where the guide comes from drops the copy
    store.saveProfile({ id: p.id, type: 'xtream', server: 'p.tv', username: 'u', password: '', guide: 'off' });
    ok(cat2.guideAddress(p.id) === '', 'a playlist with the guide off has no guide address');
    cat2.guide.forget(p.id);
    calls.length = 0;
    const off = await cat2.epgMany(p.id, ['11']);
    ok(!calls.includes('/xmltv.php') && off['11'][0].title === 'Local Hour', 'guide off: only the provider\'s own listings');
    // a guide that fails is tried again later, not on every row
    store.saveProfile({ id: p.id, type: 'xtream', server: 'p.tv', username: 'u', password: '', guide: 'http://g.example.com/guide.xml' });
    guideBody = 'not a guide' + ' '.repeat(5000);
    calls.length = 0;
    await cat2.epgMany(p.id, ['11']);
    await cat2.epgMany(p.id, ['12']);
    ok(calls.filter(c => c === '/guide.xml').length === 1, 'a guide that fails isn\'t fetched again straight away');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nGuide tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
