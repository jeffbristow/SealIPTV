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
  const parts = [];
  return eachPiece(next, charset, t => parts.push(t)) ? parts.join('') : null;
}
/** The same, handing each piece's text to fn instead of keeping it all (the TV guide). false if it's gone. */
function eachPiece(next, charset, fn) {
  let dec;
  try { dec = new TextDecoder(charset || 'utf-8'); } catch { dec = new TextDecoder('utf-8'); }
  for (let n = 0; ; n++) {
    const b64 = next(n);
    if (b64 == null) return false;
    if (b64 === '') break;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    fn(dec.decode(bytes, { stream: true }));
  }
  fn(dec.decode());
  return true;
}

/**
 * An HTTP request done by Android (no CORS, any host). -> { ok, status, headers, body }
 * opts.stream: a big answer isn't read here — r.pieces(fn) hands it over a piece at a time.
 */
function request(opts) {
  return new Promise(resolve => {
    const id = String(nextId++);
    waiting.set(id, r => {
      if (r && r.ok && r.blob && opts.stream) {
        const blob = r.blob, charset = r.charset;
        r.pieces = async fn => {
          try {
            for (let n = 0; ; n++) {
              const b64 = N.blobChunk(blob, n);
              if (b64 == null) throw new Error('the answer is gone');
              if (b64 === '') break;
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              (r._dec || (r._dec = (() => { try { return new TextDecoder(charset || 'utf-8'); } catch { return new TextDecoder('utf-8'); } })()));
              fn(r._dec.decode(bytes, { stream: true }));
              await new Promise(ok => setTimeout(ok, 0));   // the page stays responsive meanwhile
            }
            fn(r._dec ? r._dec.decode() : '');
          } finally { try { N.blobDrop(blob); } catch { /* gone */ } }
        };
      } else if (r && r.ok && r.blob) {
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

module.exports = { N, request, nativeCall, onEvent, readPieces, eachPiece };
