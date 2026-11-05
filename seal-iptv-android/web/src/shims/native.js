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
const decoder = charset => { try { return new TextDecoder(charset || 'utf-8'); } catch { return new TextDecoder('utf-8'); } };
/** base64 -> bytes (the browser's own when it has it: a byte at a time in JS took seconds for a big playlist on a TV) */
function bytesOf(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
/** The same, handing each piece's text to fn instead of keeping it all (the TV guide). false if it's gone. */
function eachPiece(next, charset, fn) {
  const dec = decoder(charset);
  for (let n = 0; ; n++) {
    const b64 = next(n);
    if (b64 == null) return false;
    if (b64 === '') break;
    fn(dec.decode(bytesOf(b64), { stream: true }));
  }
  fn(dec.decode());
  return true;
}
const tick = () => new Promise(ok => setTimeout(ok, 0));
/**
 * A big answer (a provider's movie list: 50 MB+) as text, without stopping the page:
 * APK 1.8.3+ serves the downloaded file at /blob/<name> and the WebView reads it on its own
 * (a piece at a time as it comes); older APKs: through the bridge, a pause after each piece
 * (all at once, the remote did nothing for up to 19 s on a Google TV).
 */
async function readBlob(blob, charset) {
  const dec = decoder(charset), parts = [];
  const pageFetch = globalThis.__pageFetch;   // (the browser's own: fetch here is Android's, shims/inject.js)
  if (N.blobFetch && pageFetch) {
    try {
      const res = await pageFetch('https://appassets.androidplatform.net/blob/' + encodeURIComponent(blob), { cache: 'no-store' });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(dec.decode(value, { stream: true }));
        }
        parts.push(dec.decode());
        return parts.join('');
      }
    } catch { /* through the bridge below */ }
    parts.length = 0;
  }
  const d2 = decoder(charset);
  for (let n = 0; ; n++) {
    const b64 = N.blobChunk(blob, n);
    if (b64 == null) throw new Error('the answer is gone');
    if (b64 === '') break;
    parts.push(d2.decode(bytesOf(b64), { stream: true }));
    await tick();
  }
  parts.push(d2.decode());
  return parts.join('');
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
              r._dec || (r._dec = decoder(charset));
              fn(r._dec.decode(bytesOf(b64), { stream: true }));
              await tick();   // the page stays responsive meanwhile
            }
            fn(r._dec ? r._dec.decode() : '');
          } finally { try { N.blobDrop(blob); } catch { /* gone */ } }
        };
      } else if (r && r.ok && r.blob) {
        const blob = r.blob;
        (async () => {
          let out = r;
          try { r.body = (await readBlob(blob, r.charset)) || ''; }
          catch (e) { out = { ok: false, error: 'reading the answer failed: ' + e.message }; }
          finally { try { N.blobDrop(blob); } catch { /* gone */ } }   // (gone before the answer is handed on)
          resolve(out);
        })();
        return;
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
