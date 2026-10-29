/* =====================================================================
 * Seal IPTV — capture.js   (Windows: downloads and recordings, media.js)
 * ---------------------------------------------------------------------
 * Saves a stream to a file:
 *   file(url, base)   a movie / episode that is one file (.mp4, .mkv …):
 *                     continued where it stopped (Range) after a drop,
 *                     a restart or a pause
 *   hls(url, base)    an HLS address (.m3u8): the best quality's pieces
 *                     one after another (AES-128 opened); a film from
 *                     where it stopped, live TV until the end time
 *   live(url, base)   live TV as one MPEG-TS stream (.ts): written as it
 *                     comes, connected again after a drop, until the end
 * base: the file's path without its extension — the stream decides it
 * (.ts, .mp4 …). The file is <base>.<ext>.part until it's complete.
 *
 * Every function takes { fetch, ua, signal, allowed, onProgress, state }:
 *   allowed()     false: stop now (the VPN went off: nothing may reach the provider)
 *   onProgress(s) the job's state as it goes ({ bytes, total, … }); passed back in
 *                 as state to continue it later
 * ===================================================================== */
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');

const STALL_MS = 30000;          // no data for this long: the connection is dropped and made again
const RETRIES = 8;               // a film: tries in a row before giving up
const sleep = (ms, signal) => new Promise(ok => {
  const t = setTimeout(ok, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
});

class Stopped extends Error { constructor() { super('Stopped'); this.code = 'STOPPED'; } }
const vpnOff = () => Object.assign(new Error('The VPN went off: stopped, so nothing reaches your provider without it.'), { code: 'VPN' });

/** an AbortSignal that also fires after ms without poke() — a stream that stopped sending */
function stall(outer, ms = STALL_MS) {
  const ctl = new AbortController();
  let t = null;
  const poke = () => { clearTimeout(t); t = setTimeout(() => ctl.abort(new Error('No data for 30 seconds')), ms); };
  const off = () => ctl.abort(new Stopped());
  if (outer) { if (outer.aborted) off(); else outer.addEventListener('abort', off, { once: true }); }
  poke();
  return { signal: ctl.signal, poke, end: why => ctl.abort(why), done: () => { clearTimeout(t); if (outer) outer.removeEventListener('abort', off); } };
}

async function request(url, { fetch, ua, signal, headers = {} }, sig) {
  const res = await fetch(url, { headers: { 'User-Agent': ua, ...headers }, signal: sig || signal, redirect: 'follow' });
  if (res.status === 401 || res.status === 403) throw new Error(`The provider refused it (HTTP ${res.status}): too many streams at once, or the account isn't allowed this.`);
  return res;
}

async function text(url, o) {
  const s = stall(o.signal, 20000);
  try {
    const res = await request(url, o, s.signal);
    if (!res.ok) throw new Error(`The provider answered HTTP ${res.status}.`);
    return { body: await res.text(), url: res.url || url };
  } finally { s.done(); }
}

async function bytes(url, o) {
  const s = stall(o.signal, 30000);
  try {
    const res = await request(url, o, s.signal);
    if (!res.ok) throw new Error(`The provider answered HTTP ${res.status} for a piece of the video.`);
    return Buffer.from(await res.arrayBuffer());
  } finally { s.done(); }
}

/** a write stream that waits when Windows can't keep up */
async function put(out, buf) { if (!out.write(buf)) await once(out, 'drain'); }
const closeOut = out => new Promise((ok, no) => out.end(e => (e ? no(e) : ok())));

const EXT_BY_TYPE = { 'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/x-msvideo': 'avi', 'video/mp2t': 'ts', 'video/quicktime': 'mov' };
const extOf = (url, type) => {
  const m = /\.(mp4|mkv|webm|avi|m4v|mov|ts)(?:\?|$)/i.exec(String(url).split('#')[0]);
  return m ? m[1].toLowerCase() : EXT_BY_TYPE[String(type || '').split(';')[0].trim().toLowerCase()] || 'mp4';
};
const isHls = url => /\.m3u8(?:\?|$)/i.test(String(url).split('#')[0]);

/** the .part file is complete: give it its name -> the file's path */
function finish(part) {
  const file = part.replace(/\.part$/, '');
  fs.renameSync(part, file);
  return file;
}

/* =================================================================
 * ONE FILE (a movie / an episode)
 * ================================================================= */
async function file(url, base, o) {
  const st = { ...(o.state || {}) };
  let tries = 0;
  for (;;) {
    if (o.signal && o.signal.aborted) throw new Stopped();
    if (!o.allowed()) throw vpnOff();
    // what's there already: asked for the rest
    let have = 0;
    try { have = st.part ? fs.statSync(st.part).size : 0; } catch { have = 0; }
    const s = stall(o.signal);
    let out = null;
    try {
      const res = await request(url, { ...o, headers: have ? { Range: `bytes=${have}-` } : {} }, s.signal);
      if (have && res.status === 416) { try { res.body.cancel(); } catch { /* nothing */ } return { file: finish(st.part), bytes: have, total: have }; }
      if (!res.ok) throw new Error(`The provider answered HTTP ${res.status}.`);
      // a film that's a playlist after all (HLS without .m3u8 in the address)
      const type = res.headers.get('content-type') || '';
      if (/mpegurl/i.test(type)) { try { res.body.cancel(); } catch { /* nothing */ } return hls(res.url || url, base, o); }
      if (!st.part) st.part = `${base}.${extOf(res.url || url, type)}.part`;
      // the server may not continue (no Range): from the start again
      const resumed = have > 0 && res.status === 206;
      const len = Number(res.headers.get('content-length')) || 0;
      const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      st.total = range ? Number(range[1]) : len ? (resumed ? have : 0) + len : st.total || 0;
      st.bytes = resumed ? have : 0;
      out = fs.createWriteStream(st.part, { flags: resumed ? 'a' : 'w' });
      for await (const chunk of res.body) {
        if (!o.allowed()) throw vpnOff();
        s.poke();
        await put(out, chunk);
        st.bytes += chunk.length;
        o.onProgress({ ...st });
      }
      await closeOut(out);
      out = null;
      if (st.total && st.bytes < st.total) throw new Error('The download was cut short.');
      return { file: finish(st.part), bytes: st.bytes, total: st.total || st.bytes };
    } catch (e) {
      if (out) await closeOut(out).catch(() => {});
      if ((o.signal && o.signal.aborted) || e instanceof Stopped) throw new Stopped();
      if (e.code === 'VPN' || /refused it/.test(e.message)) throw e;
      if (++tries > RETRIES) throw e;
      o.onProgress({ ...st, note: e.message });
      await sleep(Math.min(30000, 1000 * 2 ** tries), o.signal);
    } finally { s.done(); }
  }
}

/* =================================================================
 * HLS (.m3u8)
 * ================================================================= */
const attrs = s => {
  const out = {};
  for (const m of String(s).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
};

/** a media playlist -> { segments: [{ seq, uri, dur, key, map }], target, ended } ; a master playlist -> { variants } */
function parsePlaylist(body, base) {
  const lines = String(body).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('The provider didn\'t send a video playlist.');
  const abs = u => new URL(u, base).href;
  const variants = [];
  const segments = [];
  let seq = 0, target = 6, ended = false, key = null, map = null, dur = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(l.slice(18));
      const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[++i] : '';
      if (uri) variants.push({ bw: Number(a.BANDWIDTH) || 0, uri: abs(uri) });
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = Number(l.slice(22)) || 6;
    else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { uri: abs(a.URI), iv: a.IV || '' };
      else throw new Error('This video is protected (DRM): it can only be watched, not saved.');
    } else if (l.startsWith('#EXT-X-MAP:')) map = abs(attrs(l.slice(11)).URI);
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (!l.startsWith('#')) { segments.push({ seq, uri: abs(l), dur, key, map }); seq++; dur = 0; }
  }
  return variants.length ? { variants } : { segments, target, ended };
}

