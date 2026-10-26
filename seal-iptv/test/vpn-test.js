/* Seal IPTV self-test: the VPN guard. Run with `npm test`. */
const assert = require('assert');
const { VpnGuard } = require('../src/main/vpn');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

const WIFI = { 'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false }], 'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
const PROTON = { ...WIFI, ProtonVPN: [{ address: '10.2.0.2', family: 'IPv4', internal: false }] };
const WG = { ...WIFI, 'Mullvad WireGuard': [{ address: '10.64.0.2', family: 'IPv4', internal: false }] };

/** answers: { proton: object | Error, ipinfo: object | Error, ipify: object | Error } */
const fetchWith = answers => async url => {
  const a = url.includes('protonvpn') ? answers.proton : url.includes('ipinfo') ? answers.ipinfo : answers.ipify;
  if (!a || a instanceof Error) throw a || new Error('offline');
  return { ok: true, status: 200, text: async () => JSON.stringify(a) };
};
const guard = (vpn, ifs, answers) => new VpnGuard({ getSettings: () => ({ vpn: { required: true, provider: 'proton', adapter: '', homeIp: '', ispMatch: '', ...vpn } }), interfaces: () => ifs, fetch: fetchWith(answers) });
const ON_PROTON = { Code: 86081, Error: 'Location cannot be calculated when connected to a VPN server' };
const IPINFO_PROTON = { ip: '134.82.68.116', city: 'Miami', country: 'US', org: 'AS208172 Proton AG' };
const IPINFO_HOME = { ip: '73.1.2.3', city: 'Chicago', country: 'US', org: 'AS7922 Comcast Cable' };

(async () => {
  let s = await guard({ required: false }, WIFI, {}).check();
  ok(s.ok && s.state === 'off', 'not required: always allowed');

  s = await guard({}, PROTON, { proton: ON_PROTON, ipinfo: IPINFO_PROTON }).check();
  ok(s.ok && s.state === 'ok' && s.adapter === 'ProtonVPN' && s.place === 'Miami, US' && s.isp === 'Proton AG', 'ProtonVPN on: confirmed by Proton, place from ipinfo');

  s = await guard({}, WIFI, { proton: ON_PROTON, ipinfo: IPINFO_PROTON }).check();
  ok(!s.ok && s.state === 'down' && /ProtonVPN isn't connected/.test(s.detail), 'no ProtonVPN adapter: off');

  s = await guard({}, PROTON, { proton: { IP: '73.1.2.3', ISP: 'Comcast' }, ipinfo: IPINFO_HOME }).check();
  ok(!s.ok && s.state === 'leak' && /73\.1\.2\.3/.test(s.detail), 'adapter up but Proton sees the real IP: blocked');

  s = await guard({}, PROTON, { proton: new Error('blocked'), ipinfo: IPINFO_PROTON }).check();
  ok(s.ok, 'Proton\'s API unreachable: ipinfo naming Proton is enough');

  s = await guard({}, PROTON, { proton: new Error('x'), ipinfo: IPINFO_HOME }).check();
  ok(!s.ok && s.state === 'leak', 'Proton\'s API unreachable and ipinfo shows another network: blocked');

  s = await guard({}, PROTON, { proton: new Error('x'), ipinfo: new Error('x'), ipify: new Error('x') }).check();
  ok(!s.ok && s.state === 'unknown', 'nothing can be checked: blocked (fails closed)');

  s = await guard({ provider: 'other' }, WG, { ipinfo: IPINFO_HOME }).check();
  ok(s.ok && s.adapter === 'Mullvad WireGuard', 'another VPN: found by its adapter name');

  s = await guard({ provider: 'other' }, WIFI, {}).check();
  ok(!s.ok && s.state === 'down', 'another VPN, no VPN adapter: off');

  s = await guard({ provider: 'other', adapter: 'Wi-Fi' }, WIFI, {}).check();
  ok(s.ok && s.adapter === 'Wi-Fi', 'a chosen adapter is used as given');

  s = await guard({ provider: 'other', homeIp: '73.1.2.3' }, WG, { ipinfo: IPINFO_HOME }).check();
  ok(!s.ok && s.state === 'leak' && /home IP/.test(s.title), 'home IP showing: blocked');

  s = await guard({ provider: 'other', ispMatch: 'mullvad' }, WG, { ipinfo: { ip: '1.1.1.1', org: 'AS39351 31173 Services AB (Mullvad)' } }).check();
  ok(s.ok, 'network name matches (any case)');

  s = await guard({ provider: 'other', ispMatch: 'Mullvad' }, WG, { ipinfo: IPINFO_HOME }).check();
  ok(!s.ok && s.state === 'leak', 'network name doesn\'t match: blocked');

  s = await guard({ provider: 'other', homeIp: '73.1.2.3' }, WG, { ipinfo: new Error('x'), ipify: new Error('x') }).check();
  ok(!s.ok && s.state === 'unknown', 'home IP set but no lookup works: blocked');

  s = await guard({ provider: 'other', homeIp: '73.1.2.3' }, WG, { ipinfo: new Error('x'), ipify: { ip: '9.9.9.9' } }).check();
  ok(s.ok && s.ip === '9.9.9.9', 'ipify is used when ipinfo fails');

  const g = guard({}, WIFI, {});
  ok(!g.allowed(), 'before any check: the window may not contact the provider');
  try { await g.ensure(); assert.fail('ensure should throw'); } catch (e) { ok(e.code === 'VPN' && e.vpn.state === 'down', 'ensure() refuses with code VPN'); }
  ok(!g.allowed(), 'after a failed check: still blocked');

  const ifs = { cur: PROTON };
  let events = 0;
  const live = new VpnGuard({ getSettings: () => ({ vpn: { required: true, provider: 'proton', adapter: '', homeIp: '', ispMatch: '' } }), interfaces: () => ifs.cur, fetch: fetchWith({ proton: ON_PROTON, ipinfo: IPINFO_PROTON }) });
  live.on('status', () => events++);
  await live.check();
  ok(live.allowed() && events === 1, 'check passed: allowed, one status event');
  ok((await live.check()) === live.last, 'checks within 10 seconds reuse the answer');
  live.start({ quickMs: 30, fullMs: 100000 });
  ifs.cur = WIFI;
  await new Promise(r => setTimeout(r, 150));
  ok(!live.allowed() && live.last.state === 'down' && events === 2, 'VPN dropped: noticed within seconds, status event sent');
  ifs.cur = PROTON;
  await new Promise(r => setTimeout(r, 150));
  ok(live.allowed() && events === 3, 'VPN back: allowed again');
  live.stop();

  console.log(`\nVPN tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
