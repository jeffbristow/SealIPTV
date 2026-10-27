/* Seal IPTV self-test: every poster / logo kept on disk (imagecache.js, Windows). Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { ImageCache, sniff } = require('../src/main/imagecache');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

(async () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.alloc(100, 1)]);
  ok(sniff(jpg) === 'image/jpeg' && sniff(png) === 'image/png' && sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x">')) === 'image/svg+xml' && sniff(Buffer.from('<html>404</html>')) === '', 'pictures told by their first bytes; an error page isn\'t one');

  const calls = [];
  let net = true;
  const fake = async url => {
    calls.push(url);
    if (!net) throw new Error('offline');
    const body = url.includes('missing') ? null : url.includes('html') ? Buffer.from('<html>no</html>') : url.includes('.png') ? png : jpg;
    return { ok: !!body, status: body ? 200 : 404, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-img-'));
  try {
    let allowed = true;
    const c = new ImageCache({ dir, fetch: fake, allowed: () => allowed });
    let r = await c.get('http://provider.example.org/p/1.jpg');
    ok(r.status === 200 && r.type === 'image/jpeg' && r.body.equals(jpg) && calls.length === 1, 'first time: fetched and shown');
    r = await c.get('http://provider.example.org/p/1.jpg');
    ok(r.status === 200 && r.body.equals(jpg) && calls.length === 1, 'next time: from the disk, the provider isn\'t asked');
    r = await new ImageCache({ dir, fetch: fake }).get('http://provider.example.org/p/1.jpg');
    ok(r.status === 200 && calls.length === 1, 'after a restart or an update (same folder): still from the disk');
    allowed = false;
    r = await c.get('http://provider.example.org/p/1.jpg');
    ok(r.status === 200, 'VPN guard blocking: kept pictures still show');
    r = await c.get('http://provider.example.org/p/2.jpg');
    ok(r.status === 403 && calls.length === 1, 'VPN guard blocking: nothing new is fetched');
    allowed = true;
    await Promise.all([c.get('https://image.tmdb.org/t/p/w342/x.png'), c.get('https://image.tmdb.org/t/p/w342/x.png')]);
    ok(calls.filter(u => u.endsWith('x.png')).length === 1, 'the same picture asked twice at once: fetched once');
    r = await c.get('http://provider.example.org/missing.jpg');
    ok(r.status === 404, 'not there: the provider\'s answer (the window shows initials)');
    const k = calls.length;
    r = await c.get('http://provider.example.org/missing.jpg');
    ok(r.status === 404 && calls.length === k, 'a failed address asked again: "not found" at once, the provider isn\'t asked again');
    c.flushFailed();
    r = await new ImageCache({ dir, fetch: fake }).get('http://provider.example.org/missing.jpg');
    ok(r.status === 404 && calls.length === k, 'remembered after a restart too (failed.json)');
    r = await c.get('http://provider.example.org/html.jpg');
    const n = fs.readdirSync(dir).filter(f => /^[0-9a-f]{40}$/.test(f)).length;
    ok(r.status === 415 && n === 2, 'an error page instead of a picture: not shown, not kept');
    ok((await c.get('file:///C:/Windows/win.ini')).status === 400 && (await c.get('')).status === 400, 'only web addresses');
    net = false;
    ok((await c.get('http://provider.example.org/p/3.jpg')).status === 502, 'no network: an error, no crash');
    net = true;

    // the limit: the ones not shown for longest go first
    const small = new ImageCache({ dir, fetch: fake, maxBytes: 10000 });
    const old = small.file('http://provider.example.org/p/1.jpg');
    const past = new Date(Date.now() - 5 * 86400000);
    fs.utimesSync(old, past, past);
    for (let i = 10; i < 14; i++) await small.get(`http://provider.example.org/p/${i}.jpg`);
    await small.trim();
    const left = fs.readdirSync(dir).filter(f => /^[0-9a-f]{40}$/.test(f));
    ok(!fs.existsSync(old) && left.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) <= 10000, 'over the limit: the oldest go first, down below it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nImage cache tests: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
