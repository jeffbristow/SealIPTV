/* The Fire TV crypto stand-in must give the same results as Node's crypto (Windows), or a
   Fire TV and a PC couldn't share a sync vault or a parental PIN. Run: node test-shims.js */
const assert = require('assert');
const nodeCrypto = require('crypto');
const shim = require('./src/shims/crypto');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m); };
(async () => {
  ok(shim.createHash('sha1').update('http://a/1.m3u8').digest('hex') === nodeCrypto.createHash('sha1').update('http://a/1.m3u8').digest('hex'), 'sha1 (M3U ids)');
  ok(shim.createHash('sha256').update('x').digest('hex') === nodeCrypto.createHash('sha256').update('x').digest('hex'), 'sha256');
  const k = nodeCrypto.randomBytes(32);
  ok(shim.createHmac('sha256', k).update('fav:p:live:1').digest('hex') === nodeCrypto.createHmac('sha256', k).update('fav:p:live:1').digest('hex'), 'hmac-sha256 (sync item ids)');
  ok(shim.scryptSync('2468', 'abcdef0123456789abcdef0123456789', 32).toString('hex') === nodeCrypto.scryptSync('2468', 'abcdef0123456789abcdef0123456789', 32).toString('hex'), 'scrypt (parental PIN hash)');
  const ikm = nodeCrypto.randomBytes(32);
  ok(Buffer.from(shim.hkdfSync('sha256', ikm, Buffer.alloc(0), 'sealiptv-auth', 32)).equals(Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, Buffer.alloc(0), 'sealiptv-auth', 32))), 'hkdf (sync keys)');
  const a = await new Promise((res, rej) => shim.pbkdf2(Buffer.from('pass phrase'), Buffer.from('sealiptv:jeff'), 100000, 32, 'sha256', (e, v) => (e ? rej(e) : res(v))));
  ok(a.equals(nodeCrypto.pbkdf2Sync('pass phrase', 'sealiptv:jeff', 100000, 32, 'sha256')), 'pbkdf2 (vault passphrase)');
  const iv = nodeCrypto.randomBytes(12);
  const c1 = shim.createCipheriv('aes-256-gcm', k, iv); c1.setAAD(Buffer.from('fav:abc'));
  const ct = Buffer.concat([c1.update(Buffer.from('{"k":"fav:x"}')), c1.final()]), tag = c1.getAuthTag();
  const d1 = nodeCrypto.createDecipheriv('aes-256-gcm', k, iv); d1.setAAD(Buffer.from('fav:abc')); d1.setAuthTag(tag);
  ok(Buffer.concat([d1.update(ct), d1.final()]).toString() === '{"k":"fav:x"}', 'aes-256-gcm: Fire TV encrypts, Windows decrypts');
  const c2 = nodeCrypto.createCipheriv('aes-256-gcm', k, iv); c2.setAAD(Buffer.from('aad'));
  const ct2 = Buffer.concat([c2.update(Buffer.from('hello')), c2.final()]);
  const d2 = shim.createDecipheriv('aes-256-gcm', k, iv); d2.setAAD(Buffer.from('aad')); d2.setAuthTag(c2.getAuthTag());
  ok(Buffer.concat([d2.update(ct2), d2.final()]).toString() === 'hello', 'aes-256-gcm: Windows encrypts, Fire TV decrypts');
  const d3 = shim.createDecipheriv('aes-256-gcm', k, iv); d3.setAAD(Buffer.from('other')); d3.setAuthTag(c2.getAuthTag()); d3.update(ct2);
  let refused = false; try { d3.final(); } catch { refused = true; }
  ok(refused, 'a swapped item (wrong associated data) is refused');
  ok(shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab')) && !shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ac')), 'timingSafeEqual');
  ok(/^[0-9a-f-]{36}$/.test(shim.randomUUID()) && shim.randomBytes(16).length === 16, 'randomUUID / randomBytes');
  console.log(`\nFire TV crypto = Windows crypto: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
