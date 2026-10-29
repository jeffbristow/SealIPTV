/* Seal IPTV — tests for "Connect a TV" (tvfind.js): finding a TV that shows "Set up from your phone"
   on the network, and sending it the vault sealed with its code (setuplink.js). A pretend TV on 127.0.0.x. */
const http = require('http');
const assert = require('assert');
const { lanAddresses, find, send } = require('../src/main/tvfind');
const link = require('../src/main/setuplink');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const rejects = async (p, re, msg) => { try { await p; } catch (e) { assert.ok(re.test(e.message), msg + ' — got: ' + e.message); passed++; console.log('  ✓ ' + msg); return; } assert.fail(msg + ' — did not throw'); };

(async () => {
  /* ---- this device's home-network addresses ---- */
  const addr = lanAddresses({
    'ProtonVPN': [{ address: '10.2.0.2', family: 'IPv4', internal: false }],
    'tun0': [{ address: '10.8.0.5', family: 'IPv4', internal: false }],
    'VirtualBox Host-Only Ethernet Adapter': [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
    'Loopback': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'wlan0': [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '10.0.0.199', family: 'IPv4', internal: false }],
    'docker': [{ address: '8.8.8.8', family: 'IPv4', internal: false }]
  });
  ok(addr.join() === '10.0.0.199', 'the Wi-Fi address; VPNs, virtual adapters, IPv6 and public addresses left out');

  /* ---- a pretend TV (PhoneServer.java): /hello and /send ---- */
  const code = link.newCode(), key = link.keyFrom(code);
  let got = null;
  const tv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/hello') return res.end(JSON.stringify({ app: 'seal-iptv-setup', v: 1, name: 'Living room TV' }));
    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try { got = link.open(key, body); res.end(JSON.stringify({ ok: true, text: 'Living room TV is connected.' })); }
        catch { res.end(JSON.stringify({ ok: false, error: 'That isn\'t the code on the TV.' })); }
      });
      return;
    }
    res.statusCode = 404; res.end('Not here');
  });
  const other = http.createServer((req, res) => res.end('{"app":"something else"}'));
  await new Promise(r => tv.listen(8765, '127.0.0.7', r));
  await new Promise(r => other.listen(8765, '127.0.0.9', r));
  try {
    const t0 = Date.now();
    const list = await find({ addresses: ['127.0.0.2'], timeout: 400 });
    ok(list.length === 1 && list[0].address === '127.0.0.7:8765' && list[0].name === 'Living room TV', `the TV with the setup window open is found (${Date.now() - t0} ms); other servers aren't taken for one`);
    const data = { kind: 'join', server: 'https://example.com/iptv-sync/api.php', username: 'sam', authKey: 'a'.repeat(64), vaultKey: Buffer.alloc(32, 7).toString('base64') };
    const r = await send({ address: list[0].address, code: link.pretty(code).toLowerCase(), data });
    ok(r.ok && got && got.username === 'sam' && got.vaultKey === data.vaultKey, 'sent with the code (typed in any case): the TV opens it');
    const bad = await send({ address: '127.0.0.7:8765', code: link.newCode(), data });
    ok(!bad.ok && /code/.test(bad.error), 'another code: the TV says so');
    await rejects(send({ address: '127.0.0.7:8765', code: 'ABC', data }), /10 letters/, 'a code that\'s too short is caught before sending');
    await rejects(send({ address: 'http://127.0.0.8:8765/', code, data }), /can't be reached/, 'nothing there: says so');
    await rejects(send({ address: 'not an address!', code, data }), /isn't a TV's address/, 'an address that isn\'t one is caught');
  } finally {
    tv.close(); other.close();
  }
  console.log(`\nConnect a TV tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
