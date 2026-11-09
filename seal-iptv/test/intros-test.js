/* Seal IPTV — test/intros-test.js   (node test/intros-test.js)
   Skip intro / Next episode found by sound (audioprint.js + intros.js), with made-up episodes:
   the same intro and end credits in each, after cold opens of different lengths, at other
   volumes, with noise, at 48 kHz or 44.1 kHz. Also: AudioPrint.java gives the same numbers. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AudioPrint = require('../src/renderer/audioprint');
const { Intros } = require('../src/main/intros');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

/* ---- made-up sound: notes from a seed (the same tune at any sample rate), speech-like noise ---- */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const noteCache = new Map();
function note(seed, n) {
  const k = seed * 100000 + n;
  if (!noteCache.has(k)) { const r = rng(k * 2654435761); noteCache.set(k, [200 + r() * 1800, 200 + r() * 1800, 300 + r() * 1500, 0.3 + r() * 0.7]); }
  return noteCache.get(k);
}
/** music: 3 voices, a new chord every 1/4 s */
function music(seed, t) {
  const n = Math.floor(t * 4), [f1, f2, f3, a] = note(seed, n), e = Math.min(1, (t * 4 - n) * 8);
  return a * e * (0.3 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t) + 0.15 * Math.sin(2 * Math.PI * f3 * t));
}
/** "dialogue": noise bursts and low tones, syllables of 0.1–0.3 s */
function talk(seed, t, r) {
  const n = Math.floor(t * 5), [f1, , , a] = note(seed + 7, n);
  return (a > 0.5 ? 0.25 : 0.05) * ((r() - 0.5) * 0.6 + Math.sin(2 * Math.PI * (f1 / 4) * t));
}

/**
 * an episode: [cold open][intro 40 s][story][credits 30 s] -> its mono sound, at rate.
 * intro / credits the same in every episode; the rest made from the episode's own seed.
 */
function episode({ seed, cold, story = 500, rate = 48000, gain = 1, noise = 0.01, intro = true, credits = true, introSeed = 11, creditsSeed = 22, logo = 0, scene = 0 }) {
  cold += ((seed * 37) % 50) / 1000;           // intros don't start on a frame (0–49 ms off)
  const I = intro ? 40 : 0, C = credits ? 30 : 0, dur = cold + I + story + C;
  const r = rng(seed * 977), out = new Float32Array(Math.round(dur * rate));
  const shift = r() / rate;                      // not lined up to a sample
  for (let i = 0; i < out.length; i++) {
    const t = i / rate + shift;
    let x;
    if (t < logo) x = music(44, t);                // a channel's logo, the same in every episode
    else if (t < cold) x = talk(seed, t, r) + 0.3 * music(seed + 100, t);
    else if (t < cold + I) x = music(introSeed, t - cold);
    else if (t < cold + I + scene) x = talk(55, t - cold - I, r) + 0.5 * music(66, t - cold - I);   // a scene two episodes share
    else if (t < cold + I + story) x = talk(seed + 1, t, r) + 0.25 * music(seed + 200, t);
    else x = music(creditsSeed, t - cold - I - story);
    out[i] = gain * x + noise * (r() - 0.5);
  }
  return { pcm: out, rate, dur, intro: [cold, cold + I], credits: [cold + I + story, dur] };
}

/** what a player hands over as it plays: prints in batches (like 2 s at a time) */
function prints(ep, from = 0, to = ep.dur) {
  const got = [];
  const p = AudioPrint.create((first, h) => got.push([first, h]));
  p.reset(from);
  const a = Math.round(from * ep.rate), b = Math.round(to * ep.rate);
  for (let i = a; i < b; i += 4096) p.push(ep.pcm.subarray(i, Math.min(b, i + 4096)), ep.rate);
  p.flush();
  return got;
}

/** play an episode through intros.js: the last answer, and when the intro / credits were first known */
function watch(intros, key, ep, { season = 1, from = 0, to = ep.dur, show = 'EN - Made Up Show (2024)' } = {}) {
  intros.begin({ key, show, season, dur: ep.dur });
  let st = null, introAt = null, creditsAt = null;
  for (const [first, h] of prints(ep, from, to)) {
    st = intros.add(key, first, h, ep.dur);
    const now = (first + h.length) / AudioPrint.FPS;
    if (st && st.intro && introAt == null) introAt = now;
    if (st && st.credits && creditsAt == null) creditsAt = now;
  }
  const fin = intros.end(key);
  return { st: { intro: (st && st.intro) || (fin && fin.intro) || null, credits: (st && st.credits) || (fin && fin.credits) || null }, introAt, creditsAt };
}
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

