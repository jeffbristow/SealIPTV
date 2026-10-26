/* Seal IPTV for Fire TV — web/test-pieces.js   (node web/test-pieces.js)
   Big answers and files go between Android and the page a piece at a time (a 50 MB
   movie list as one Java string ran the Fire TV out of memory). Checks, with a fake
   Android side: answers and saved files come back exactly, accents, other scripts and
   emoji included, even when a piece ends in the middle of a character. */
const assert = require('assert');
const CHUNK = 1024 * 1024;   // as NativeBridge.CHUNK

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

// the fake Android side: files as bytes, chunkOf like NativeBridge
const files = new Map(), blobs = new Map();
const chunkOf = (buf, n) => (buf == null ? null : n * CHUNK >= buf.length ? '' : buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK)).toString('base64'));
let calls = { writeFile: 0, appendFile: 0, readFile: 0 };
global.window = {
  SealNative: {
    readFile: p => { calls.readFile++; return files.has(p) ? files.get(p).toString('utf8') : null; },
    writeFile: (p, t) => { calls.writeFile++; files.set(p, Buffer.from(t, 'utf8')); return true; },
    appendFile: (p, t) => { calls.appendFile++; files.set(p, Buffer.concat([files.get(p), Buffer.from(t, 'utf8')])); return true; },
    fileSize: p => (files.has(p) ? files.get(p).length : -1),
    fileChunk: (p, n) => chunkOf(files.get(p), n),
    blobChunk: (b, n) => chunkOf(blobs.get(b), n),
    blobDrop: b => blobs.delete(b),
    request: (id, json) => {
      const body = Buffer.from(JSON.parse(json).url === 'big' ? big : 'small answer', 'utf8');
      const answer = body.length > 512 * 1024 ? { ok: true, status: 200, headers: {}, body: '', blob: 'b1', size: body.length, charset: 'utf-8' } : { ok: true, status: 200, headers: {}, body: body.toString() };
      if (answer.blob) blobs.set('b1', body);
      setTimeout(() => { window.__take = JSON.stringify(answer); window.__nativeDone(id); }, 5);
    },
    take: () => window.__take
  }
};
const { request } = require('./src/shims/native');
const fs = require('./src/shims/fs');

// text where 1 MB pieces fall inside 2-, 3- and 4-byte characters
const unit = 'Movie é ñ ü — 東京 Ελληνικά 😀🎬 | ';
const big = '[' + unit.repeat(Math.ceil((8 * CHUNK) / Buffer.byteLength(unit))) + ']';

(async () => {
  const r = await request({ url: 'big' });
  ok(r.ok && r.body === big, `an 8 MB answer comes back exactly (${(Buffer.byteLength(big) / CHUNK).toFixed(1)} MB in 1 MB pieces)`);
  ok(blobs.size === 0, 'the answer\'s file on the Android side is removed afterwards');
  ok((await request({ url: 'small' })).body === 'small answer', 'small answers still come back as text');

  fs.writeFileSync('/data/catalog/x.json', big);
  ok(calls.appendFile > 10 && files.get('/data/catalog/x.json').toString('utf8') === big, `a big file is written in pieces (${calls.appendFile + 1}) and is exact — emoji split between pieces included`);
  calls.readFile = 0;
  ok(fs.readFileSync('/data/catalog/x.json') === big && calls.readFile === 0, 'a big file is read back in pieces, exactly');
  fs.writeFileSync('/data/small.json', '{"a":1}');
  ok(fs.readFileSync('/data/small.json') === '{"a":1}', 'small files: one piece, as before');
  assert.throws(() => fs.readFileSync('/data/none.json'), /ENOENT/);
  ok(true, 'a missing file: ENOENT');
  console.log(`\nPieces tests: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
