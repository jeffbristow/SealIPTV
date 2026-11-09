/* =====================================================================
 * Seal IPTV — introscan.js   (Learn intros: the sound of an episode, read from its file)
 * ---------------------------------------------------------------------
 * For Settings → Playback → "Learn intros and end credits": the sound of
 * the start and the end of an episode, without playing it. Only the parts
 * of the file needed are downloaded (MP4 or MKV); the sound is taken out
 * of them (the video is skipped; MP4, MKV or AVI), decoded (WebCodecs) and turned into
 * prints (audioprint.js) — the same numbers the players make as they play.
 *
 *   IntroScan.run({ onStatus, signal, force })   every season of the series on the Watchlist and in
 *     the user's own categories not read yet (force: all again): a few episodes each -> intros.js
 *     (scan:season) -> fixed intros / end credits, synced. Waits while something plays.
 *   IntroScan.episode(url, { head: 900, tail: 420, signal })
 *     -> { dur, head: { first, h: Int32Array }, tail: { first, h } }
 *   throws an Error with .code = 'codec' when the sound can't be decoded here
 *   (AC-3 / E-AC-3: Windows' Chrome has no decoder for them).
 *
 * Sections:
 *   1. Reading the file (byte ranges)
 *   2. MP4: the sound track's samples
 *   3. MKV: the sound track's blocks
 *   4. Decoding -> prints
 *   5. The run: series -> seasons -> episodes
 * ===================================================================== */
'use strict';