(async () => {
  /* ---- the prints themselves ---- */
  const e1 = episode({ seed: 1, cold: 60 });
  const p1 = prints(e1);
  const F = AudioPrint.FPS;
  const all = new Int32Array(Math.ceil(e1.dur * F) + F);
  for (const [first, h] of p1) all.set(h, first);
  ok(F === 32 && p1.every(([, h]) => h.length <= F / 2) && all.filter(Boolean).length > e1.dur * F * 0.95, `32 numbers a second, half a second at a time (${all.filter(Boolean).length} for ${e1.dur} s)`);
  const quiet = prints({ pcm: new Float32Array(48000 * 10), rate: 48000, dur: 10 });
  ok(quiet.every(([, h]) => h.every(x => x === 0)), 'silence: no numbers (0)');

  // the same intro in another episode: other volume, noise, sample rate, not lined up
  const e2 = episode({ seed: 2, cold: 20, rate: 44100, gain: 0.6, noise: 0.03 });
  const all2 = new Int32Array(Math.ceil(e2.dur * F) + F);
  for (const [first, h] of prints(e2)) all2.set(h, first);
  let diff = 0, n = 0;
  for (let k = F; k < 39 * F; k++) { const x = all[Math.round(e1.intro[0] * F) + k], y = all2[Math.round(e2.intro[0] * F) + k]; if (x && y) { diff += AudioPrint.pop(x ^ y); n++; } }
  let rnd = 0, rn = 0;
  for (let k = 0; k < 30 * F; k++) { const x = all[200 * F + k], y = all2[150 * F + k]; if (x && y) { rnd += AudioPrint.pop(x ^ y); rn++; } }
  ok(diff / n < 8 && rnd / rn > 13, `the same intro: ${(diff / n).toFixed(1)} of 32 bits differ; different sound: ${(rnd / rn).toFixed(1)}`);

  /* ---- learning and finding ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-intros-'));
  let intros = new Intros(dir);
  const w1 = watch(intros, 'episode:1', e1);
  ok(!w1.st.intro && !w1.st.credits, 'the first episode of a series: nothing known yet');
  const w2 = watch(intros, 'episode:2', e2);
  ok(w2.st.intro && near(w2.st.intro.start, 20) && near(w2.st.intro.end, 60), `the second: its intro learned (${w2.st.intro && w2.st.intro.start.toFixed(1)}–${w2.st.intro && w2.st.intro.end.toFixed(1)} s, really 20–60)`);
  ok(w2.st.credits && near(w2.st.credits.start, e2.credits[0]), `… and its end credits (from ${w2.st.credits && w2.st.credits.start.toFixed(1)} s, really ${e2.credits[0]})`);
  const saved = fs.readdirSync(path.join(dir, 'intros'));
  ok(saved.length === 1 && saved[0] === 'made-up-show-2024.json', `kept per series (${saved.join(', ')})`);

  // a third episode, a new start (from the files): found while it plays, a few seconds in
  intros = new Intros(dir);
  const e3 = episode({ seed: 3, cold: 95, rate: 48000, gain: 0.8, noise: 0.02 });
  const w3 = watch(intros, 'episode:3', e3);
  ok(w3.st.intro && near(w3.st.intro.start, 95) && near(w3.st.intro.end, 135), `episode 3: intro at ${w3.st.intro && w3.st.intro.start.toFixed(1)}–${w3.st.intro && w3.st.intro.end.toFixed(1)} s (really 95–135, after a longer cold open)`);
  ok(w3.introAt != null && w3.introAt - 95 <= 8, `… known ${w3.introAt && (w3.introAt - 95).toFixed(1)} s into the intro (Skip intro shows then)`);
  ok(w3.st.credits && near(w3.st.credits.start, e3.credits[0]) && w3.creditsAt - e3.credits[0] <= 8, `… credits at ${w3.st.credits && w3.st.credits.start.toFixed(1)} s (really ${e3.credits[0]}), known ${w3.creditsAt && (w3.creditsAt - e3.credits[0]).toFixed(1)} s in (Next episode shows then)`);

  // started part-way (resumed after the intro began) and with no intro at all
  const e4 = episode({ seed: 4, cold: 30 });
  const w4 = watch(intros, 'episode:4', e4, { from: 45 });
  ok(w4.st.intro && near(w4.st.intro.end, 70), `resumed in the middle of the intro: its end still known (${w4.st.intro && w4.st.intro.end.toFixed(1)} s)`);
  const e5 = episode({ seed: 5, cold: 30, intro: false, credits: false, story: 600 });
  const w5 = watch(intros, 'episode:5', e5);
  ok(!w5.st.intro && !w5.st.credits, 'an episode without the intro or credits: no buttons');

  // another series doesn't get this one's intro; one episode twice isn't an intro
  intros.begin({ key: 'episode:9', show: 'Another Show', season: 1, dur: e1.dur });
  let st9 = null;
  for (const [first, h] of p1) st9 = intros.add('episode:9', first, h, e1.dur);
  intros.end('episode:9');
  ok(!st9.intro, 'another series: its own (nothing learned yet)');
  intros.begin({ key: 'episode:9b', show: 'Another Show', season: 1, dur: e1.dur });
  for (const [first, h] of p1) st9 = intros.add('episode:9b', first, h, e1.dur);
  intros.end('episode:9b');
  ok(!st9.intro, 'the same episode under two ids: not taken for an intro');

  // a new season with another intro: learned as well, the old one kept
  const s2a = episode({ seed: 6, cold: 40, introSeed: 33 }), s2b = episode({ seed: 7, cold: 10, introSeed: 33 });
  watch(intros, 'episode:20', s2a, { season: 2 });
  const w21 = watch(intros, 'episode:21', s2b, { season: 2 });
  ok(w21.st.intro && near(w21.st.intro.start, 10), 'season 2 changed its intro: learned too');
  const w6 = watch(intros, 'episode:6', episode({ seed: 8, cold: 50 }));
  ok(w6.st.intro && near(w6.st.intro.start, 50), '… and season 1\'s is still found');

  // a logo (12 s) at the start of every episode and the intro minutes later: the intro is learned, not the logo
  // (1.8.4 learned the logo two minutes in, then stopped looking: FROM)
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-intros-'));
  const li = new Intros(ldir);
  watch(li, 'logo:1', episode({ seed: 31, cold: 200, logo: 12, story: 300 }));
  const l2 = watch(li, 'logo:2', episode({ seed: 32, cold: 260, logo: 12, story: 300 }));
  ok(l2.st.intro && near(l2.st.intro.start, 260) && near(l2.st.intro.end, 300), `a logo first, the intro at 260 s: the intro learned (${l2.st.intro && l2.st.intro.start.toFixed(1)}–${l2.st.intro && l2.st.intro.end.toFixed(1)} s)`);
  const l3 = watch(li, 'logo:3', episode({ seed: 33, cold: 230, logo: 12, story: 300 }));
  ok(l3.st.intro && near(l3.st.intro.start, 230) && l3.introAt - 230 <= 8, `… and found in the next episode while it plays (${l3.st.intro && l3.st.intro.start.toFixed(1)} s, known ${l3.introAt && (l3.introAt - 230).toFixed(1)} s in)`);
  // a template learned before (the logo, by 1.8.4) is replaced by the longer intro
  const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-intros-'));
  let oi = new Intros(odir);
  watch(oi, 'old:1', episode({ seed: 41, cold: 200, logo: 12, story: 300 }));
  watch(oi, 'old:2', episode({ seed: 42, cold: 240, logo: 12, story: 300 }), { to: 150 });
  const tplLen = () => oi._load('made up show 2024').intro.map(t => t.p.h.length / AudioPrint.FPS);
  ok(tplLen().length === 1 && tplLen()[0] < 15, `stopped after 150 s: only the logo known (${tplLen()[0].toFixed(1)} s, like 1.8.4 learned it)`);
  oi = new Intros(odir);
  const o3 = watch(oi, 'old:3', episode({ seed: 43, cold: 220, logo: 12, story: 300 }));
  ok(o3.st.intro && tplLen().length === 1 && near(tplLen()[0], 40), `a whole episode later: the intro replaces it (${tplLen()[0].toFixed(1)} s long)`);
  const o4 = watch(oi, 'old:4', episode({ seed: 44, cold: 280, logo: 12, story: 300 }));
  ok(o4.st.intro && near(o4.st.intro.start, 280) && o4.introAt - 280 <= 8, `… and is found in the next one while it plays (${o4.st.intro && o4.st.intro.start.toFixed(1)} s)`);

  // two episodes share a scene right after the intro (one's recap of the other: FROM S3E4/E5); a third doesn't:
  // the intro is what most share, not the scene
  const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-intros-'));
  const ri = new Intros(rdir);
  watch(ri, 'recap:1', episode({ seed: 51, cold: 120, story: 300 }));
  watch(ri, 'recap:2', episode({ seed: 52, cold: 150, story: 300, scene: 90 }));
  const r3 = watch(ri, 'recap:3', episode({ seed: 53, cold: 180, story: 300, scene: 90 }));
  const rt = ri._load('made up show 2024').intro.map(t => t.p.h.length / AudioPrint.FPS);
  ok(r3.st.intro && near(r3.st.intro.start, 180) && near(r3.st.intro.end, 220) && rt.length === 1 && near(rt[0], 40), `a scene two episodes share after the intro: not taken for it (${r3.st.intro && r3.st.intro.start.toFixed(1)}–${r3.st.intro && r3.st.intro.end.toFixed(1)} s, kept ${rt[0] && rt[0].toFixed(1)} s)`);

  /* ---- Learn intros: a season read from its files (introscan.js) -> fixed, synced ---- */
  const full = ep => { const all = new Int32Array(Math.ceil(ep.dur * F) + F); for (const [f, h] of prints(ep)) all.set(h, f); return all; };
  const asScanned = (key, ep) => { const all = full(ep), tailFrom = Math.max(0, Math.round((ep.dur - 420) * F)); return { key, dur: ep.dur, head: { first: 0, h: all.subarray(0, Math.min(all.length, 900 * F)) }, tail: { first: tailFrom, h: all.subarray(tailFrom) } }; };
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-scan-'));
  const si = new Intros(sdir);
  const synced = [];
  si.onChange = (k, d) => synced.push([k, d]);
  const scanEps = [1, 2, 3, 4].map(n => episode({ seed: 60 + n, cold: 30 + n * 23, story: 400, introSeed: 77, creditsSeed: 88 }));
  const res = si.learnSeason({ show: 'Scanned Show (2025)', season: 2, eps: scanEps.map((e, i) => asScanned('episode:7' + i, e)) });
  ok(res.intro && near(res.intro.len, 40, 1.5) && res.intro.support === 4, `Learn intros: a season's intro from 4 episodes' files (${res.intro && res.intro.len.toFixed(1)} s, in ${res.intro && res.intro.support} of 4)`);
  ok(res.eps.every((e, i) => e.intro && near(e.intro.start, scanEps[i].intro[0]) && near(e.intro.end, scanEps[i].intro[1])), `… found where it is in each (${res.eps.map(e => e.intro && e.intro.start.toFixed(1)).join(', ')} s)`);
  ok(res.credits && near(res.credits.len, 30, 1.5) && res.eps.every((e, i) => e.credits && near(e.credits.start, scanEps[i].credits[0])), `… and its end credits (${res.credits && res.credits.len.toFixed(1)} s)`);
  ok(synced.length === 2 && synced.every(([k, d]) => /^scanned show 2025\|2\|(intro|credits)$/.test(k) && d.h && JSON.stringify(d).length < 200000), `… handed to sync as 2 records (${synced.map(([k, d]) => k + ' ' + Math.round(JSON.stringify(d).length / 1024) + ' KB').join(', ')})`);
  ok(si.syncRecords().length === 2 && si.scannedSeasons('Scanned Show (2025)')[2], '… listed for a first sync, and the season is marked read');
  // another device: gets the records, finds the intro while an episode plays, doesn't replace them by listening
  const tv = new Intros(fs.mkdtempSync(path.join(os.tmpdir(), 'seal-tv-')));
  for (const [k, d] of synced) tv.applySynced(k, JSON.parse(JSON.stringify(d)));
  const e75 = episode({ seed: 65, cold: 140, story: 400, introSeed: 77, creditsSeed: 88 });
  const w75 = watch(tv, 'episode:75', e75, { season: 2, show: 'Scanned Show (2025)' });
  ok(w75.st.intro && near(w75.st.intro.start, e75.intro[0]) && near(w75.st.intro.end, e75.intro[1]) && w75.introAt - e75.intro[0] < 3.5, `another device, synced: the intro found while playing (${w75.st.intro && w75.st.intro.start.toFixed(1)}–${w75.st.intro && w75.st.intro.end.toFixed(1)} s, known ${(w75.introAt - e75.intro[0]).toFixed(1)} s in)`);
  ok(w75.st.credits && near(w75.st.credits.start, e75.credits[0]), `… and the end credits (${w75.st.credits && w75.st.credits.start.toFixed(1)} s)`);
  watch(tv, 'episode:76', episode({ seed: 66, cold: 60, story: 400, introSeed: 77, creditsSeed: 88, scene: 120 }), { season: 2, show: 'Scanned Show (2025)' });
  const kept = tv._load('scanned show 2025').intro.filter(t => t.season === 2);
  ok(kept.length === 1 && kept[0].fixed && near(kept[0].p.h.length / F, 40, 1.5), '… what it hears while playing never replaces it');
  tv.applySynced('scanned show 2025|2|intro', null);
  ok(!tv._load('scanned show 2025').intro.some(t => t.fixed && t.season === 2), '… and removed when removed elsewhere');

  /* ---- AudioPrint.java: the same numbers (TVs and Windows compare prints) ---- */
  const java = path.join(__dirname, '..', '..', 'seal-iptv-android', 'app', 'src', 'main', 'java', 'com', 'sealiptv', 'tv', 'AudioPrint.java');
  const { spawnSync } = require('child_process');
  if (fs.existsSync(java) && spawnSync('javac', ['-version']).status === 0) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-ap-'));
    const src = fs.readFileSync(java, 'utf8').replace(/^package .*$/m, '');
    fs.writeFileSync(path.join(tmp, 'AudioPrint.java'), src);
    fs.writeFileSync(path.join(tmp, 'Run.java'), `import java.io.*; import java.nio.*; import java.nio.file.*;
public class Run { public static void main(String[] a) throws Exception {
  byte[] b = Files.readAllBytes(Paths.get(a[0])); FloatBuffer f = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
  float[] pcm = new float[f.remaining()]; f.get(pcm);
  StringBuilder out = new StringBuilder();
  AudioPrint p = new AudioPrint((first, h, n) -> { for (int i = 0; i < n; i++) out.append(first + i).append(' ').append(h[i]).append('\\n'); });
  p.reset(0);
  for (int i = 0; i < pcm.length; i += 4096) { int n = Math.min(4096, pcm.length - i); float[] c = new float[n]; System.arraycopy(pcm, i, c, 0, n); p.push(c, n, ${e2.rate}); }
  p.flush(); System.out.print(out); } }`);
    const raw = Buffer.from(e2.pcm.buffer, 0, Math.min(e2.pcm.length, e2.rate * 120) * 4);
    fs.writeFileSync(path.join(tmp, 'pcm.bin'), raw);
    const c = spawnSync('javac', ['-d', tmp, path.join(tmp, 'AudioPrint.java'), path.join(tmp, 'Run.java')], { encoding: 'utf8' });
    assert.strictEqual(c.status, 0, c.stderr);
    const r = spawnSync('java', ['-cp', tmp, 'Run', path.join(tmp, 'pcm.bin')], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, r.stderr);
    const jv = new Map(r.stdout.trim().split('\n').map(l => l.split(' ').map(Number)));
    const js = new Map();
    const ep120 = { pcm: e2.pcm.subarray(0, e2.rate * 120), rate: e2.rate, dur: 120 };
    for (const [first, h] of prints(ep120)) h.forEach((x, i) => js.set(first + i, x));
    let same = 0, bits = 0;
    for (const [k, x] of js) { if (jv.get(k) === x) same++; else bits += AudioPrint.pop(x ^ (jv.get(k) || 0)); }
    ok(js.size === jv.size && same / js.size > 0.995, `AudioPrint.java: the same numbers as audioprint.js (${same} of ${js.size} exactly; ${bits} bits off in the rest)`);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else console.log('  - AudioPrint.java not compared (no javac)');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nIntro tests: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
