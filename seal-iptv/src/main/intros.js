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
const KEEP_PRINTS = 6, KEEP_TEMPLATES = 4;
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
  if (hi <= lo) return null;
  // 1 the same sound, 0 not, -1 nothing to compare (silence)
  const m = new Int8Array(hi - lo);
  for (let j = lo; j < hi; j++) {
    const y = b.h[j - b.first], x = a.h[j - o - a.first];
    m[j - lo] = !x || !y ? -1 : pop(x ^ y) <= NEAR ? 1 : 0;
  }
  // a stretch starts and ends on two in a row the same (one alone can be chance: it made intros start early)
  const pair = i => m[i] === 1 && ((i + 1 < m.length && m[i + 1] === 1) || (i > 0 && m[i - 1] === 1));
  for (let i = 0; i < m.length; i++) {
    if (m[i] < 0) continue;
    const j = lo + i;
    if (start >= 0 && j - lastGood > GAP) close();
    if (m[i] === 1) {
      if (start < 0) { if (!pair(i)) continue; start = j; good = 0; compared = 0; }
      good++;
      if (pair(i)) lastGood = j;
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

/**
 * every stretch of the same sound in two prints (b's frames [from, to)), none overlapping; null when too
 * long (the same episode). Not the ones cut off where either print starts or ends (heard from the middle
 * of the intro: resumed; stopped in it) — only part of it.
 */
function commons(a, b, min, max, idx = indexOf(a), intro = false) {
  const out = [];
  // (only intros: credits go on to the end. Started a few seconds in: silence before, not a late start)
  const cut = (f, t, p) => intro && ((p.first > 5 * FPS && f <= p.first + GAP) || t >= p.first + p.h.length - GAP);
  for (const o of shifts(idx, b, -Infinity, Infinity, 12)) {
    const r = longest(a, b, o, -Infinity, Infinity, min);
    if (!r) continue;
    if (r.to - r.from > max) return null;
    if (cut(r.from - o, r.to - o, a) || cut(r.from, r.to, b)) continue;
    const lap = out.findIndex(x => x[0] < r.to && r.from < x[1]);
    if (lap < 0) out.push([r.from, r.to]);
    else if (r.to - r.from > out[lap][1] - out[lap][0]) out[lap] = [r.from, r.to];
  }
  return out;
}

/**
 * What most of the episodes seen before have in common with this one: lists (one per episode) of
 * [from, to) -> { from, to, support } or null. Stretches that overlap are one; its part they all
 * share is what's kept. Intros: a short one right at the start (a channel's logo: in every episode
 * too) only when there's nothing else; then most episodes, then the longest.
 */
const EARLY = 15 * FPS, LOGO = 20 * FPS;
const logoLike = (from, to) => from < EARLY && to - from < LOGO;
function agree(lists, min, intro) {
  const all = [];
  lists.forEach((l, i) => l.forEach(([f, t]) => all.push({ f, t, i })));
  all.sort((x, y) => x.f - y.f);
  const groups = [];
  for (const x of all) {
    const g = groups.find(g => g.some(y => y.f < x.t && x.f < y.t));
    if (g) g.push(x); else groups.push([x]);
  }
  let best = null;
  for (const g of groups) {
    const per = new Map();     // per episode: its longest in the group
    for (const x of g) if (!per.has(x.i) || x.t - x.f > per.get(x.i).t - per.get(x.i).f) per.set(x.i, x);
    const eps = [...per.values()];
    // core: what they all share. The whole: the longest two of them share (an intro can come long in
    // some episodes and cut short in others: FROM; what only one other has can be a recap of it)
    let cf = -Infinity, ct = Infinity;
    for (const x of eps) { cf = Math.max(cf, x.f); ct = Math.min(ct, x.t); }
    let from = cf, to = ct;
    for (let i = 0; i < eps.length; i++) {
      for (let j = i + 1; j < eps.length; j++) {
        const f = Math.max(eps[i].f, eps[j].f), t = Math.min(eps[i].t, eps[j].t);
        if (t - f > to - from && f <= cf && t >= ct) { from = f; to = t; }
      }
    }
    if (eps.length === 1) { from = eps[0].f; to = eps[0].t; }
    if (ct - cf < min) continue;
    const c = { from, to, core: [cf, ct], support: Math.min(2, eps.length), early: intro && logoLike(cf, ct) };
    if (!best || better(c, best)) best = c;
  }
  return best;
}
/** is found a better intro (credits) than had: not a logo, more episodes share it (2 is enough), longer */
function better(c, had) {
  if (!!c.early !== !!had.early) return !c.early;
  if (c.support !== had.support) return c.support > had.support;
  return c.to - c.from > had.to - had.from;
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
    const tpl = t => ({ season: t.season, at: t.at, from: t.from, support: t.support, core: t.core, h: pack(t.p.h) });
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
    if ((!s.intro || s.introBy === 'learned') && end <= HEAD + 30 * FPS && d.intro.length) {
      for (const t of d.intro) {
        const m = this._live(t, cur, end);
        if (m) {
          const ce = t.core ? t.core[1] : t.p.h.length;
          s.intro = { start: Math.max(0, m.o + (t.core ? t.core[0] : 0)) / FPS, end: (m.o + ce) / FPS };
          s.introBy = 'heard';
          s.longer = ce < t.p.h.length ? { t, o: m.o, ce } : null;
          break;
        }
      }
    }
    // the intro heard is the short one, or the whole (longer in some episodes): it goes on past the short one?
    const L = s.longer;
    if (L && s.introBy === 'heard' && end >= L.o + L.ce + LIVE_MIN) {
      const r = longest(L.t.p, cur, L.o, L.o + L.ce, end, LIVE_MIN);
      if (r && r.to >= end - 2 * FPS) { s.intro = { start: s.intro.start, end: (L.o + L.t.p.h.length) / FPS }; s.longer = null; }
      else if (end > L.o + L.ce + 10 * FPS) s.longer = null;     // it ended: the short one
    }
    // the end credits: in the last 7 minutes
    if (!s.credits && durF > 0 && end >= durF - TAIL && d.credits.length) {
      for (const t of d.credits) {
        const m = this._live(t, cur, end);
        if (m) { s.credits = { start: Math.max(0, m.o) / FPS, end: Math.min(s.dur, (m.o + t.p.h.length) / FPS) }; break; }
      }
    }
    // what this episode has in common with ones seen before (every minute of the first 15): the longest
    // is the intro, kept when longer than the season's (a channel's logo at the start is in every
    // episode too, and can be all there is in common two minutes in; the intro may still come)
    if (end <= HEAD && end - s.tried >= 60 * FPS && end >= 2 * 60 * FPS) {
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
    // what this episode has in common with each one seen before (an intro still going: once it's over)
    const min = kind === 'intro' ? INTRO_MIN : CREDITS_MIN, max = kind === 'intro' ? INTRO_MAX : CREDITS_MAX;
    const going = kind === 'intro' && s.last + 1 < HEAD && !s.ending;
    const lists = [], same = [], seen = [];
    const half = durF > 0 ? durF / 2 : Infinity;     // an intro is in the first half (short episodes: not the credits)
    for (const p of others) {
      const theirs = kind === 'intro' ? p.head : p.tail;
      if (!theirs.idx) theirs.idx = indexOf(theirs);
      const l = commons(theirs, mine, min, max, theirs.idx, kind === 'intro');
      seen.push(l && l.length ? l.map(([f, t]) => `${(f / FPS).toFixed(1)}-${(t / FPS).toFixed(1)}`).join('+') : '-');
      if (!l) continue;
      const ok = kind === 'intro' ? l.filter(([f, t]) => f < half && !(going && t > s.last - GAP)) : l;
      lists.push(ok);
      if (p.season === s.season) same.push(ok);
    }
    // … and what most of them share (two episodes alone can share more: a scene in the next one's recap);
    // this season's first (a new season can have a new intro)
    const best = agree(same, min, kind === 'intro') || agree(lists, min, kind === 'intro');
    this.learnLog = `${kind}: ${others.length} to compare, found ${seen.join(' ') || 'nothing'}${best ? ` -> ${(best.from / FPS).toFixed(1)}-${(best.to / FPS).toFixed(1)}s in ${best.support}` : ''}`;
    if (!best) return false;
    const a = best.from, b = best.to;
    // (this episode: the whole, it's in it; from where they all agree it starts)
    const found = { start: (kind === 'intro' ? best.core[0] : a) / FPS, end: b / FPS };
    // the season's own already: kept unless this is better (it's heard while it plays: _live)
    const had = d[kind].find(t => t.season === s.season);
    if (had && !better(best, { from: had.from, to: had.from + had.p.h.length, support: had.support || 1, early: kind === 'intro' && logoLike(had.from + (had.core ? had.core[0] : 0), had.from + (had.core ? had.core[1] : had.p.h.length)) })) return false;
    const tpl = { season: s.season, at: Date.now(), from: a, support: best.support, core: [best.core[0] - a, best.core[1] - a], p: { first: 0, h: mine.h.slice(a - mine.first, b - mine.first) } };
    d[kind] = [tpl, ...d[kind].filter(t => t.season !== s.season)].slice(0, KEEP_TEMPLATES);
    s[kind] = found;
    if (kind === 'intro') s.introBy = 'learned';
    s.learned = true;
    return true;
  }

  /** the episode stopped: kept for the next ones, and learned from */
  end(key) {
    const s = this.s;
    if (!s || (key != null && s.key !== String(key))) return null;
    this.s = null;
    if (s.last < 0) return null;
    const d = this._load(s.show);
    s.ending = true;
    // learned again from all that was heard (a longer one in common replaces the season's)
    this._learn(s, 'intro');
    const li = this.learnLog || '';
    this._learn(s, 'credits');
    this.learnLog = li + '; ' + (this.learnLog || '');
    const durF = Math.round(s.dur * FPS);
    const head = trim(s.h.subarray(0, Math.min(HEAD, s.last + 1)), 0);
    const t0 = Math.max(0, durF - TAIL);
    const tail = durF > 0 && s.last >= t0 ? trim(s.h.subarray(t0, Math.min(durF, s.last + 1)), t0) : null;
    const found = { intro: s.intro, credits: s.credits };
    if (head.h.length < 30 * FPS && !(tail && tail.h.length >= 30 * FPS)) { this.lastLog = `${s.show}: too little heard (head ${head.h.length}, last ${s.last})`; if (s.learned) this._save(s.show); return found; }
    const old = d.prints.find(p => p.key === s.key);
    const p = { key: s.key, season: s.season, at: Date.now(), dur: s.dur, head: head.h.length ? head : (old && old.head) || null, tail: tail && tail.h.length ? tail : (old && old.tail) || null };
    d.prints = [p, ...d.prints.filter(x => x.key !== s.key)].slice(0, KEEP_PRINTS);
    this.lastLog = `${this.learnLog} | ${s.show}: kept head ${head.h.length} tail ${tail ? tail.h.length : 0} (last ${s.last}, dur ${s.dur}); ${d.prints.length} prints, ${d.intro.length} intros, ${d.credits.length} credits`;
    this._save(s.show);
    return found;
  }
}

module.exports = { Intros, showName, common, commons, agree, indexOf, longest, shifts, pack, unpack, HEAD, TAIL, NEAR };
