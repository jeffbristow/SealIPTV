/* =====================================================================
 * Seal IPTV — audioprint.js   (audio fingerprints: Skip intro / Next episode)
 * ---------------------------------------------------------------------
 * Turns the sound of what's playing into 8 numbers a second. The same
 * piece of sound (a series' intro, its end credits) gives nearly the
 * same numbers in every episode, so intros.js can find it again.
 *
 *   const p = AudioPrint.create(onFrames)    onFrames(firstIndex, Int32Array)
 *   p.reset(mediaTime)                        a new stretch of sound (start, seek)
 *   p.push(monoFloat32, sampleRate)           sound as it plays, from mediaTime on
 *   p.flush()                                 hand over what's waiting
 *
 * Frame n is the sound from n/8 s; a frame's number has one bit per pair
 * of neighbouring frequency bands: did the louder one of the two change
 * the same way as 1/8 s before (Haitsma & Kalker)? 0 = no sound there.
 *
 * MUST stay the same as AudioPrint.java (the Fire TV / Google TV player):
 * prints are compared between devices. test/intros-test.js checks both.
 * ===================================================================== */
'use strict';

(function (root) {
  const RATE = 16000;              // the sound is brought to this rate first
  const WIN = 4096;                // samples looked at per frame (256 ms)
  const HOP = 2000;                // 1/8 s between frames
  const FPS = RATE / HOP;          // 8
  // the 33 bands (250 Hz – 2.5 kHz, log-spaced), as FFT bins of WIN at RATE
  const EDGES = [64, 69, 74, 79, 85, 91, 97, 104, 112, 120, 129, 138, 148, 159, 170, 182, 195, 210, 225, 241, 258, 277, 297, 319, 342, 366, 393, 421, 452, 484, 519, 557, 597, 640];
  const BANDS = EDGES.length - 1;  // 33 -> 32 bits
  const QUIET = 1e-5;              // mean square under this (about −50 dB): no sound, no number

  const HANN = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  const BITS = Math.log2(WIN);
  const REV = new Uint32Array(WIN);
  for (let i = 0; i < WIN; i++) { let r = 0; for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b); REV[i] = r; }
  const COS = new Float64Array(WIN / 2), SIN = new Float64Array(WIN / 2);
  for (let i = 0; i < WIN / 2; i++) { COS[i] = Math.cos((2 * Math.PI * i) / WIN); SIN[i] = -Math.sin((2 * Math.PI * i) / WIN); }

  /** the energy in each band of one window of sound */
  function bands(buf, at, re, im, out) {
    let sq = 0;
    for (let i = 0; i < WIN; i++) { const x = buf[at + i]; sq += x * x; re[REV[i]] = x * HANN[i]; im[REV[i]] = 0; }
    for (let size = 2; size <= WIN; size <<= 1) {
      const half = size >> 1, step = WIN / size;
      for (let s = 0; s < WIN; s += size) {
        for (let k = 0; k < half; k++) {
          const c = COS[k * step], n = SIN[k * step], a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * n, ti = re[b] * n + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let m = 0; m < BANDS; m++) {
      let e = 0;
      for (let k = EDGES[m]; k < EDGES[m + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      out[m] = e;
    }
    return sq / WIN;
  }

  function create(onFrames) {
    // brought down to RATE: each output sample is the average of the input ones it covers
    let step = 0, sum = 0, cnt = 0, seen = 0, edge = 0;
    let buf = new Float32Array(WIN * 4), have = 0;     // RATE samples not yet used up
    let startTime = 0, used = 0;                       // the media time of the first RATE sample, how many were dropped since
    let prev = null, prevQuiet = true;
    const re = new Float64Array(WIN), im = new Float64Array(WIN);
    let cur = new Float64Array(BANDS), last = new Float64Array(BANDS);
    let outFirst = -1, out = [];

    function emit(index, h) {
      if (outFirst >= 0 && index !== outFirst + out.length) flush();
      if (outFirst < 0) outFirst = index;
      out.push(h);
      if (out.length >= 16) flush();
    }
    function flush() {
      if (out.length) onFrames(outFirst, Int32Array.from(out));
      outFirst = -1; out = [];
    }

    function frames() {
      while (have >= WIN) {
        const quiet = bands(buf, 0, re, im, cur) < QUIET;
        const index = Math.round((startTime + used / RATE) * FPS);
        if (prev) {
          let h = 0;
          if (!quiet && !prevQuiet) {
            for (let m = 0; m < BANDS - 1; m++) {
              if ((cur[m] - cur[m + 1]) - (last[m] - last[m + 1]) > 0) h |= 1 << m;
            }
            if (h === 0) h = 1;
          }
          emit(index, h);
        }
        const t = last; last = cur; cur = t;
        prev = true; prevQuiet = quiet;
        buf.copyWithin(0, HOP, have);
        have -= HOP;
        used += HOP;
      }
    }

    return {
      FPS,
      reset(mediaTime) {
        flush();
        step = 0; sum = 0; cnt = 0; seen = 0; edge = 0; have = 0; used = 0;
        startTime = Math.max(0, Number(mediaTime) || 0);
        prev = null; prevQuiet = true;
      },
      push(mono, rate) {
        if (!step) { step = rate / RATE; edge = step; }
        for (let i = 0; i < mono.length; i++) {
          sum += mono[i]; cnt++; seen++;
          if (seen >= edge) {
            if (have === buf.length) { const b = new Float32Array(buf.length * 2); b.set(buf); buf = b; }
            buf[have++] = sum / cnt;
            sum = 0; cnt = 0; edge += step;
          }
        }
        frames();
      },
      flush
    };
  }

  /** how many bits differ */
  function pop(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return Math.imul(x, 0x01010101) >>> 24;
  }

  const api = { create, pop, FPS, RATE, WIN, HOP, EDGES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioPrint = api;
})(typeof window !== 'undefined' ? window : globalThis);