(function (root) {
  const PIECE = 24 * 1024 * 1024;  // bytes per request

  /* =================================================================
   * 1. READING THE FILE
   * ================================================================= */
  const dbg = { requests: 0, bytes: 0, samples: 0, outputs: 0, errors: [] };
  async function range(url, from, to, signal) {     // [from, to] inclusive
    const t0 = Date.now();
    const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
    dbg.requests++;
    if (dbg.log) dbg.log.push(`${from}-${to} ${r.status} ${Date.now() - t0}ms ${String(r.url).slice(0, 30)}`);
    if (r.status !== 206 && r.status !== 200) throw new Error(`The provider answered ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    const total = Number(((r.headers.get('content-range') || '').split('/')[1]) || 0);
    // a server that ignores Range sends it all from 0
    dbg.bytes += b.length;
    return { b: r.status === 200 ? b.subarray(from, to + 1) : b, total: total || (r.status === 200 ? b.length : 0), url: r.url };
  }

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

  /* =================================================================
   * 2. MP4
   * ================================================================= */
  function boxes(b, from, to) {
    const out = [];
    for (let o = from; o + 8 <= to;) {
      let size = u32(b, o), head = 8;
      const type = str(b, o + 4, 4);
      if (size === 1) { size = u64(b, o + 8); head = 16; } else if (size === 0) size = to - o;
      if (size < head) break;
      out.push({ type, at: o, start: o + head, end: Math.min(to, o + size), size });
      o += size;
    }
    return out;
  }
  const child = (b, box, type) => boxes(b, box.start, box.end).find(x => x.type === type);
  const path = (b, box, ...types) => { for (const t of types) { if (!box) return null; box = child(b, box, t); } return box; };

  /** where the moov box is (it can come after the media): its bytes */
  async function mp4Moov(url, first, total, signal) {
    let o = 0;
    for (let i = 0; i < 50 && o < total; i++) {
      let b = first, at = o;
      if (o + 16 > first.length) { b = (await range(url, o, o + 15, signal)).b; at = 0; }
      let size = u32(b, at); const type = str(b, at + 4, 4);
      if (size === 1) size = u64(b, at + 8); else if (size === 0) size = total - o;
      if (type === 'moov') {
        const m = o + size <= first.length ? first.subarray(o, o + size) : (await range(url, o, o + size - 1, signal)).b;
        return m;
      }
      if (size < 8) break;
      o += size;
    }
    throw new Error('This file has no index (moov)');
  }

  /** the sound track: its codec setup, and each sample's place, size and time */
  function mp4Track(moov) {
    const top = { start: 8, end: moov.length };
    for (const trak of boxes(moov, top.start, top.end).filter(x => x.type === 'trak')) {
      const mdia = child(moov, trak, 'mdia'), hdlr = mdia && child(moov, mdia, 'hdlr');
      if (!hdlr || str(moov, hdlr.start + 8, 4) !== 'soun') continue;
      const mdhd = child(moov, mdia, 'mdhd'), v = moov[mdhd.start];
      const scale = v === 1 ? u32(moov, mdhd.start + 20) : u32(moov, mdhd.start + 12);
      const duration = v === 1 ? u64(moov, mdhd.start + 24) : u32(moov, mdhd.start + 16);
      const stbl = path(moov, mdia, 'minf', 'stbl');
      const stsd = child(moov, stbl, 'stsd');
      const entry = { at: stsd.start + 8, type: str(moov, stsd.start + 12, 4) };
      const entryStart = stsd.start + 8, entrySize = u32(moov, entryStart);
      const channels = (moov[entryStart + 24] << 8) | moov[entryStart + 25];
      const rate = u32(moov, entryStart + 32) >>> 16;
      let config = null, codec = entry.type;
      if (entry.type === 'mp4a') {
        const esds = boxes(moov, entryStart + 36, entryStart + entrySize).find(x => x.type === 'esds');
        if (esds) config = esdsConfig(moov.subarray(esds.start + 4, esds.end));
        codec = config ? 'mp4a.40.' + (config[0] >> 3) : 'mp4a.40.2';
      } else if (entry.type === 'Opus') codec = 'opus';
      else if (entry.type === '.mp3') codec = 'mp3';
      // the sample table
      const get = t => child(moov, stbl, t);
      const stts = get('stts'), stsc = get('stsc'), stsz = get('stsz'), stco = get('stco'), co64 = get('co64');
      const n = u32(moov, stsz.start + 8), fixed = u32(moov, stsz.start + 4);
      const size = new Uint32Array(n), time = new Float64Array(n), off = new Float64Array(n);
      for (let i = 0; i < n; i++) size[i] = fixed || u32(moov, stsz.start + 12 + i * 4);
      let t = 0, s = 0;
      for (let k = 0, e = u32(moov, stts.start + 4); k < e; k++) {
        const cnt = u32(moov, stts.start + 8 + k * 8), d = u32(moov, stts.start + 12 + k * 8);
        for (let j = 0; j < cnt && s < n; j++, s++) { time[s] = t; t += d; }
      }
      const chunks = stco ? u32(moov, stco.start + 4) : u32(moov, co64.start + 4);
      const chunkOff = c => (stco ? u32(moov, stco.start + 8 + c * 4) : u64(moov, co64.start + 8 + c * 8));
      const runs = [];
      for (let k = 0, e = u32(moov, stsc.start + 4); k < e; k++) runs.push([u32(moov, stsc.start + 8 + k * 12) - 1, u32(moov, stsc.start + 12 + k * 12)]);
      s = 0;
      for (let r = 0; r < runs.length; r++) {
        const [c0, per] = runs[r], c1 = r + 1 < runs.length ? runs[r + 1][0] : chunks;
        for (let c = c0; c < c1 && s < n; c++) {
          let o = chunkOff(c);
          for (let j = 0; j < per && s < n; j++, s++) { off[s] = o; o += size[s]; }
        }
      }
      return { codec, config, channels, rate, scale, dur: duration / scale, n, size, time, off };
    }
    throw new Error('This file has no sound track');
  }

  /** the AudioSpecificConfig in an esds box (descriptor tag 5) */
  function esdsConfig(b) {
    let o = 0;
    const len = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = b[o++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
    while (o < b.length) {
      const tag = b[o++], n = len();
      if (tag === 3) { const flags = b[o + 2]; o += 3; if (flags & 0x80) o += 2; if (flags & 0x40) o += 1 + b[o]; if (flags & 0x20) o += 2; continue; }
      if (tag === 4) { o += 13; continue; }
      if (tag === 5) return b.slice(o, o + n);
      o += n;
    }
    return null;
  }

  /** samples in [a, b) s, downloaded piece by piece: each(packet bytes, time s) */
  async function mp4Samples(url, tr, a, b, each, signal) {
    let i = 0;
    while (i < tr.n && tr.time[i] / tr.scale < a) i++;
    while (i < tr.n && tr.time[i] / tr.scale < b) {
      const from = tr.off[i];
      let j = i;
      while (j < tr.n && tr.time[j] / tr.scale < b && tr.off[j] + tr.size[j] - from <= PIECE) j++;
      if (j === i) j = i + 1;
      const to = Math.max(...Array.from({ length: j - i }, (_, k) => tr.off[i + k] + tr.size[i + k])) - 1;
      const { b: buf } = await range(url, from, to, signal);
      for (let k = i; k < j; k++) {
        const o = tr.off[k] - from;
        if (o >= 0 && o + tr.size[k] <= buf.length) await each(buf.subarray(o, o + tr.size[k]), tr.time[k] / tr.scale);
      }
      i = j;
    }
  }

  /* =================================================================
   * 3. MKV (EBML)
   * ================================================================= */
  function vint(b, o, keepMarker) {
    const c = b[o];
    if (c === undefined) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(c & mask)) { len++; mask >>= 1; }
    if (len > 8 || o + len > b.length) return null;
    let v = keepMarker ? c : c & (mask - 1), all = (c & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 255) all = false; }
    return { v, len, unknown: !keepMarker && all };
  }
  /** one element at o: { id, start (data), end, size } (end null: size unknown) */
  function element(b, o) {
    const id = vint(b, o, true); if (!id) return null;
    const sz = vint(b, o + id.len); if (!sz) return null;
    const start = o + id.len + sz.len;
    return { id: id.v, start, end: sz.unknown ? null : start + sz.v };
  }
  const uint = (b, s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; };
  const float = (b, s, e) => { const d = new DataView(b.buffer, b.byteOffset + s, e - s); return e - s === 4 ? d.getFloat32(0) : d.getFloat64(0); };

  const ID = { SEGMENT: 0x18538067, INFO: 0x1549A966, SCALE: 0x2AD7B1, DURATION: 0x4489, TRACKS: 0x1654AE6B, ENTRY: 0xAE, NUMBER: 0xD7, TYPE: 0x83, CODEC: 0x86, PRIVATE: 0x63A2, AUDIO: 0xE1, FREQ: 0xB5, CHANNELS: 0x9F, CLUSTER: 0x1F43B675, TIMECODE: 0xE7, SIMPLE: 0xA3, GROUP: 0xA0, BLOCK: 0xA1 };

  /** the header: the sound track, the time scale and length, where the clusters start */
  async function mkvHead(url, first, total, signal) {
    let b = first;
    const seg = element(b, element(b, 0).end);
    if (!seg || seg.id !== ID.SEGMENT) throw new Error('This MKV file has no segment');
    let scale = 1e6, dur = 0, track = null, o = seg.start, clusters = 0;
    for (let i = 0; i < 64; i++) {
      if (o + 12 > b.length) b = Uint8Array.from([...b, ...(await range(url, b.length, Math.min(total - 1, b.length + PIECE), signal)).b]);
      const e = element(b, o);
      if (!e) break;
      if (e.id === ID.CLUSTER) { clusters = o; break; }
      if (e.end > b.length) b = Uint8Array.from([...b, ...(await range(url, b.length, Math.min(total - 1, e.end + 64), signal)).b]);
      if (e.id === ID.INFO) {
        for (let p = e.start; p < e.end;) { const x = element(b, p); if (!x || x.end == null) break; if (x.id === ID.SCALE) scale = uint(b, x.start, x.end); if (x.id === ID.DURATION) dur = float(b, x.start, x.end); p = x.end; }
      } else if (e.id === ID.TRACKS) {
        for (let p = e.start; p < e.end;) {
          const t = element(b, p), tr = {};
          if (!t || t.end == null) break;
          for (let q = t.start; q < t.end;) {
            const x = element(b, q);
            if (!x || x.end == null) break;
            if (x.id === ID.NUMBER) tr.number = uint(b, x.start, x.end);
            else if (x.id === ID.TYPE) tr.type = uint(b, x.start, x.end);
            else if (x.id === ID.CODEC) tr.codecId = str(b, x.start, x.end - x.start).replace(/\0+$/, '');
            else if (x.id === ID.PRIVATE) tr.private = b.slice(x.start, x.end);
            else if (x.id === ID.AUDIO) for (let r = x.start; r < x.end;) { const y = element(b, r); if (!y || y.end == null) break; if (y.id === ID.FREQ) tr.rate = float(b, y.start, y.end); if (y.id === ID.CHANNELS) tr.channels = uint(b, y.start, y.end); r = y.end; }
            q = x.end;
          }
          if (tr.type === 2 && !track) track = tr;
          p = t.end;
        }
      }
      if (e.end == null) break;
      o = e.end;
    }
    if (!track) throw new Error('This file has no sound track');
    const c = track.codecId;
    track.codec = c === 'A_AAC' || c.startsWith('A_AAC/') ? 'mp4a.40.' + (track.private ? track.private[0] >> 3 : 2)
      : c === 'A_OPUS' ? 'opus' : c === 'A_MPEG/L3' ? 'mp3' : c === 'A_FLAC' ? 'flac' : c === 'A_VORBIS' ? 'vorbis' : c;
    if (track.codec.startsWith('mp4a') && !track.private) track.private = null;
    if (dbg.log) dbg.log.push('mkv track ' + JSON.stringify({ n: track.number, c: track.codecId, r: track.rate, ch: track.channels, p: track.private && track.private.length, scale, dur, clusters }));
    return { track, scale, dur: (dur * scale) / 1e9, clusters, segStart: seg.start };
  }

  /**
   * blocks of the sound track from byte `from` (a cluster's start, or near one: the next one is
   * found) until time b: each(bytes, time s). Read piece by piece.
   */
  async function mkvBlocks(url, mk, from, total, a, b, each, signal) {
    let buf = new Uint8Array(0), base = from, o = 0, ct = null, synced = false, late = 0;
    const more = async () => {
      if (base + buf.length >= total) return false;
      const next = (await range(url, base + buf.length, Math.min(total - 1, base + buf.length + PIECE - 1), signal)).b;
      const keep = buf.subarray(o);
      const nb = new Uint8Array(keep.length + next.length); nb.set(keep); nb.set(next, keep.length);
      base += o; o = 0; buf = nb;
      return true;
    };
    const ns = mk.scale / 1e9;
    for (;;) {
      if (o + 16 > buf.length && !(await more())) return;
      if (!synced) {
        // find a cluster: its id, a size, then its time code
        let found = -1;
        for (let i = o; i + 12 < buf.length; i++) {
          if (buf[i] === 0x1F && buf[i + 1] === 0x43 && buf[i + 2] === 0xB6 && buf[i + 3] === 0x75) {
            // a cluster: a time code among its first few elements (after a CRC, a position …)
            const e = element(buf, i);
            let q = e ? e.start : -1;
            for (let k = 0; k < 3 && q >= 0 && q + 8 < buf.length; k++) {
              const x = element(buf, q);
              if (!x || x.end == null) break;
              if (x.id === ID.TIMECODE) { found = i; break; }
              q = x.end;
            }
            if (found >= 0) break;
          }
        }
        if (found < 0) { o = Math.max(o, buf.length - 12); if (!(await more())) return; continue; }
        o = found; synced = true;
      }
      let e2 = element(buf, o);
      if (!e2) { if (!(await more())) return; continue; }
      if (dbg.ids && dbg.seen++ < 3000) { const k = e2.id.toString(16); dbg.ids[k] = (dbg.ids[k] || 0) + 1; }
      if (e2.id === ID.CLUSTER || e2.id === ID.SEGMENT || e2.id === ID.GROUP) { o = e2.start; continue; }   // go inside
      if (e2.end == null) { o = e2.start; continue; }
      while (e2.end > buf.length) { if (!(await more())) return; e2 = element(buf, o); }    // (more() moves buf)
      if (e2.id === ID.TIMECODE) {
        ct = uint(buf, e2.start, e2.end);
        if (late != null && ct * ns > a + 2) { const x = new Error('late'); x.late = true; throw x; }   // started past a: from further back
        late = null;
      }
      else if ((e2.id === ID.SIMPLE || e2.id === ID.BLOCK) && ct != null) {
        const tn = vint(buf, e2.start);
        if (dbg.tracks && tn) dbg.tracks[tn.v] = (dbg.tracks[tn.v] || 0) + 1;
        if (tn && tn.v === mk.track.number) {
          const p = e2.start + tn.len;
          const rel = (buf[p] << 8 | buf[p + 1]) << 16 >> 16, flags = buf[p + 2];
          const t = (ct + rel) * ns;
          if (t >= b) return;
          if (t >= a) for (const f of laced(buf, p + 3, e2.end, (flags >> 1) & 3)) await each(f, t);
        }
      } else if (e2.id === ID.CLUSTER) { o = e2.start; continue; }
      o = e2.end;
    }
  }

  /** a block's frames (lacing: none, Xiph, fixed, EBML) */
  function laced(b, s, e, lacing) {
    if (!lacing) return [b.subarray(s, e)];
    const n = b[s] + 1;
    let o = s + 1;
    const sizes = [];
    if (lacing === 1) for (let i = 0; i < n - 1; i++) { let v = 0, c; do { c = b[o++]; v += c; } while (c === 255); sizes.push(v); }
    else if (lacing === 3) {
      const f = vint(b, o); sizes.push(f.v); o += f.len;
      for (let i = 1; i < n - 1; i++) { const d = vint(b, o); o += d.len; sizes.push(sizes[i - 1] + d.v - (2 ** (7 * d.len - 1) - 1)); }
    }
    const rest = e - o - sizes.reduce((x, y) => x + y, 0);
    if (lacing === 2) { const each = (e - o) / n; for (let i = 0; i < n; i++) sizes[i] = each; } else sizes.push(rest);
    const out = [];
    for (const z of sizes) { out.push(b.subarray(o, o + z)); o += z; }
    return out;
  }

  /* =================================================================
   * 3b. AVI (RIFF): the sound chunks, found with the index (idx1) at the end
   * ================================================================= */
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);

  /** -> { dur, fmt, chunks: [{ at (file offset of the data), size, t (s) }] } */
  async function aviHead(url, first, total, signal) {
    let b = first;
    if (str(b, 0, 4) !== 'RIFF' || str(b, 8, 4) !== 'AVI ') throw new Error('This AVI file has no header');
    let usPerFrame = 0, frames = 0, audio = -1, strh = null, fmt = null, n = -1, movi = 0, moviEnd = 0;
    // the top-level lists: hdrl (the streams), movi (the data), idx1 (the index)
    for (let o = 12; o + 12 <= total;) {
      const top = o + 12 <= first.length ? first.subarray(o, o + 12) : (await range(url, o, o + 11, signal)).b;
      const id = str(top, 0, 4), size = le32(top, 4);
      if (id === 'LIST' && str(top, 8, 4) === 'hdrl') {
        if (o + 8 + size > b.length) b = (await range(url, 0, o + 8 + size, signal)).b;
        let stream = -1;
        const walk = (from, to) => {
          for (let q = from; q + 8 <= to;) {
            const cid = str(b, q, 4), cs = le32(b, q + 4), d = q + 8;
            if (cid === 'LIST') walk(d + 4, d + cs);
            else if (cid === 'avih') { usPerFrame = le32(b, d); frames = le32(b, d + 16); }
            else if (cid === 'strh') { stream++; if (str(b, d, 4) === 'auds' && audio < 0) { audio = stream; strh = { scale: le32(b, d + 20), rate: le32(b, d + 24), sampleSize: le32(b, d + 44) }; } }
            else if (cid === 'strf' && stream === audio && !fmt) fmt = { tag: le16(b, d), channels: le16(b, d + 2), rate: le32(b, d + 4), bytes: le32(b, d + 8) };
            q = d + cs + (cs & 1);
          }
        };
        walk(o + 12, o + 8 + size);
      } else if (id === 'LIST' && str(top, 8, 4) === 'movi') { movi = o + 8; moviEnd = o + 8 + size; }
      else if (id === 'idx1') {
        if (audio < 0 || !fmt) throw new Error('This file has no sound track');
        if (fmt.tag === 0x2000 || fmt.tag === 0x2001) { const x = new Error('The sound (AC-3) can\'t be read on this PC'); x.code = 'codec'; throw x; }
        if (fmt.tag !== 0x55 && fmt.tag !== 0x50) { const x = new Error('The sound (AVI format ' + fmt.tag + ') can\'t be read on this PC'); x.code = 'codec'; throw x; }
        const ix = (await range(url, o + 8, o + 7 + size, signal)).b;
        const want = String(audio).padStart(2, '0') + 'wb';
        const chunks = [];
        let rel = null, bytes = 0, count = 0;
        for (let q = 0; q + 16 <= ix.length; q += 16) {
          if (str(ix, q, 4) !== want) continue;
          const off = le32(ix, q + 8), sz = le32(ix, q + 12);
          if (rel == null) rel = off < movi;    // offsets from the 'movi' word, or from the file's start
          const at = (rel ? movi + off : off) + 8;
          // time: by bytes (a constant rate), or a chunk is one frame (sampleSize 0: a varying rate)
          const t = strh.sampleSize ? (bytes / strh.sampleSize) * strh.scale / strh.rate : count * strh.scale / strh.rate;
          chunks.push({ at, size: sz, t });
          bytes += sz; count++;
        }
        if (!chunks.length) throw new Error('This AVI file\'s index has no sound');
        return { dur: usPerFrame * frames / 1e6, fmt, chunks };
      }
      if (!size && id !== 'LIST') break;
      o += 8 + size + (size & 1);
    }
    throw new Error(movi ? 'This AVI file has no index' : 'This AVI file has no data');
  }

  /** the sound between a and b s: the chunks' bytes, read in pieces, decoded in one go */
  async function aviTake(url, av, a, b, signal) {
    const list = av.chunks.filter(c => c.t >= a && c.t < b);
    if (!list.length) return { first: Math.round(a * AudioPrint.FPS), h: new Int32Array(0) };
    const out = new Uint8Array(list.reduce((x, c) => x + c.size, 0));
    let o = 0, i = 0;
    while (i < list.length) {
      const from = list[i].at;
      let j = i;
      while (j + 1 < list.length && list[j + 1].at + list[j + 1].size - from <= PIECE) j++;
      const piece = (await range(url, from, list[j].at + list[j].size - 1, signal)).b;
      for (; i <= j; i++) { out.set(piece.subarray(list[i].at - from, list[i].at - from + list[i].size), o); o += list[i].size; dbg.samples++; }
    }
    const ab = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(out.buffer);
    dbg.outputs++;
    const n = ab.length, mono = new Float32Array(n);
    for (let c = 0; c < ab.numberOfChannels; c++) { const x = ab.getChannelData(c); for (let k = 0; k < n; k++) mono[k] += x[k] / ab.numberOfChannels; }
    return printsOf([[list[0].t, mono, ab.sampleRate]], a);
  }

  /* =================================================================
   * 4. DECODING -> PRINTS
   * ================================================================= */
  /** prints of decoded sound: pieces [time s, mono Float32Array, rate] -> { first, h } */
  function printsOf(pieces, from) {
    const all = [];
    const p = AudioPrint.create((f, h) => all.push([f, h]));
    for (const [t, mono, rate] of pieces) {
      p.reset(t);
      for (let i = 0; i < mono.length; i += 16384) p.push(mono.subarray(i, i + 16384), rate);
      p.flush();
    }
    if (!all.length) return { first: Math.round(from * AudioPrint.FPS), h: new Int32Array(0) };
    let first = Infinity, last = 0;
    for (const [f, h] of all) { first = Math.min(first, f); last = Math.max(last, f + h.length); }
    const h = new Int32Array(last - first);
    for (const [f, x] of all) h.set(x, f - first);
    return { first, h };
  }

  /**
   * AAC: the packets are wrapped as an ADTS stream and decoded in one go (decodeAudioData, at 16 kHz: far
   * quicker than a packet at a time). A gap (a block missing) starts a new piece: times stay right.
   */
  const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function aacPrinter(asc, from) {
    const freq = ((asc[0] & 7) << 1) | (asc[1] >> 7), chan = ((asc[1] >> 3) & 15) || 2;
    const frame = 1024 / (ADTS_RATES[freq] || 48000);
    const segs = [];
    let cur = null, expect = -1;
    return {
      async add(bytes, t) {
        dbg.samples++;
        if (!cur || Math.abs(t - expect) > 0.25) { cur = { t, list: [], size: 0 }; segs.push(cur); }
        cur.list.push(bytes.slice());
        cur.size += bytes.length + 7;
        expect = t + frame;
      },
      async done() {
        const pieces = [];
        for (const sg of segs) {
          const out = new Uint8Array(sg.size);
          let o = 0;
          for (const b of sg.list) {
            const len = b.length + 7;
            out[o] = 0xFF; out[o + 1] = 0xF1;
            out[o + 2] = (1 << 6) | (freq << 2) | (chan >> 2);       // AAC LC (HE-AAC decodes as its core: enough here)
            out[o + 3] = ((chan & 3) << 6) | (len >> 11);
            out[o + 4] = (len >> 3) & 0xFF;
            out[o + 5] = ((len & 7) << 5) | 0x1F;
            out[o + 6] = 0xFC;
            out.set(b, o + 7);
            o += len;
          }
          sg.list = null;
          const ab = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(out.buffer);
          dbg.outputs++;
          const n = ab.length, mono = new Float32Array(n);
          for (let c = 0; c < ab.numberOfChannels; c++) { const x = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += x[i] / ab.numberOfChannels; }
          pieces.push([sg.t, mono, ab.sampleRate]);
        }
        return printsOf(pieces, from);
      }
    };
  }

  /** a decoder for the sound track that turns what it decodes into prints from time `from` */
  async function printer(codec, rate, channels, description, from) {
    if (/^mp4a\.40\./.test(codec) && description && description.length >= 2) return aacPrinter(description, from);
    const cfg = { codec, sampleRate: rate, numberOfChannels: channels };
    if (description) cfg.description = description;
    let ok = false;
    try { ok = (await AudioDecoder.isConfigSupported(cfg)).supported; } catch { ok = false; }
    if (!ok) { const e = new Error(`The sound (${codec}) can't be read on this PC`); e.code = 'codec'; throw e; }
    const all = [];
    let firstIndex = -1, err = null, expect = -1;
    const p = AudioPrint.create((f, h) => { if (firstIndex < 0) firstIndex = f; all.push([f, h]); });
    p.reset(from);
    const dec = new AudioDecoder({
      output: d => {
        dbg.outputs++;
        try {
          const n = d.numberOfFrames, ch = d.numberOfChannels, mono = new Float32Array(n), tmp = new Float32Array(n);
          const t = d.timestamp / 1e6;
          if (expect >= 0 && Math.abs(t - expect) > 0.25) p.reset(t);    // a gap (a block missing): times stay right
          expect = t + n / d.sampleRate;
          for (let c = 0; c < ch; c++) { d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' }); for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch; }
          p.push(mono, d.sampleRate);
        } catch (e) { err = e; dbg.errors.push(String(e)); } finally { d.close(); }
      },
      error: e => { err = e; dbg.errors.push(String(e)); }
    });
    dec.configure(cfg);
    return {
      async add(bytes, t) {
        if (err) throw err;
        dbg.samples++;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(t * 1e6), data: bytes }));
        if (dec.decodeQueueSize > 64) await new Promise(res => dec.addEventListener('dequeue', res, { once: true }));
      },
      async done() {
        await dec.flush(); dec.close(); p.flush();
        if (err) throw err;
        // one array from the first frame on
        if (!all.length) return { first: Math.round(from * AudioPrint.FPS), h: new Int32Array(0) };
        const first = Math.min(...all.map(x => x[0])), last = Math.max(...all.map(([f, h]) => f + h.length));
        const h = new Int32Array(last - first);
        for (const [f, x] of all) h.set(x, f - first);
        return { first, h };
      }
    };
  }

  /**
   * How much of an episode is read: the start (intros come in the first 12 minutes; less of a short
   * episode) and the end (the credits). Only the sound is used, but the video comes with it (the
   * provider sends about 4 MB a second, one request at a time): reading less is what makes it quick.
   */
  const HEAD = dur => Math.min(720, Math.max(300, dur * 0.3));
  const TAIL = dur => Math.min(300, Math.max(150, dur * 0.1));

  /** the start (head s) and the end (tail s) of an episode as prints */
  async function episode(url, { head = HEAD, tail = TAIL, signal } = {}) {
    const got = await range(url, 0, 256 * 1024 - 1, signal);
    const { b: first, total } = got;
    if (got.url) url = got.url;      // where the provider sent it: the rest from there (no redirects each time)
    if (!total) throw new Error('The provider didn\'t say how long the file is');
    if (str(first, 4, 4) === 'ftyp') {
      const tr = mp4Track(await mp4Moov(url, first, total, signal));
      const take = async (a, b) => {
        const pr = await printer(tr.codec, tr.rate, tr.channels, tr.config, a);
        await mp4Samples(url, tr, a, b, (x, t) => pr.add(x, t), signal);
        return pr.done();
      };
      const dur = tr.dur;
      if (typeof head === 'function') { head = head(dur); tail = tail(dur); }
      const h = await take(0, Math.min(head, dur));
      const t = dur > head ? await take(Math.max(head, dur - tail), dur) : null;
      return { dur, head: h, tail: t };
    }
    if (first[0] === 0x1A && first[1] === 0x45 && first[2] === 0xDF && first[3] === 0xA3) {
      const mk = await mkvHead(url, first, total, signal);
      const tr = mk.track;
      const take = async (a, b, from) => {
        const pr = await printer(tr.codec, Math.round(tr.rate || 48000), tr.channels || 2, tr.private || undefined, a);
        await mkvBlocks(url, mk, from, total, a, b, (x, t) => pr.add(x, t), signal);
        return pr.done();
      };
      const dur = mk.dur;
      if (!dur) throw new Error('This MKV file doesn\'t say how long it is');
      if (typeof head === 'function') { head = head(dur); tail = tail(dur); }
      const h = await take(0, Math.min(head, dur), mk.clusters);
      let t = null;
      if (dur > head) {
        const a = Math.max(head, dur - tail);
        // a little before where that time should be in the file (the bytes per second vary)
        for (let back = 0.03; ; back *= 2) {
          const from = Math.max(mk.clusters, Math.floor(mk.clusters + (total - mk.clusters) * (a / dur) - back * total));
          try { t = await take(a, dur + 1, from); break; } catch (e) { if (!e.late || from === mk.clusters) throw e; }
        }
      }
      return { dur, head: h, tail: t };
    }
    if (str(first, 0, 4) === 'RIFF' && str(first, 8, 4) === 'AVI ') {
      const av = await aviHead(url, first, total, signal);
      const dur = av.dur || av.chunks[av.chunks.length - 1].t;
      if (typeof head === 'function') { head = head(dur); tail = tail(dur); }
      const h = await aviTake(url, av, 0, Math.min(head, dur), signal);
      const t = dur > head ? await aviTake(url, av, Math.max(head, dur - tail), dur + 1, signal) : null;
      return { dur, head: h, tail: t };
    }
    throw new Error('This kind of file can\'t be read here (only MP4, MKV and AVI)');
  }

  /* =================================================================
   * 5. THE RUN
   * ================================================================= */
  const PER_SEASON = 3;
  const sleep = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Stopped', 'AbortError')); }, { once: true });
  });
  /** a few episodes of a season, spread out (not the first or last when there are enough: premieres and finales differ) */
  function choose(eps) {
    const n = eps.length;
    if (n <= PER_SEASON) return eps.slice();
    const at = [1, Math.floor(n / 2), n - 2].filter((x, i, a) => a.indexOf(x) === i);
    return at.map(i => eps[i]);
  }

  /**
   * onStatus({ text, series, done: [{ series, season, intro, credits, note }] }) as it goes.
   * -> the same list of what was found per season
   */
  async function run({ onStatus = () => {}, signal, force = false } = {}) {
    const done = [];
    const say = (text, series = '') => onStatus({ text, series, done });
    say('Finding the series…');
    const targets = await call('scan:targets');
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      if (signal && signal.aborted) break;
      let d;
      try { d = await call('details:series', t.id); } catch (e) { done.push({ series: t.name || t.id, note: e.message }); continue; }
      const name = d.name || t.name, seasons = (d.info && d.info.seasons) || [];
      const read = await call('scan:seasons', name);
      for (const ss of seasons) {
        if (signal && signal.aborted) break;
        const eps = (ss.episodes || []).filter(e => e && e.id);
        if (eps.length < 2) continue;
        const pick = choose(eps);
        const before = read[ss.num];
        if (!force && before && before.n >= pick.length) continue;
        const got = [];
        let note = '';
        for (let k = 0; k < pick.length; k++) {
          const e = pick[k];
          while (await call('scan:playing')) { say('Waiting: something is playing', name); await sleep(10000, signal); }
          say(`${name}: season ${ss.num}, episode ${e.num || k + 1} (${k + 1} of ${pick.length}) — series ${ti + 1} of ${targets.length}`, name);
          try {
            let r;
            for (let tries = 0; ; tries++) {     // (a dropped connection: once more, a little later)
              try {
                const { url } = await call('scan:url', { kind: 'episode', id: e.id, ext: e.ext, seriesId: t.id });
                r = await episode(url, { signal });
                break;
              } catch (y) { if (y.code === 'codec' || (signal && signal.aborted) || tries >= 1) throw y; await sleep(5000, signal); }
            }
            got.push({ key: 'episode:' + e.id, dur: r.dur, head: r.head, tail: r.tail });
          } catch (x) {
            if (signal && signal.aborted) throw x;
            note = x.message;
            if (x.code === 'codec') break;      // the season's other episodes are the same kind
          }
        }
        if (got.length < 2) { done.push({ series: name, season: ss.num, note: note || 'too few episodes could be read' }); say('', name); continue; }
        const res = await call('scan:season', { show: name, season: ss.num, eps: got });
        done.push({ series: name, season: ss.num, intro: res && res.intro, credits: res && res.credits, eps: res && res.eps, note });
        say('', name);
      }
    }
    say(signal && signal.aborted ? 'Stopped.' : 'Done.');
    return done;
  }

  const api = { episode, run, dbg, _mp4Track: m => mp4Track(m), _mp4Moov: mp4Moov, _range: range };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IntroScan = api;
})(typeof window !== 'undefined' ? window : globalThis);
