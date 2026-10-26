/* =====================================================================
 * Seal IPTV — avsync.js   (audio / video sync)
 * ---------------------------------------------------------------------
 * Bluetooth headphones and speakers play sound 100–400 ms late. The fix
 * is to make the picture wait just as long. One number, in ms:
 *   > 0  sound is late  -> the PICTURE waits (frames are held back and
 *                          drawn on a canvas that many ms later)
 *   < 0  sound is early -> the SOUND waits (Web Audio DelayNode)
 * It's remembered per audio output device ("Headphones (WH-1000XM4)"),
 * and follows when you switch devices.
 *
 * Also: the sync test (a dot that flashes and beeps at the same moment,
 * delayed the same way) with "Measure for me" (tap along with the beeps,
 * then with the flashes: the difference is the delay).
 *
 * Sections:
 *   1. Settings per audio device
 *   2. Picture delay (frame buffer -> canvas) + subtitles overlay
 *   3. Sound delay (Web Audio)
 *   4. Applying a value
 *   5. The sync test
 * ===================================================================== */
'use strict';

const AvSync = (() => {
  const MIN = -500, MAX = 1000, MAX_FRAMES = 75;
  let video = null, canvas = null, g2d = null, subsEl = null;
  let delay = 0;
  let device = '';
  let frames = [];               // [{ t: presentation time (ms), f: VideoFrame | ImageBitmap }]
  let pictureOn = false, rafId = 0, vfcId = 0;
  let audio = null;              // { ctx, src, node } once the sound goes through Web Audio
  const hiddenTracks = new Set();
  const listeners = new Set();

  const clamp = ms => Math.max(MIN, Math.min(MAX, Math.round((Number(ms) || 0) / 10) * 10));
  const describe = ms => (ms > 0 ? `Picture waits ${ms} ms for the sound` : ms < 0 ? `Sound waits ${-ms} ms for the picture` : 'No delay');

  /* =================================================================
   * 1. SETTINGS PER AUDIO DEVICE
   * ================================================================= */
  const cfg = () => (state.settings.playback.avSync || { def: 0, devices: {} });

  /** The default audio output's name ('' if Windows doesn't say). */
  async function outputName() {
    if (window.SealNative && window.SealNative.audioOutput) { try { return window.SealNative.audioOutput() || ''; } catch { return ''; } }   // Fire TV
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
      const def = outs.find(d => d.deviceId === 'default') || outs[0];
      return def && def.label ? def.label.replace(/^Default\s*-\s*/i, '').trim() : '';
    } catch { return ''; }
  }

  function savedFor(name) {
    const c = cfg();
    if (name && c.devices && c.devices[name] != null) return c.devices[name];
    return name ? 0 : c.def || 0;
  }

  async function refreshDevice({ announce = false } = {}) {
    const before = device;
    device = await outputName();
    const ms = savedFor(device);
    apply(ms);
    if (announce && before !== device && device) {
      toast(ms ? `${device}: audio sync ${ms > 0 ? '+' : ''}${ms} ms` : `Sound now plays on ${device}.`);
    }
  }
  try { navigator.mediaDevices.addEventListener('devicechange', () => refreshDevice({ announce: true })); } catch { /* no device events */ }

  let saveTimer = null;
  function persist(ms) {
    clearTimeout(saveTimer);
    const name = device;
    saveTimer = setTimeout(() => saveSettings({ playback: { avSync: { device: name, ms } } }), 400);
  }

  /* =================================================================
   * 2. PICTURE DELAY
   *    Frames come straight from the media pipeline (video.captureStream()
   *    read with MediaStreamTrackProcessor): every decoded frame, at an
   *    even pace, whether or not the <video> itself is drawn. Each frame
   *    is shown at (its own timestamp + delay) — timestamps are steadier
   *    than arrival times — on the canvas, which covers the <video>
   *    (left visible underneath, so Chromium keeps it fully running).
   *    Older engines: requestVideoFrameCallback + VideoFrame, same timing.
   * ================================================================= */
  let capture = null;            // { stream, reader } while frames are read from the pipeline
  let offset = null;             // performance.now() - frame time, smoothed
  let shown = null;              // the frame on screen (kept until a newer one is due)
  let lastKey = '';
  const stats = { pushed: 0, paints: [] };   // for devtest/shots.js (timing checks)

  function bind(v, c, s) {
    video = v; canvas = c; subsEl = s;
    g2d = canvas.getContext('2d', { alpha: false });
    video.crossOrigin = 'anonymous';      // so frames can be read (the app adds CORS headers to every stream)
    video.addEventListener('seeking', resync);
    video.addEventListener('emptied', resync);
    window.addEventListener('resize', () => { lastKey = ''; if (shown) paint(shown.f); });
  }

  const closeFrame = x => { try { x.f.close(); } catch { /* closed */ } };
  function clearFrames() { frames.forEach(closeFrame); frames = []; }
  function resync() { clearFrames(); offset = null; }

  /** A new frame: give it a due time from its own timestamp (ms). */
  function push(f, ts) {
    if (!pictureOn) { try { f.close(); } catch { /* closed */ } return; }
    const now = performance.now();
    const gap = now - ts;
    // first frame, a seek or a jump in the stream: start the clock again;
    // a frame that arrives early pulls the clock back at once, a late one only slowly
    if (offset == null || Math.abs(gap - offset) > 250) offset = gap;
    else if (gap < offset) offset = gap;
    else offset += (gap - offset) * 0.02;
    frames.push({ t: ts + offset, f });
    stats.pushed++;
    while (frames.length > MAX_FRAMES) closeFrame(frames.shift());
  }

  /* ---- frames from the media pipeline ---- */
  function startCapture() {
    if (typeof MediaStreamTrackProcessor !== 'function' || !video.captureStream) return false;
    try {
      const stream = capture ? capture.stream : video.captureStream();
      capture = { stream, reader: null, track: null };
      stream.onaddtrack = e => { if (e.track.kind === 'video' && pictureOn) readTrack(e.track); };
      const t = stream.getVideoTracks()[0];
      if (t) readTrack(t);
      return true;
    } catch { capture = null; return false; }
  }

  function readTrack(track) {
    if (!capture || capture.track === track) return;
    stopReading();
    capture.track = track;
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 8 }).readable.getReader();
    capture.reader = reader;
    (async () => {
      for (;;) {
        let r;
        try { r = await reader.read(); } catch { break; }
        if (r.done) break;
        if (!capture || capture.reader !== reader) { r.value.close(); break; }
        push(r.value, r.value.timestamp / 1000);
      }
    })();
  }

  function stopReading() {
    if (capture && capture.reader) { try { capture.reader.cancel(); } catch { /* done */ } capture.reader = null; }
    if (capture) capture.track = null;
  }

  /* ---- older engines: frame callbacks ---- */
  function grab(now, meta) {
    if (!pictureOn) return;
    try { push(new VideoFrame(video, { timestamp: Math.round(meta.mediaTime * 1e6) }), meta.mediaTime * 1000); }
    catch { /* frame not readable */ }
    vfcId = video.requestVideoFrameCallback(grab);
  }

  /* ---- showing them ---- */
  function draw() {
    if (!pictureOn) return;
    const due = performance.now() - delay;
    let pick = -1;
    for (let i = 0; i < frames.length && frames[i].t <= due; i++) pick = i;
    if (pick >= 0) {
      const next = frames[pick];
      frames.splice(0, pick + 1).forEach(x => { if (x !== next) closeFrame(x); });
      if (shown) closeFrame(shown);
      shown = next;
      paint(next.f);
      stats.paints.push(performance.now());
      if (stats.paints.length > 600) stats.paints.shift();
    }
    subtitles();
    rafId = requestAnimationFrame(draw);
  }

  function paint(f) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    const fw = f.displayWidth || f.width, fh = f.displayHeight || f.height;
    if (!fw || !fh || !W || !H) return;
    const key = `${W}x${H}:${fw}x${fh}`;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const k = Math.min(W / fw, H / fh), w = Math.round(fw * k), h = Math.round(fh * k);
    if (key !== lastKey) { g2d.fillStyle = '#000'; g2d.fillRect(0, 0, W, H); lastKey = key; }   // black bars only when the size changes
    g2d.drawImage(f, (W - w) >> 1, (H - h) >> 1, w, h);
  }

  /** Native subtitles draw on the <video>, which is covered now: show them in our own box. */
  let lastSubs = 0;
  function subtitles() {
    const now = performance.now();
    if (now - lastSubs < 200) return;
    lastSubs = now;
    for (const t of video.textTracks) if (t.mode === 'showing') { t.mode = 'hidden'; hiddenTracks.add(t); }
    const text = [...hiddenTracks].filter(t => t.mode === 'hidden')
      .flatMap(t => [...(t.activeCues || [])].map(c => String(c.text || '').replace(/<[^>]+>/g, ''))).join('\n');
    if (subsEl.textContent !== text) subsEl.textContent = text;
    subsEl.classList.toggle('hidden', !text);
  }

  function pictureDelay(on) {
    if (on === pictureOn || !video) return;
    pictureOn = on;
    canvas.classList.toggle('hidden', !on);
    if (on) {
      offset = null; lastKey = '';
      if (!startCapture()) vfcId = video.requestVideoFrameCallback(grab);
      rafId = requestAnimationFrame(draw);
    } else {
      stopReading();
      try { video.cancelVideoFrameCallback(vfcId); } catch { /* none */ }
      cancelAnimationFrame(rafId);
      clearFrames();
      if (shown) { closeFrame(shown); shown = null; }
      for (const t of hiddenTracks) if (t.mode === 'hidden') t.mode = 'showing';
      hiddenTracks.clear();
      subsEl.classList.add('hidden');
    }
  }

  /** Which way frames are read (for the test scripts). */
  const engine = () => (!pictureOn ? 'off' : capture && capture.reader ? 'pipeline' : 'frame-callbacks');

  /* =================================================================
   * 3. SOUND DELAY
   *    Once a <video> is connected to Web Audio it stays connected, so
   *    this is only set up the first time the sound has to wait.
   * ================================================================= */
  function soundDelay(sec) {
    if (!video) return;
    if (!audio) {
      if (sec <= 0) return;
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const src = ctx.createMediaElementSource(video);
      const node = ctx.createDelay(1);
      src.connect(node).connect(ctx.destination);
      audio = { ctx, src, node };
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    audio.node.delayTime.setTargetAtTime(sec, audio.ctx.currentTime, 0.05);
  }

  /* =================================================================
   * 4. APPLYING A VALUE
   * ================================================================= */
  function apply(ms) {
    delay = clamp(ms);
    pictureDelay(delay > 0);
    soundDelay(delay < 0 ? -delay / 1000 : 0);
    listeners.forEach(fn => fn(delay, device));
  }

  /** Change it (player slider / keys / sync test): applied now, saved for this device. */
  function set(ms) {
    apply(ms);
    persist(delay);
    return delay;
  }

  /* =================================================================
   * 5. THE SYNC TEST
   *    Every 1.5 s a dot crosses a line; as it reaches the middle it
   *    flashes and a beep sounds. Both go through the same delay as a
   *    movie would, so: move the slider until flash and beep are one.
   * ================================================================= */
  async function test() {
    await refreshDevice();
    const P = 1500;                                  // ms between beeps
    const ctx = new AudioContext({ latencyHint: 'playback' });
    const out = ctx.createDelay(1);
    out.connect(ctx.destination);
    let value = delay;
    let mode = 'sync';                               // 'sync' | 'tapAudio' | 'tapVisual'
    let taps = [];
    let running = true;
    let raf = 0;
    const beats = [];                                // [{ audio: wall ms the beep plays, visual: wall ms the flash shows }]
    const wallOf = c => { const ts = ctx.getOutputTimestamp(); return ts.performanceTime + (c - ts.contextTime) * 1000; };

    const beep = at => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1000;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.5, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.09);
      o.connect(g).connect(out);
      o.start(at); o.stop(at + 0.1);
    };

    // schedule beats ahead (audio clock); the picture follows the same timeline
    let next = ctx.currentTime + 0.6;
    const scheduler = setInterval(() => {
      while (next < ctx.currentTime + 1.2) {
        const v = mode === 'sync' ? value : 0;
        const soundWait = v < 0 ? -v : 0, pictureWait = v > 0 ? v : 0;
        if (mode !== 'tapVisual') beep(next + soundWait / 1000);
        const w = wallOf(next);
        beats.push({ audio: w + soundWait, visual: w + pictureWait, base: w });
        if (beats.length > 12) beats.shift();
        next += P / 1000;
      }
    }, 100);

    const html = `
      <p class="muted small">Watch the dot and listen. As the dot reaches the middle it flashes and beeps. Move the slider until the <b>flash and the beep happen together</b>.</p>
      <div class="sync-stage" id="syStage"><div class="sync-track"><div class="sync-mark"></div><div class="sync-dot" id="syDot"></div></div><div class="sync-flash" id="syFlash"></div><div class="sync-hint" id="syHint"></div></div>
      <div class="sync-row"><span class="small muted">Sound early</span><input type="range" id="sySlider" min="${MIN}" max="${MAX}" step="10" value="${value}"><span class="small muted">Sound late (Bluetooth)</span></div>
      <div class="sync-row center"><button class="btn small" id="syMinus">− 10 ms</button><b id="syValue" class="sync-value"></b><button class="btn small" id="syPlus">+ 10 ms</button><button class="btn small ghost" id="syZero">Reset</button></div>
      <p class="small muted center" id="syDesc"></p>
      <div class="sync-measure"><button class="btn" id="syMeasure">Measure for me…</button><button class="btn primary big hidden" id="syTap">Tap</button>
        <p class="small faint" id="syMeasureNote">Tap along with the beeps, then with the flashes; Seal IPTV works out the difference.</p></div>
      <p class="faint small">${device ? `Saved for <b>${esc(device)}</b>. Each audio device keeps its own value.` : 'Saved for this PC\'s sound output.'}</p>`;

    const shown = dialog({
      title: 'Audio sync test', okText: 'Done', hideCancel: true, wide: true, html,
      onOpen: () => {
        const slider = $('#sySlider');
        const draw = () => {
          $('#syValue').textContent = `${value > 0 ? '+' : ''}${value} ms`;
          $('#syDesc').textContent = describe(value);
          slider.value = value;
        };
        const change = v => { value = clamp(v); set(value); draw(); };
        slider.oninput = () => change(slider.value);
        $('#syMinus').onclick = () => change(value - 10);
        $('#syPlus').onclick = () => change(value + 10);
        $('#syZero').onclick = () => change(0);
        draw();

        // "Measure for me": 10 taps with the beeps (eyes closed), 10 with the flashes (sound off)
        const tap = () => {
          if (mode === 'sync') return;
          const now = performance.now();
          const key = mode === 'tapAudio' ? 'audio' : 'visual';
          const near = beats.reduce((a, b) => (Math.abs(b[key] - now) < Math.abs(a[key] - now) ? b : a), beats[0]);
          if (near && Math.abs(near[key] - now) < P / 2) taps.push({ mode, d: now - near.base });
          const done = taps.filter(t => t.mode === mode).length;
          $('#syTap').textContent = `Tap (${done}/10)`;
          if (done >= 10) {
            if (mode === 'tapAudio') { mode = 'tapVisual'; hint('Now tap along with the <b>flashes</b> (no sound this time).'); $('#syTap').textContent = 'Tap (0/10)'; }
            else finish();
          }
        };
        const hint = t => { $('#syMeasureNote').innerHTML = t; };
        const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
        const finish = () => {
          const a = taps.filter(t => t.mode === 'tapAudio').slice(2).map(t => t.d);
          const v = taps.filter(t => t.mode === 'tapVisual').slice(2).map(t => t.d);
          const ms = clamp(median(a) - median(v));
          mode = 'sync';
          show($('#syTap'), false); show($('#syMeasure'), true);
          $('#syStage').classList.remove('dim');
          hint(`Measured about <b>${ms} ms</b> (${describe(ms).toLowerCase()}). It's set now; check it with the dot and fine-tune with ± 10 ms if needed.`);
          change(ms);
        };
        $('#syMeasure').onclick = () => {
          mode = 'tapAudio'; taps = [];
          show($('#syMeasure'), false); show($('#syTap'), true);
          $('#syTap').textContent = 'Tap (0/10)';
          $('#syStage').classList.add('dim');
          hint('Look away and tap <b>Tap</b> (or press Space) along with the <b>beeps</b>.');
          $('#syTap').focus();
        };
        $('#syTap').onpointerdown = e => { e.preventDefault(); tap(); };
        $('#syTap').onclick = e => e.preventDefault();
        document.addEventListener('keydown', test.key = e => { if (e.code === 'Space' && mode !== 'sync') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) tap(); } }, true);

        // the dot
        const dot = $('#syDot'), flash = $('#syFlash');
        const frame = () => {
          if (!running) return;
          const now = performance.now();
          const b = beats.reduce((x, y) => (!x || Math.abs(y.visual - now) < Math.abs(x.visual - now) ? y : x), null);
          const visible = mode !== 'tapAudio';
          if (b && visible) {
            const phase = Math.max(-0.5, Math.min(0.5, (now - b.visual) / P));
            dot.style.left = `${(phase + 0.5) * 100}%`;
            const on = Math.abs(now - b.visual) < 70;
            flash.classList.toggle('on', on);
            dot.classList.toggle('on', on);
          }
          dot.style.visibility = visible ? 'visible' : 'hidden';
          if (!visible) flash.classList.remove('on');
          raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
      }
    });
    await shown;
    running = false;
    cancelAnimationFrame(raf);
    clearInterval(scheduler);
    document.removeEventListener('keydown', test.key, true);
    ctx.close().catch(() => {});
    return delay;
  }

  return {
    bind, set, test, describe, refreshDevice, engine,
    stats: () => ({ pushed: stats.pushed, paints: stats.paints.slice(), queued: frames.length }),
    get: () => delay,
    device: () => device,
    onChange: fn => listeners.add(fn),
    nudge: step => set(delay + step),
    stop: () => { pictureDelay(false); },
    resume: () => apply(delay),
    MIN, MAX
  };
})();