/** the best quality (most bits per second) */
async function mediaPlaylist(url, o) {
  let { body, url: at } = await text(url, o);
  let p = parsePlaylist(body, at);
  if (p.variants) {
    const best = p.variants.sort((a, b) => b.bw - a.bw)[0];
    ({ body, url: at } = await text(best.uri, o));
    p = parsePlaylist(body, at);
    if (p.variants) throw new Error('The provider\'s playlist points to another playlist again.');
    p.url = best.uri;
  } else p.url = url;
  return p;
}

const ivOf = (seg) => {
  if (seg.key.iv) return Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(Math.floor(seg.seq / 2 ** 32), 8);
  iv.writeUInt32BE(seg.seq % 2 ** 32, 12);
  return iv;
};

async function hls(url, base, o) {
  const st = { ...(o.state || {}), hls: true };
  const keys = new Map();
  const live = !!o.until;
  let p = await mediaPlaylist(url, o);
  const fmp4 = p.segments.some(s => s.map);
  if (!st.part) st.part = `${base}.${fmp4 ? 'mp4' : 'ts'}.part`;
  // continuing a film: the file is cut back to the last whole piece written
  let start = 0;
  if (!live && st.next) {
    try { fs.truncateSync(st.part, st.bytes || 0); start = st.next; } catch { start = 0; st.bytes = 0; }
  } else if (!live) st.bytes = 0;
  if (live) st.bytes = (() => { try { return fs.statSync(st.part).size; } catch { return 0; } })();
  const out = fs.createWriteStream(st.part, { flags: start || (live && st.bytes) ? 'a' : 'w' });
  let mapDone = start > 0 || (live && st.bytes > 0), last = live ? -1 : start - 1, fails = 0;
  st.total = live ? 0 : p.segments.length;
  try {
    for (;;) {
      for (const seg of p.segments) {
        if (live ? seg.seq <= last : p.segments.indexOf(seg) <= last) continue;
        if (o.signal && o.signal.aborted) throw new Stopped();
        if (!o.allowed()) throw vpnOff();
        if (live && Date.now() >= o.until) break;
        let data;
        try {
          if (seg.map && !mapDone) { await put(out, await bytes(seg.map, o)); mapDone = true; }
          data = await bytes(seg.uri, o);
          if (seg.key) {
            if (!keys.has(seg.key.uri)) keys.set(seg.key.uri, await bytes(seg.key.uri, o));
            const d = crypto.createDecipheriv('aes-128-cbc', keys.get(seg.key.uri), ivOf(seg));
            data = Buffer.concat([d.update(data), d.final()]);
          }
          fails = 0;
        } catch (e) {
          if ((o.signal && o.signal.aborted) || e instanceof Stopped) throw new Stopped();
          if (/protected|refused it/.test(e.message)) throw e;
          // a piece that won't come: live goes on with the next ones; a film tries again, then gives up
          if (live) { o.onProgress({ ...st, note: e.message }); last = seg.seq; continue; }
          if (++fails > RETRIES) throw e;
          o.onProgress({ ...st, note: e.message });
          await sleep(Math.min(30000, 1000 * 2 ** fails), o.signal);
          break;
        }
        await put(out, data);
        st.bytes += data.length;
        if (live) last = seg.seq;
        else { last = p.segments.indexOf(seg); st.next = last + 1; }
        o.onProgress({ ...st, done: live ? undefined : st.next });
      }
      if (!live && last >= p.segments.length - 1) break;
      if (live && (Date.now() >= o.until || p.ended)) break;
      if (o.signal && o.signal.aborted) throw new Stopped();
      // live: the playlist again for the new pieces (a film: the same playlist, to try the piece again)
      if (live) await sleep(Math.max(1000, Math.min(6000, (p.target * 1000) / 2)), o.signal);
      try { p = await mediaPlaylist(p.url, o); fails = 0; }
      catch (e) {
        if ((o.signal && o.signal.aborted) || e instanceof Stopped) throw new Stopped();
        if (!live && ++fails > RETRIES) throw e;
        o.onProgress({ ...st, note: e.message });
        await sleep(5000, o.signal);
      }
      // the provider started its numbering again
      if (live && p.segments.length && p.segments[p.segments.length - 1].seq < last - 50) last = -1;
    }
  } finally {
    await closeOut(out).catch(() => {});
  }
  if (o.signal && o.signal.aborted) throw new Stopped();
  return { file: finish(st.part), bytes: st.bytes, total: st.bytes };
}

