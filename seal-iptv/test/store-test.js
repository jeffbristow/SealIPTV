/* Seal IPTV self-test: settings and playlists. Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Store } = require('../src/main/store');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const throws = (fn, re, msg) => { try { fn(); } catch (e) { assert.ok(re.test(e.message), msg + ' — got: ' + e.message); passed++; console.log('  ✓ ' + msg); return; } assert.fail(msg + ' — did not throw'); };
const fakeSecure = { available: () => true, encrypt: s => Buffer.from('X' + s).toString('base64'), decrypt: b => Buffer.from(b, 'base64').toString().slice(1) };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-store-'));
try {
  const st = new Store(dir, fakeSecure);
  ok(st.getSettings().vpn.required === false && st.getSettings().playback.watchedPercent === 90, 'defaults');
  const p = st.saveProfile({ type: 'xtream', server: 'tv.example.com:8080', username: 'sam', password: 'secret' });
  ok(p.name === 'tv.example.com' && p.server === 'http://tv.example.com:8080' && p.hasPassword && !('password' in p), 'profile saved; the window never gets the password');
  ok(st.getSettings().activeProfile === p.id, 'the first playlist is put in use');
  const raw = fs.readFileSync(path.join(dir, 'seal-iptv.json'), 'utf8');
  ok(!raw.includes('secret') && raw.includes('enc:'), 'password encrypted on disk');
  ok(st.getProfile(p.id).password === 'secret', 'password read back');
  st.saveProfile({ id: p.id, type: 'xtream', server: 'tv.example.com:8080', username: 'sam', password: '', name: 'Home TV' });
  ok(st.getProfile(p.id).password === 'secret' && st.getProfile(p.id).name === 'Home TV', 'a blank password keeps the old one');
  throws(() => st.saveProfile({ type: 'xtream', server: 'x.tv', username: '', password: 'p' }), /username/, 'username required');
  throws(() => st.saveProfile({ type: 'xtream', server: 'x.tv', username: 'u', password: '' }), /password/, 'password required for a new login');
  throws(() => st.saveProfile({ type: 'm3u', m3uUrl: 'ftp://x/list.m3u' }), /http/, 'M3U links must be http(s)');
  throws(() => st.saveProfile({ type: 'm3u' }), /link or choose/, 'M3U needs a link or a file');
  const m = st.saveProfile({ type: 'm3u', m3uFile: 'C:\\TV\\My List.m3u8' });
  ok(m.name === 'My List' && !('hasPassword' in m && m.hasPassword), 'M3U file profile named after the file');

  const s = st.setSettings({ vpn: { required: true, provider: 'bogus', ispMatch: '  Proton  ' }, playback: { watchedPercent: 20, resume: 'always' }, catalog: { refreshHours: 9999 }, network: { userAgent: 'nope' } });
  ok(s.vpn.required && s.vpn.provider === 'proton' && s.vpn.ispMatch === 'Proton', 'unknown VPN provider ignored; text trimmed');
  ok(s.playback.watchedPercent === 50 && s.playback.resume === 'always' && s.catalog.refreshHours === 168 && s.network.userAgent === 'seal', 'numbers kept in range; unknown choices ignored');

  let av = st.setSettings({ playback: { avSync: { device: 'Headphones (WH-1000XM4)', ms: 234 } } }).playback.avSync;
  ok(av.devices['Headphones (WH-1000XM4)'] === 230 && av.def === 0, 'audio sync saved per device, in 10 ms steps');
  av = st.setSettings({ playback: { avSync: { ms: 5000 } } }).playback.avSync;
  ok(av.def === 1000 && av.devices['Headphones (WH-1000XM4)'] === 230, 'no device name: the default value; kept in range');
  av = st.setSettings({ playback: { avSync: { device: 'Headphones (WH-1000XM4)', forget: true } } }).playback.avSync;
  ok(!('Headphones (WH-1000XM4)' in av.devices), 'a device can be forgotten');
  st.deleteProfile(p.id);
  ok(st.getSettings().activeProfile === m.id, 'deleting the playlist in use switches to the next');
  const again = new Store(dir, fakeSecure);
  ok(again.listProfiles().length === 1 && again.getSettings().vpn.required, 'kept on disk');
  const plain = new Store(path.join(dir, 'plain'), null);
  const pp = plain.saveProfile({ type: 'xtream', server: 'x.tv', username: 'u', password: 'pw' });
  ok(plain.getProfile(pp.id).password === 'pw', 'works without secure storage too');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\nStore tests: ${passed} passed`);
