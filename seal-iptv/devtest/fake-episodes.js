/* =====================================================================
 * Seal IPTV — devtest/fake-episodes.js
 * ---------------------------------------------------------------------
 * Made-up episodes for trying Skip intro / Next episode (fake-xtream.js
 * with FAKE_INTROS=1): sound only (.wav), each one
 *   [cold open][the series' intro, 40 s][story, 7 min][the credits, 30 s]
 * with the same intro and credits in every episode and a cold open of
 * another length (20 s + 10 s per episode), so the intro moves.
 * ===================================================================== */
const RATE = 22050, INTRO = 40, STORY = 420, CREDITS = 30;

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const notes = new Map();
function note(seed, n) {
  const k = seed * 100000 + n;
  if (!notes.has(k)) { const r = rng(k * 2654435761); notes.set(k, [200 + r() * 1800, 200 + r() * 1800, 300 + r() * 1500, 0.3 + r() * 0.7]); }
  return notes.get(k);
}
function music(seed, t) {
  const n = Math.floor(t * 4), [f1, f2, f3, a] = note(seed, n), e = Math.min(1, (t * 4 - n) * 8);
  return a * e * (0.3 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t) + 0.15 * Math.sin(2 * Math.PI * f3 * t));
}
function talk(seed, t, r) {
  const n = Math.floor(t * 5), [f1, , , a] = note(seed + 7, n);
  return (a > 0.5 ? 0.25 : 0.05) * ((r() - 0.5) * 0.6 + Math.sin(2 * Math.PI * (f1 / 4) * t));
}

/** episode number n (1, 2, …): where its parts are (s) */
function layout(n) {
  const cold = 20 + 10 * ((n - 1) % 6);
  return { cold, intro: [cold, cold + INTRO], credits: [cold + INTRO + STORY, cold + INTRO + STORY + CREDITS], dur: cold + INTRO + STORY + CREDITS };
}

const cache = new Map();
/** episode n as a .wav file (16-bit mono) */
function wav(n) {
  if (cache.has(n)) return cache.get(n);
  const L = layout(n), r = rng(n * 977), count = Math.round(L.dur * RATE);
  const b = Buffer.alloc(44 + count * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + count * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = i / RATE;
    let x;
    if (t < L.intro[0]) x = talk(n, t, r) + 0.3 * music(n + 100, t);
    else if (t < L.intro[1]) x = music(11, t - L.intro[0]);
    else if (t < L.credits[0]) x = talk(n + 1, t, r) + 0.25 * music(n + 200, t);
    else x = music(22, t - L.credits[0]);
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((0.8 * x + 0.01 * (r() - 0.5)) * 32767))), 44 + i * 2);
  }
  cache.set(n, b);
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  return b;
}

/** send it, with byte ranges (seeking) */
function serve(req, res, n) {
  const b = wav(n);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': b.length, 'Accept-Ranges': 'bytes' }); return res.end(req.method === 'HEAD' ? undefined : b); }
  const start = m[1] ? Number(m[1]) : Math.max(0, b.length - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(b.length - 1, Number(m[2])) : b.length - 1;
  res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${b.length}`, 'Accept-Ranges': 'bytes' });
  res.end(req.method === 'HEAD' ? undefined : b.subarray(start, end + 1));
}

module.exports = { layout, wav, serve };
