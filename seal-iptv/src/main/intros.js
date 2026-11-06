/* =====================================================================
 * Seal IPTV — intros.js   (Skip intro / Next episode, found by sound)
 * ---------------------------------------------------------------------
 * While an episode plays, the player hands over its sound as prints
 * (audioprint.js / AudioPrint.java: 8 numbers a second). Nothing extra
 * is ever streamed: only what's being watched is listened to.
 *
 * Learning: the start (first 15 minutes) and the end (last 7 minutes)
 * of each episode watched are kept, a few per series. Two episodes of a
 * series share their intro and their end credits: the longest stretch
 * of the same sound in both is it. That stretch is kept as the series'
 * intro (or credits) — a few, newest first, for seasons that changed it.
 *
 * Playing: the sound coming in is compared with the series' intro and
 * credits as it plays; a few seconds of the same sound say where they
 * are in this episode (a cold open before the intro moves it, it's
 * still found). The player shows Skip intro / Next episode then.
 *
 *   begin({ key, show, season, dur })      an episode starts
 *   add(key, first, hashes, dur)  -> { intro: { start, end } | null, credits: { start, end } | null }
 *   end(key)                      -> the same          it stopped (learns, saves)
 *
 * One file per series: <data>/intros/<series name>.json
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const { pop, FPS } = require('../renderer/audioprint');

const HEAD = 15 * 60 * FPS;          // frames kept from the start of an episode
const TAIL = 7 * 60 * FPS;           // … and from its end
const NEAR = 9;                      // bits (of 32) that may differ for "the same sound"
const GAP = 3 * FPS;                 // a stretch goes on over this much that doesn't match (dialogue over the theme)
const INTRO_MIN = 10 * FPS, INTRO_MAX = 150 * FPS;
const CREDITS_MIN = 10 * FPS, CREDITS_MAX = 6 * 60 * FPS;
const LIVE_MIN = 4 * FPS;            // seconds of the same sound before the button shows
const KEEP_PRINTS = 4, KEEP_TEMPLATES = 4;
const COMMON = 24;                   // a number seen this often in one print says nothing (steady sound)

/** a series' name to tell it apart: "FROM (2022)" = "From (2022)" = "EN - From" (as library.js) */
const showName = n => String(n || '').toLowerCase().replace(/^\s*[a-z]{2,3}\s*[-:|]\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const fileName = s => (s.replace(/ /g, '-').slice(0, 80) || 'series') + '.json';

/* prints in the files: little-endian bytes, base64 (no Buffer: the TVs' bundle has none) */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Map([...B64].map((c, i) => [c, i]));
function pack(h) {
  const b = new Uint8Array(h.length * 4);
  const v = new DataView(b.buffer);
  h.forEach((x, i) => v.setInt32(i * 4, x, true));
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}
function unpack(s) {
  s = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
  const b = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64I.get(s[i]) << 18) | ((B64I.get(s[i + 1]) || 0) << 12) | ((B64I.get(s[i + 2]) || 0) << 6) | (B64I.get(s[i + 3]) || 0);
    if (o < b.length) b[o++] = (n >> 16) & 255;
    if (o < b.length) b[o++] = (n >> 8) & 255;
    if (o < b.length) b[o++] = n & 255;
  }
  const v = new DataView(b.buffer), out = new Int32Array(b.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt32(i * 4, true);
  return out;
}

/** frames first..: a print's part, without the silence at its ends */
function trim(h, first) {
  let a = 0, b = h.length;
  while (a < b && !h[a]) a++;
  while (b > a && !h[b - 1]) b--;
  return { first: first + a, h: h.slice(a, b) };
}

/* ---------------- comparing ---------------- */

/** number -> where it is in p ({ first, h }); numbers seen too often left out */
function indexOf(p) {
  const at = new Map();
  for (let i = 0; i < p.h.length; i++) {
    const x = p.h[i];
    if (!x) continue;
    const l = at.get(x);
    if (l) { if (l.length <= COMMON) l.push(p.first + i); } else at.set(x, [p.first + i]);
  }
  for (const [x, l] of at) if (l.length > COMMON) at.delete(x);
  return at;
}

/** the shifts (b frame - a frame) where b's frames from..to land on the same (or nearly: one bit) numbers in a */
function shifts(idx, b, from, to, most = 8) {
  const votes = new Map();
  const lo = Math.max(from, b.first), hi = Math.min(to, b.first + b.h.length);
  for (let j = lo; j < hi; j++) {
    const x = b.h[j - b.first];
    if (!x) continue;
    for (let k = -1; k < 32; k++) {
      const l = idx.get(k < 0 ? x : x ^ (1 << k));
      if (l) for (const i of l) { const o = j - i; votes.set(o, (votes.get(o) || 0) + 1); }
    }
  }
  return [...votes].filter(([, v]) => v >= 2).sort((p, q) => q[1] - p[1]).slice(0, most).map(([o]) => o);
}