/* =================================================================
 * LIVE TV AS ONE STREAM (.ts) — until o.until
 * ================================================================= */
async function live(url, base, o) {
  if (isHls(url)) return hls(url, base, o);
  const st = { ...(o.state || {}) };
  if (!st.part) st.part = `${base}.ts.part`;
  st.bytes = (() => { try { return fs.statSync(st.part).size; } catch { return 0; } })();
  let out = fs.createWriteStream(st.part, { flags: 'a' });
  let drops = 0;
  try {
    while (Date.now() < o.until) {
      if (o.signal && o.signal.aborted) throw new Stopped();
      if (!o.allowed()) throw vpnOff();
      const s = stall(o.signal);
      // the end time: the stream is let go (that's not an error)
      const clock = setInterval(() => { if (Date.now() >= o.until) s.end(new Error('end time')); }, 1000);
      try {
        const res = await request(url, o, s.signal);
        if (!res.ok) throw new Error(`The provider answered HTTP ${res.status}.`);
        // an HLS answer at a .ts address: as HLS from here
        if (/mpegurl/i.test(res.headers.get('content-type') || '')) {
          try { res.body.cancel(); } catch { /* nothing */ }
          await closeOut(out);
          out = null;
          return hls(res.url || url, base, { ...o, state: st });
        }
        for await (const chunk of res.body) {
          if (!o.allowed()) throw vpnOff();
          s.poke();
          await put(out, chunk);
          st.bytes += chunk.length;
          o.onProgress({ ...st });
        }
        drops = 0;
      } catch (e) {
        if ((o.signal && o.signal.aborted) || e instanceof Stopped) throw new Stopped();
        if (Date.now() >= o.until) break;
        if (e.code === 'VPN' || /refused it/.test(e.message)) throw e;
        drops++;
        o.onProgress({ ...st, note: e.message });
        await sleep(Math.min(15000, 1000 * drops), o.signal);
      } finally { clearInterval(clock); s.done(); }
    }
  } finally {
    if (out) await closeOut(out).catch(() => {});
  }
  if (o.signal && o.signal.aborted) throw new Stopped();
  return { file: finish(st.part), bytes: st.bytes, total: st.bytes };
}

module.exports = { file, hls, live, parsePlaylist, extOf, isHls, Stopped };
