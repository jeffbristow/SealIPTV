/* =====================================================================
 * crypto for the Fire TV app — the parts of Node's crypto the shared
 * modules use, with the same results (tested against Node in
 * web/test-shims.js):
 *   randomBytes, randomUUID, createHash (sha1 / sha256), createHmac,
 *   scryptSync (parental PIN), timingSafeEqual, pbkdf2 (async, Web
 *   Crypto — 600 000 rounds is fast there), hkdfSync,
 *   createCipheriv / createDecipheriv for aes-256-gcm (sync vault).
 * Pure JS from @noble/hashes and @noble/ciphers (audited, no deps).
 * ===================================================================== */
const { Buffer } = require('buffer');
const { sha1 } = require('@noble/hashes/sha1');
const { sha256 } = require('@noble/hashes/sha256');
const { hmac } = require('@noble/hashes/hmac');
const { hkdf } = require('@noble/hashes/hkdf');
const { scrypt } = require('@noble/hashes/scrypt');
const { pbkdf2: pbkdf2Js } = require('@noble/hashes/pbkdf2');
const { gcm } = require('@noble/ciphers/aes');

const bytes = v => (v instanceof Uint8Array ? v : Buffer.from(typeof v === 'string' ? v : String(v), 'utf8'));
const HASH = { sha1, sha256 };
const out = (u8, enc) => (enc ? Buffer.from(u8).toString(enc) : Buffer.from(u8));

function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return Buffer.from(b); }

function randomUUID() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function createHash(alg) {
  const f = HASH[alg];
  if (!f) throw new Error('Unsupported hash ' + alg);
  const parts = [];
  return { update(d) { parts.push(bytes(d)); return this; }, digest(enc) { return out(f(Buffer.concat(parts)), enc); } };
}

function createHmac(alg, key) {
  const f = HASH[alg];
  const h = hmac.create(f, bytes(key));
  return { update(d) { h.update(bytes(d)); return this; }, digest(enc) { return out(h.digest(), enc); } };
}

/* Node's defaults: N = 16384, r = 8, p = 1 */
function scryptSync(pass, salt, len, o = {}) {
  return Buffer.from(scrypt(bytes(pass), bytes(salt), { N: o.N || o.cost || 16384, r: o.r || o.blockSize || 8, p: o.p || o.parallelization || 1, dkLen: len }));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

function pbkdf2(pass, salt, iter, len, digest, cb) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const done = (e, v) => setTimeout(() => cb(e, v), 0);
  if (!subtle) { try { done(null, Buffer.from(pbkdf2Js(HASH[digest], bytes(pass), bytes(salt), { c: iter, dkLen: len }))); } catch (e) { done(e); } return; }
  subtle.importKey('raw', bytes(pass), 'PBKDF2', false, ['deriveBits'])
    .then(k => subtle.deriveBits({ name: 'PBKDF2', salt: bytes(salt), iterations: iter, hash: digest === 'sha1' ? 'SHA-1' : 'SHA-256' }, k, len * 8))
    .then(bits => done(null, Buffer.from(new Uint8Array(bits))), e => done(e));
}

function hkdfSync(alg, ikm, salt, info, len) {
  return hkdf(HASH[alg], bytes(ikm), bytes(salt), bytes(info), len).buffer;
}

/* aes-256-gcm with Node's streaming API (update + final), all at once in final() */
function createCipheriv(alg, key, iv) {
  if (alg !== 'aes-256-gcm') throw new Error('Unsupported cipher ' + alg);
  let aad, tag;
  const parts = [];
  return {
    setAAD(a) { aad = bytes(a); return this; },
    update(d) { parts.push(bytes(d)); return Buffer.alloc(0); },
    final() { const ct = gcm(bytes(key), bytes(iv), aad).encrypt(Buffer.concat(parts)); tag = ct.slice(ct.length - 16); return Buffer.from(ct.slice(0, ct.length - 16)); },
    getAuthTag() { return Buffer.from(tag); }
  };
}

function createDecipheriv(alg, key, iv) {
  if (alg !== 'aes-256-gcm') throw new Error('Unsupported cipher ' + alg);
  let aad, tag;
  const parts = [];
  return {
    setAAD(a) { aad = bytes(a); return this; },
    setAuthTag(t) { tag = bytes(t); return this; },
    update(d) { parts.push(bytes(d)); return Buffer.alloc(0); },
    final() { return Buffer.from(gcm(bytes(key), bytes(iv), aad).decrypt(Buffer.concat([...parts, tag]))); }
  };
}

module.exports = { randomBytes, randomUUID, createHash, createHmac, scryptSync, timingSafeEqual, pbkdf2, hkdfSync, createCipheriv, createDecipheriv };