/**
 * Stretches where b (frames from..to) has a's sound, shifted by o (b frame = a frame + o): each
 * { from, to } in b's frames (to excluded), with how many frames matched. The longest one.
 */
function longest(a, b, o, from, to, min) {
  let best = null, start = -1, lastGood = -1, good = 0, compared = 0;
  const close = () => {
    if (start < 0) return;
    const len = lastGood - start + 1;
    if (len >= min && good / compared >= 0.5 && (!best || len > best.to - best.from)) best = { from: start, to: lastGood + 1, good };
    start = -1;
  };
  const lo = Math.max(from, b.first, a.first + o), hi = Math.min(to, b.first + b.h.length, a.first + a.h.length + o);
  for (let j = lo; j < hi; j++) {
    const y = b.h[j - b.first], x = a.h[j - o - a.first];
    if (!x || !y) continue;
    const near = pop(x ^ y) <= NEAR;
    if (start >= 0 && j - lastGood > GAP) close();
    if (near) {
      if (start < 0) { start = j; good = 0; compared = 0; }
      lastGood = j; good++;
    }
    if (start >= 0) compared++;
  }
  close();
  return best;
}

/** the longest stretch of the same sound in two prints: { a: [from, to), b: [from, to) } in their own frames */
function common(a, b, min, max, idx = indexOf(a)) {
  let best = null;
  for (const o of shifts(idx, b, -Infinity, Infinity, 12)) {
    const r = longest(a, b, o, -Infinity, Infinity, min);
    if (!r) continue;
    if (r.to - r.from > max) return null;              // all the same: the same episode twice
    if (!best || r.to - r.from > best.b[1] - best.b[0]) best = { a: [r.from - o, r.to - o], b: [r.from, r.to] };
  }
  return best;
}

/* ---------------- one series' file ---------------- */
class Intros {
  constructor(dir) {
    this.dir = path.join(dir, 'intros');
    this.cache = new Map();             // series -> its file's contents (with unpacked prints)
    this.s = null;                      // the episode playing
  }

  _file(show) { return path.join(this.dir, fileName(show)); }

