/* =====================================================================
 * Seal IPTV for Fire TV — shims/native.js
 * ---------------------------------------------------------------------
 * The Java side (NativeBridge.java) is window.SealNative. Quick calls
 * are synchronous (files, Keystore, network state); web requests are
 * asynchronous: request(id, json) -> Java calls window.__nativeDone(id)
 * -> take(id) returns the answer (big playlists don't travel through
 * evaluateJavascript).
 * Events from Java: window.__nativeEvent(name, json).
 *
 * In a desktop browser (tests) a fake SealNative can be set up before
 * this file loads.
 * ===================================================================== */
const N = (typeof window !== 'undefined' && window.SealNative) || null;
if (!N) console.warn('SealNative is missing: running without the Android side');

let nextId = 1;
const waiting = new Map();
const listeners = new Map();

if (typeof window !== 'undefined') {
  window.__nativeDone = id => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    let r;
    try { r = JSON.parse(N.take(id)); } catch (e) { r = { ok: false, error: e.message }; }
    w(r);
  };
  window.__nativeEvent = (name, json) => {
    let data = json;
    try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { /* plain text */ }
    for (const fn of listeners.get(name) || []) { try { fn(data); } catch (e) { console.error(e); } }
  };
}

/**
 * Text read from Android a piece at a time: next(n) gives piece n as base64,
 * '' at the end, null when it's gone. Big answers / files never travel as one
 * Java string (a 50 MB movie list ran the Fire TV out of memory that way).
 */
function readPieces(next, charset) {
  let dec;
  try { dec = new TextDecoder(charset || 'utf-8'); } catch { dec = new TextDecoder('utf-8'); }
  const parts = [];
  for (let n = 0; ; n++) {
    const b64 = next(n);
    if (b64 == null) return null;
    if (b64 === '') break;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    parts.push(dec.decode(bytes, { stream: true }));
  }
  parts.push(dec.decode());
  return parts.join('');
}

/** An HTTP request done by Android (no CORS, any host). -> { ok, status, headers, body } */
function request(opts) {
  return new Promise(resolve => {
    const id = String(nextId++);
    waiting.set(id, r => {
      if (r && r.ok && r.blob) {
        try { r.body = readPieces(n => N.blobChunk(r.blob, n), r.charset) || ''; }
        catch (e) { r = { ok: false, error: 'reading the answer failed: ' + e.message }; }
        finally { try { N.blobDrop(r.blob); } catch { /* gone */ } }
      }
      resolve(r);
    });
    N.request(id, JSON.stringify(opts));
  });
}

/** Other asynchronous Java calls (updateCheck …): N[method](id) -> { ok, data | error } */
function nativeCall(method) {
  return new Promise(resolve => {
    if (!N || typeof N[method] !== 'function') return resolve({ ok: false, error: 'Install the newest Seal IPTV for Fire TV (APK) to get updates here.' });
    const id = String(nextId++);
    waiting.set(id, resolve);
    N[method](id);
  });
}

const onEvent = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); };

module.exports = { N, request, nativeCall, onEvent, readPieces };
