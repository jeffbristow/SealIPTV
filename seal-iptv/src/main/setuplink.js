/* =====================================================================
 * Seal IPTV for Fire TV — phone/link.js   ("Set up from your phone")
 * ---------------------------------------------------------------------
 * The code on the TV (in the QR code) and what the phone sends with it.
 * Used by both ends: the TV's core.js and the phone's page (page.js).
 *
 * The phone's page is plain http on the home network (the TV has no
 * certificate), so what it sends — a sync passphrase, a playlist
 * password — is encrypted first: XChaCha20-Poly1305 with a key made from
 * the code (PBKDF2-SHA256). The code is only in the QR code / on the TV's
 * screen (after the # in the address: browsers never send that part), so
 * someone watching the Wi-Fi sees only the sealed message.
 * Pure JS (@noble): a phone's browser has no Web Crypto on http.
 * ===================================================================== */
const { xchacha20poly1305 } = require('@noble/ciphers/chacha');
const { pbkdf2 } = require('@noble/hashes/pbkdf2');
const { sha256 } = require('@noble/hashes/sha256');

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';   // no 0 / O, 1 / I / L
const LENGTH = 10;                                   // ~49 bits
const ROUNDS = 20000;

const rand = n => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
const utf8 = s => new TextEncoder().encode(s);
const b64 = u8 => { let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** A new code: 10 letters / digits that are easy to read off a TV */
function newCode() {
  const out = [];
  for (const x of rand(LENGTH * 2)) { if (x < 240) out.push(ALPHABET[x % ALPHABET.length]); if (out.length === LENGTH) break; }
  while (out.length < LENGTH) out.push(ALPHABET[rand(1)[0] % ALPHABET.length]);
  return out.join('');
}
/** "k7q2 m9xa-4f" -> "K7Q2M9XA4F" (what's typed doesn't need the dashes) */
const normal = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** "K7Q2M9XA4F" -> "K7Q2-M9XA-4F" (shown on the TV) */
const pretty = code => normal(code).replace(/^(.{4})(.{4})(.*)$/, '$1-$2-$3');

const keyFrom = code => pbkdf2(sha256, utf8(normal(code)), utf8('Seal IPTV phone setup'), { c: ROUNDS, dkLen: 32 });

/** what the phone sends: { v, n, c } (JSON text) */
function seal(key, obj) {
  const nonce = rand(24);
  const box = xchacha20poly1305(key, nonce).encrypt(utf8(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, n: b64(nonce), c: b64(box) });
}
/** the TV opens it — throws when it wasn't sealed with this code */
function open(key, text) {
  const m = JSON.parse(String(text));
  if (!m || m.v !== 1 || !m.n || !m.c) throw new Error('not a setup message');
  return JSON.parse(new TextDecoder().decode(xchacha20poly1305(key, unb64(m.n)).decrypt(unb64(m.c))));
}

module.exports = { newCode, normal, pretty, keyFrom, seal, open, ALPHABET };
