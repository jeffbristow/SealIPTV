/* Seal IPTV — tests for downloads and recordings (Windows: capture.js, media.js) against a pretend
   provider on 127.0.0.1: a film continued after a drop, HLS with AES-128, live HLS and live .ts until
   the end time, and the streams allowed at once (playing, recording, downloading). */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const capture = require('../src/main/capture');
const { Media } = require('../src/main/media');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const rejects = async (p, re, msg) => { try { await p; } catch (e) { assert.ok(re.test(e.message) || re.test(e.code || ''), msg + ' — got: ' + e.message); passed++; console.log('  ✓ ' + msg); return e; } assert.fail(msg + ' — did not throw'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await sleep(50); } return true; };

/* ---- the pretend provider ---- */
const FILM = crypto.randomBytes(3 * 1024 * 1024 + 123);
const KEY = crypto.randomBytes(16);
const SEGS = [0, 1, 2, 3, 4].map(i => crypto.randomBytes(20000 + i));
const enc = (buf, seq) => { const iv = Buffer.alloc(16); iv.writeUInt32BE(seq, 12); const c = crypto.createCipheriv('aes-128-cbc', KEY, iv); return Buffer.concat([c.update(buf), c.final()]); };
let dropFilm = true, rangeOk = true, liveSeq = 100, tsDrop = true, filmCalls = 0, slowFilm = false;
const t0 = Date.now();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/film.mkv') {
    filmCalls++;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const from = rangeOk && m ? Number(m[1]) : 0;
    res.writeHead(from ? 206 : 200, { 'Content-Type': 'video/x-matroska', 'Content-Length': FILM.length - from, ...(from ? { 'Content-Range': `bytes ${from}-${FILM.length - 1}/${FILM.length}` } : {}) });
    if (slowFilm) { let at = from; const t = setInterval(() => { if (at >= FILM.length || res.destroyed) { clearInterval(t); return res.end(); } res.write(FILM.subarray(at, at + 65536)); at += 65536; }, 30); return; }
    // the first time: the connection drops after 1 MB
    if (dropFilm) { dropFilm = false; res.write(FILM.subarray(from, from + 1024 * 1024)); return setTimeout(() => res.destroy(), 50); }
    return res.end(FILM.subarray(from));
  }
  if (u.pathname === '/vod/master.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhigh.m3u8\n');
  if (u.pathname === '/vod/low.m3u8') return res.end('#EXTM3U\n#EXTINF:4,\nnothing.ts\n#EXT-X-ENDLIST\n');
  if (u.pathname === '/vod/high.m3u8') return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"', ...SEGS.flatMap((s, i) => ['#EXTINF:4,', `seg${i}.ts`]), '#EXT-X-ENDLIST', ''].join('\n'));
  if (u.pathname === '/key.bin') return res.end(KEY);
  let m = /^\/vod\/seg(\d)\.ts$/.exec(u.pathname);
  if (m) return res.end(enc(SEGS[Number(m[1])], Number(m[1])));
  if (u.pathname === '/drm.m3u8') return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n');
  // live HLS: a window of 3 pieces moving on every 400 ms
  if (u.pathname === '/live/chan.m3u8') {
    const head = liveSeq + Math.floor((Date.now() - t0) / 400);
    return res.end(['#EXTM3U', '#EXT-X-TARGETDURATION:1', `#EXT-X-MEDIA-SEQUENCE:${head - 2}`, ...[head - 2, head - 1, head].flatMap(n => ['#EXTINF:0.4,', `p${n}.ts`]), ''].join('\n'));
  }
  m = /^\/live\/p(\d+)\.ts$/.exec(u.pathname);
  if (m) return res.end(`[${m[1]}]`);
  // live .ts: bytes as they come; the first connection drops after a moment
  if (u.pathname === '/live/chan.ts') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    const t = setInterval(() => res.write(Buffer.alloc(1000, 7)), 50);
    req.on('close', () => clearInterval(t));
    if (tsDrop) { tsDrop = false; setTimeout(() => res.destroy(), 400); }
    return;
  }
  res.statusCode = 404; res.end();
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-media-'));
  const base = n => path.join(dir, n);
  const o = (extra = {}) => ({ fetch: globalThis.fetch, ua: 'test', allowed: () => true, onProgress: () => {}, ...extra });
  try {
    /* ---- capture: a film ---- */
    let last = null;
    const f = await capture.file(`${B}/film.mkv`, base('Film'), o({ onProgress: s => { last = s; } }));
    ok(f.file.endsWith('Film.mkv') && fs.readFileSync(f.file).equals(FILM) && filmCalls === 2, 'a film: the connection dropped after 1 MB, continued from there (Range); the file is whole');
    ok(last.total === FILM.length && !fs.existsSync(f.file + '.part'), '… with its size known, no .part left');
    rangeOk = false; dropFilm = true; filmCalls = 0;
    const f2 = await capture.file(`${B}/film.mkv`, base('Film B'), o());
    ok(fs.readFileSync(f2.file).equals(FILM) && filmCalls === 2, 'a server that can\'t continue: from the start again, still whole');
    rangeOk = true;
    // paused half way (stopped), then continued later from its state
    slowFilm = true;
    const ctl = new AbortController();
    let st = null;
    const p = capture.file(`${B}/film.mkv`, base('Film C'), o({ signal: ctl.signal, onProgress: s => { st = s; if (s.bytes > 1024 * 1024) ctl.abort(); } }));
    await rejects(p, /STOPPED|Stopped/, 'paused: stops');
    ok(st.part.endsWith('Film C.mkv.part') && fs.statSync(st.part).size >= 1024 * 1024, '… keeping what it has');
    slowFilm = false;
    const f3 = await capture.file(`${B}/film.mkv`, base('Film C'), o({ state: st }));
    ok(fs.readFileSync(f3.file).equals(FILM), 'continued later: the file is whole');

    /* ---- capture: HLS ---- */
    const h1 = await capture.hls(`${B}/vod/master.m3u8`, base('Show S01E01'), o());
    ok(h1.file.endsWith('.ts') && fs.readFileSync(h1.file).equals(Buffer.concat(SEGS)), 'HLS film: the best quality, AES-128 pieces opened and joined');
    const ctl2 = new AbortController();
    let hs = null;
    await rejects(capture.hls(`${B}/vod/master.m3u8`, base('Show S01E02'), o({ signal: ctl2.signal, onProgress: s => { hs = s; if (s.next === 2) ctl2.abort(); } })), /STOPPED|Stopped/, 'HLS film paused after 2 pieces');
    const h2 = await capture.hls(`${B}/vod/master.m3u8`, base('Show S01E02'), o({ state: hs }));
    ok(fs.readFileSync(h2.file).equals(Buffer.concat(SEGS)), '… continued from piece 3: whole, nothing twice');
    await rejects(capture.hls(`${B}/drm.m3u8`, base('Locked'), o()), /protected \(DRM\)/, 'DRM: says it can only be watched');
    const live = await capture.live(`${B}/live/chan.m3u8`, base('Live HLS'), o({ until: Date.now() + 2500 }));
    const nums = fs.readFileSync(live.file, 'utf8').match(/\d+/g).map(Number);
    ok(nums.length >= 5 && nums.every((n, i) => !i || n === nums[i - 1] + 1), `live HLS until the end time: ${nums.length} pieces in order, none twice or missing`);
    const tsStart = Date.now();
    const ts = await capture.live(`${B}/live/chan.ts`, base('Live TS'), o({ until: Date.now() + 2500 }));
    ok(ts.file.endsWith('.ts') && ts.bytes > 20000 && Date.now() - tsStart < 4500, 'live .ts: written until the end time, connected again after a drop');
    await rejects(capture.live(`${B}/live/chan.ts`, base('Live VPN'), o({ until: Date.now() + 5000, allowed: () => false })), /VPN/, 'the VPN off: stops at once');

    /* ---- media.js: the streams allowed at once ---- */
    const settings = { media: { streams: 1, folder: path.join(dir, 'Saved') } };
    const notes = [];
    const urls = { movie: `${B}/film.mkv`, episode: `${B}/vod/master.m3u8`, live: `${B}/live/chan.ts` };
    const make = () => new Media({
      dir, store: { getSettings: () => settings },
      catalog: { streamUrl: async (pid, req) => ({ url: urls[req.kind], live: req.kind === 'live' }) },
      library: { getProgress: () => ({ pos: 60, dur: 600 }) }, vpn: { ensure: async () => {}, allowed: () => true },
      fetch: globalThis.fetch, userAgent: () => 'test', videos: dir, askMs: 600,
      notify: (ev, d) => notes.push([ev, d]), freeSpace: async () => 10e9
    });
    const M = make();
    slowFilm = true;
    const d1 = M.addDownload('p1', { kind: 'movie', id: '9', ext: 'mkv' }, { title: 'Harbor Lights', year: 2021, image: 'x.jpg' });
    ok(M.addDownload('p1', { kind: 'movie', id: '9' }, { title: 'Harbor Lights' }) === d1, 'the same movie twice: one download');
    await until(() => M.get(d1).status === 'downloading' && (M.get(d1).state || {}).bytes > 0);
    ok(M.used() === 1, 'downloading uses the one stream');
    M.beforePlay();
    ok(M.get(d1).status === 'waiting' && M.used() === 1 && M.playing, 'playing: the download waits (still one stream)');
    M.afterPlay();
    ok(await until(() => M.get(d1).status === 'done', 15000), 'stopped playing: the download goes on, and finishes');
    slowFilm = false;
    const saved = M.get(d1);
    ok(saved.file === path.join(dir, 'Saved', 'Movies', 'Harbor Lights (2021).mkv') && fs.readFileSync(saved.file).equals(FILM), 'saved in Movies, named after the movie');
    const info = M.playInfo(d1);
    ok(info.url.startsWith(`sealfile://media/${d1}/`) && info.key === 'movie:9' && info.resume.pos === 60, 'played from the file, with the movie\'s own resume point');

    // recording: playing takes the one stream -> asked; recording takes it -> playing asks
    M.beforePlay();
    const e1 = await rejects(Promise.resolve().then(() => M.recordNow('p1', { channel: { id: '5', name: 'Sport One' }, end: Date.now() + 60000 })), /STREAMS|stops what's playing/, 'record now while something plays (1 stream): asks first');
    ok(e1.code === 'STREAMS' && e1.vpn.playing, '… as STREAMS (the window asks)');
    M.afterPlay();
    const r1 = M.recordNow('p1', { channel: { id: '5', name: 'Sport One' }, title: 'The Match', end: Date.now() + 60000 }, { force: true });
    ok(await until(() => M.get(r1).status === 'recording'), 'the player closed: it records');
    const e2 = await rejects(Promise.resolve().then(() => M.beforePlay()), /being recorded/, 'playing while it records (1 stream): asks first');
    ok(e2.code === 'STREAMS' && e2.vpn.recordings[0].title === 'The Match', '… naming the recording');
    await rejects(Promise.resolve().then(() => M.recordNow('p1', { channel: { id: '6', name: 'Sport Two' } })), /being recorded/, 'a second recording now: refused (no stream left)');
    await sleep(600);
    M.beforePlay({ force: true });
    ok(await until(() => M.get(r1).status === 'stopped') && M.playing && M.used() === 1, 'the user said yes: the recording stops, playing takes the stream');
    const rec = M.get(r1);
    ok(rec.file && rec.file.endsWith('.ts') && fs.statSync(rec.file).size > 0 && /Stopped to play/.test(rec.error), '… what was recorded is kept');
    M.afterPlay();

    // 2 streams: recording and playing at the same time
    settings.media.streams = 2;
    const r2 = M.recordNow('p1', { channel: { id: '5', name: 'Sport One' }, title: 'Second Half', end: Date.now() + 1500 });
    ok(await until(() => M.get(r2).status === 'recording'), 'two streams allowed: records …');
    M.beforePlay();
    ok(M.playing && M.get(r2).status === 'recording', '… and plays at the same time, nothing asked');
    M.afterPlay();
    ok(await until(() => M.get(r2).status === 'done', 6000), 'the end time: the recording is done');

    // scheduling: no more overlapping recordings than streams allowed
    settings.media.streams = 1;
    const at = Date.now() + 3600000;
    M.schedule('p1', { channel: { id: '5', name: 'Sport One' }, title: 'Late Game', start: at, end: at + 3600000 });
    await rejects(Promise.resolve().then(() => M.schedule('p1', { channel: { id: '6', name: 'Sport Two' }, title: 'Other Game', start: at + 1800000, end: at + 5400000 })), /1 stream at a time.*Late Game/, 'scheduling a recording over another one (1 stream): refused');
    settings.media.streams = 2;
    const s2 = M.schedule('p1', { channel: { id: '6', name: 'Sport Two' }, title: 'Other Game', start: at + 1800000, end: at + 5400000 });
    ok(M.get(s2).status === 'scheduled', '… allowed with 2 streams');
    const g = M.schedule('p1', { channel: { id: '7', name: 'News' }, title: 'From the guide', start: at + 7200000, end: at + 9000000, guide: true });
    ok(M.get(g).start === at + 7200000 - 60000 && M.get(g).end === at + 9000000 + 300000, 'a programme from the guide: a minute early, five minutes late');
    await rejects(Promise.resolve().then(() => M.schedule('p1', { channel: { id: '7' }, start: Date.now() - 7200000, end: Date.now() - 3600000 })), /passed/, 'a time that has passed: refused');

    // a scheduled recording that's due while something plays (1 stream): asked; no answer -> it records
    settings.media.streams = 1;
    M.beforePlay();
    notes.length = 0;
    const due = M.schedule('p1', { channel: { id: '5', name: 'Sport One' }, title: 'Due Now', start: Date.now(), end: Date.now() + 1500 });
    ok(notes.some(([ev, d]) => ev === 'media:conflict' && d.id === due), 'due while something plays: the window is asked');
    await sleep(700);
    M.tick();
    ok(notes.some(([ev, d]) => ev === 'media:takeover' && d.id === due), 'no answer: the window is told to stop playing');
    M.afterPlay();
    ok(await until(() => ['recording', 'done'].includes(M.get(due).status)), '… and it records');
    await until(() => M.get(due).status === 'done', 6000);
    M.beforePlay();
    const skip = M.schedule('p1', { channel: { id: '5', name: 'Sport One' }, title: 'Skip Me', start: Date.now(), end: Date.now() + 60000 });
    M.answer(skip, false);
    ok(M.get(skip).status === 'skipped' && !M.jobs.size, 'the user said skip: not recorded, playing goes on');
    M.afterPlay();

    // Seal IPTV closed: a scheduled one passed meanwhile is missed; one cut off goes on if there's time
    const miss = M.schedule('p1', { channel: { id: '9', name: 'Nine' }, title: 'Missed', start: Date.now() + 20 * 3600000, end: Date.now() + 21 * 3600000 });
    M.get(miss).start = Date.now() - 7200000; M.get(miss).end = Date.now() - 3600000;
    M.tick();
    ok(M.get(miss).status === 'missed', 'a time that passed while Seal IPTV was closed: missed');
    M.shutdown();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'media.json'), 'utf8'));
    raw.items.push({ id: 'cut1', type: 'recording', pid: 'p1', channel: { id: '5', name: 'Sport One' }, title: 'Cut', start: Date.now() - 60000, end: Date.now() + 60000, status: 'recording' });
    fs.writeFileSync(path.join(dir, 'media.json'), JSON.stringify(raw));
    const M2 = make();
    ok(M2.get('cut1').status === 'scheduled' && M2.get(d1).status === 'done', 'started again: a recording cut off goes on (its time isn\'t over); downloads are kept');
    ok(M2.busy().scheduled >= 1, 'closing would lose scheduled recordings: the window asks');
    ok(M2.remove(d1) && !fs.existsSync(saved.file), 'deleting a download deletes its file');
    M2.shutdown();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nDownloads + recordings tests: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); server.close(); process.exit(1); });
