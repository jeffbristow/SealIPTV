/* fs for the Fire TV app: the few synchronous calls store / library / catalog / sync use,
   done by Android in the app's private storage (NativeBridge.readFile …). Text files only. */
const { N, readPieces } = require('./native');

// files bigger than this (the playlist cache) are read / written a piece at a time
const BIG = 512 * 1024;
const PIECE = 256 * 1024;   // characters per appendFile

// files fetched ahead (the playlist cache at start-up, core.js): much faster than the bridge
const ahead = new Map();

const enoent = p => Object.assign(new Error(`ENOENT: no such file '${p}'`), { code: 'ENOENT' });

/* The playlist files are served at the app's own address too (MainActivity.catalogFile): read from
   there they take a second where the bridge took 15. null: not one of them, or an APK before 1.1.14. */
const catalogUrl = p => (String(p).startsWith('/data/catalog/') ? 'https://appassets.androidplatform.net/catalog/' + encodeURIComponent(String(p).split('/').pop()) : null);
function readFromPage(p) {
  const url = catalogUrl(p);
  if (!url || !globalThis.__pageFetch || typeof XMLHttpRequest === 'undefined') return null;
  try {
    const x = new XMLHttpRequest();
    x.open('GET', url, false);   // the callers read files synchronously (catalog.js)
    x.send();
    return x.status === 200 ? x.responseText : null;
  } catch { return null; }
}

module.exports = {
  catalogUrl,
  readFileSync(p) {
    p = String(p);
    if (ahead.has(p)) { const s = ahead.get(p); ahead.delete(p); return s; }
    if (N.fileSize && N.fileChunk) {
      const size = N.fileSize(p);
      if (size < 0) throw enoent(p);
      if (size > BIG) {
        const quick = readFromPage(p);
        if (quick != null) return quick;
        const s = readPieces(n => N.fileChunk(p, n), 'utf-8');
        if (s == null) throw enoent(p);
        return s;
      }
    }
    const s = N.readFile(p);
    if (s == null) throw enoent(p);
    return s;
  },
  writeFileSync(p, data) {
    p = String(p);
    const text = typeof data === 'string' ? data : String(data);
    if (text.length <= BIG || !N.appendFile) {
      if (!N.writeFile(p, text)) throw new Error('Could not save ' + p);
      return;
    }
    // in pieces; never split a character made of two UTF-16 halves
    let at = 0, first = true;
    while (at < text.length) {
      let end = Math.min(text.length, at + PIECE);
      const c = text.charCodeAt(end - 1);
      if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
      const piece = text.slice(at, end);
      if (!(first ? N.writeFile(p, piece) : N.appendFile(p, piece))) throw new Error('Could not save ' + p);
      first = false;
      at = end;
    }
  },
  renameSync(a, b) { if (!N.renameFile(String(a), String(b))) throw enoent(a); },
  unlinkSync(p) { if (!N.deleteFile(String(p))) throw enoent(p); },
  existsSync(p) { return !!N.exists(String(p)); },
  mkdirSync() { /* folders are made when a file is written */ },
  rmSync(p) { try { N.deleteFile(String(p)); } catch { /* gone */ } },
  readdirSync() { return []; },
  /** fetch(url) now, so the next readFileSync(p) has it at once; false if the app can't serve it (older APK) */
  async readAhead(p, url = catalogUrl(p), tries = 3) {
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise(r => setTimeout(r, 400));
      if (await this._readAhead(p, url)) return true;
    }
    return false;
  },
  /** a file read ahead that turned out not to be needed */
  dropAhead(p) { ahead.delete(String(p)); },
  async _readAhead(p, url) {
    try {
      const pageFetch = globalThis.__pageFetch;   // the WebView's own fetch (shims/inject.js)
      if (!pageFetch || !url) return false;
      const r = await pageFetch(url);
      if (!r.ok) return false;
      ahead.set(String(p), await r.text());
      return true;
    } catch (e) { console.log('[seal] reading ahead failed: ' + e.message); return false; }
  }
};