  _load(show) {
    if (this.cache.has(show)) return this.cache.get(show);
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this._file(show), 'utf8')); } catch { d = {}; }
    const tpl = t => ({ ...t, p: { first: 0, h: unpack(t.h) } });
    const part = x => (x && x.h ? { first: x.first || 0, h: unpack(x.h) } : null);
    const out = {
      prints: (d.prints || []).map(p => ({ key: p.key, season: p.season, at: p.at, dur: p.dur || 0, head: part(p.head), tail: part(p.tail) })),
      intro: (d.intro || []).map(tpl),
      credits: (d.credits || []).map(tpl)
    };
    this.cache.set(show, out);
    return out;
  }

  _save(show) {
    const d = this.cache.get(show);
    if (!d) return;
    const part = x => (x && x.h.length ? { first: x.first, h: pack(x.h) } : null);
    const tpl = t => ({ season: t.season, at: t.at, from: t.from, h: pack(t.p.h) });
    const out = {
      prints: d.prints.map(p => ({ key: p.key, season: p.season, at: p.at, dur: p.dur, head: part(p.head), tail: part(p.tail) })),
      intro: d.intro.map(tpl),
      credits: d.credits.map(tpl)
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this._file(show), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, f);
    } catch (e) { console.error('intros: not saved', e.message); }
  }

  /* ---------------- an episode playing ---------------- */
  begin({ key, show, season, dur } = {}) {
    const name = showName(show);
    if (!key || !name) { this.s = null; return null; }
    const d = this._load(name);
    this.s = { key: String(key), show: name, season: Number(season) || 0, dur: Number(dur) || 0, h: new Int32Array(HEAD + TAIL), last: -1, intro: null, credits: null, tried: 0, learned: false };
    return { intro: d.intro.length > 0, credits: d.credits.length > 0 };
  }

  /** frames first.. of the episode playing: where its intro / credits are, when known */
  add(key, first, hashes, dur) {
    const s = this.s;
    if (!s || s.key !== String(key)) return null;
    if (dur > 0) s.dur = dur;
    const h = hashes instanceof Int32Array ? hashes : Int32Array.from(hashes || []);
    const end = first + h.length;
    if (first < 0 || !h.length) return this.state();
    if (end > s.h.length) { const g = new Int32Array(Math.max(end, s.h.length * 2)); g.set(s.h); s.h = g; }
    s.h.set(h, first);
    s.last = end - 1;
    const d = this._load(s.show);
    const cur = { first: 0, h: s.h };
    const durF = Math.round(s.dur * FPS);

    // the intro: compared with the series' intros while in the first 15 minutes
    if (!s.intro && end <= HEAD + 30 * FPS && d.intro.length) {
      for (const t of d.intro) {
        const m = this._live(t, cur, end);
        if (m) { s.intro = { start: Math.max(0, m.o) / FPS, end: (m.o + t.p.h.length) / FPS }; break; }
      }
    }
    // the end credits: in the last 7 minutes
    if (!s.credits && durF > 0 && end >= durF - TAIL && d.credits.length) {
      for (const t of d.credits) {
        const m = this._live(t, cur, end);
        if (m) { s.credits = { start: Math.max(0, m.o) / FPS, end: Math.min(s.dur, (m.o + t.p.h.length) / FPS) }; break; }
      }
    }
    // no intro of this series in it yet: is there one in common with an episode seen before? (every minute)
    if (!s.intro && end <= HEAD && end - s.tried >= 60 * FPS && end >= 2 * 60 * FPS) {
      s.tried = end;
      this._learn(s, 'intro');
    }
    return this.state();
  }

  state() {
    const s = this.s;
    return s ? { intro: s.intro, credits: s.credits } : null;
  }

  /** the series' intro (credits) t in the sound just heard: where it starts in this episode (o) */
  _live(t, cur, end) {
    if (!t.idx) t.idx = indexOf(t.p);
    const from = Math.max(0, end - 30 * FPS);
    for (const o of shifts(t.idx, cur, from, end, 4)) {
      const r = longest(t.p, cur, o, from, end, LIVE_MIN);
      if (r && r.to >= end - 2 * FPS) return { o };   // matching now (not something a while ago)
    }
    return null;
  }

  /** the intro / credits of this series, from this episode and one seen before */
  _learn(s, kind) {
    const d = this._load(s.show);
    const durF = Math.round(s.dur * FPS);
    const mine = kind === 'intro' ? trim(s.h.subarray(0, Math.min(HEAD, s.last + 1)), 0)
      : durF > 0 ? trim(s.h.subarray(Math.max(0, durF - TAIL), Math.min(durF, s.last + 1)), Math.max(0, durF - TAIL)) : null;
    if (!mine || mine.h.length < (kind === 'intro' ? INTRO_MIN : CREDITS_MIN)) return false;
    const others = d.prints.filter(p => p.key !== s.key && (kind === 'intro' ? p.head : p.tail))
      .sort((p, q) => (q.season === s.season) - (p.season === s.season) || q.at - p.at);
    for (const p of others) {
      const theirs = kind === 'intro' ? p.head : p.tail;
      if (!theirs.idx) theirs.idx = indexOf(theirs);
      const c = kind === 'intro' ? common(theirs, mine, INTRO_MIN, INTRO_MAX, theirs.idx) : common(theirs, mine, CREDITS_MIN, CREDITS_MAX, theirs.idx);
      if (!c) continue;
      const [a, b] = c.b;
      if (kind === 'intro' && b > s.last - GAP && s.last + 1 < HEAD && !s.ending) continue;   // still going: learned once it's over
      const tpl = { season: s.season, at: Date.now(), from: a, p: { first: 0, h: mine.h.slice(a - mine.first, b - mine.first) } };
      const list = d[kind].filter(t => !(t.season === s.season));
      list.unshift(tpl);
      d[kind] = list.slice(0, KEEP_TEMPLATES);
      if (kind === 'intro') s.intro = { start: a / FPS, end: b / FPS };
      else s.credits = { start: a / FPS, end: b / FPS };
      s.learned = true;
      return true;
    }
    return false;
  }

  /** the episode stopped: kept for the next ones, and learned from */
  end(key) {
    const s = this.s;
    if (!s || (key != null && s.key !== String(key))) return null;
    this.s = null;
    if (s.last < 0) return null;
    const d = this._load(s.show);
    s.ending = true;
    if (!s.intro) this._learn(s, 'intro');
    if (!s.credits) this._learn(s, 'credits');
    const durF = Math.round(s.dur * FPS);
    const head = trim(s.h.subarray(0, Math.min(HEAD, s.last + 1)), 0);
    const t0 = Math.max(0, durF - TAIL);
    const tail = durF > 0 && s.last >= t0 ? trim(s.h.subarray(t0, Math.min(durF, s.last + 1)), t0) : null;
    const found = { intro: s.intro, credits: s.credits };
    if (head.h.length < 30 * FPS && !(tail && tail.h.length >= 30 * FPS)) { if (s.learned) this._save(s.show); return found; }
    const old = d.prints.find(p => p.key === s.key);
    const p = { key: s.key, season: s.season, at: Date.now(), dur: s.dur, head: head.h.length ? head : (old && old.head) || null, tail: tail && tail.h.length ? tail : (old && old.tail) || null };
    d.prints = [p, ...d.prints.filter(x => x.key !== s.key)].slice(0, KEEP_PRINTS);
    this._save(s.show);
    return found;
  }
}

module.exports = { Intros, showName, common, indexOf, longest, shifts, pack, unpack, HEAD, TAIL, NEAR };
