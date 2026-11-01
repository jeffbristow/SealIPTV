/* =====================================================================
 * Seal IPTV for Ubuntu Touch — utplayer.js   (after player-tv.js)
 * ---------------------------------------------------------------------
 * The backup player: when Ubuntu Touch's media service can't play a stream
 * (qml/Player.qml sends 'fallback' — e.g. the phone's sound system isn't
 * working, which stops media-hub from playing anything), the stream plays
 * here in the web view instead: <video> with hls.js (HLS) / mpegts.js
 * (MPEG-TS) / the browser itself (MP4 …). The stream still goes through the
 * app's backend (User-Agent, VPN guard). It sends player-tv.js the same
 * events as the native player (progress / ended / next / zap / error /
 * closed), and takes its commands (close, subtitle, osd, channels).
 * After the media service has failed once, streams start here directly
 * for the rest of the session.
 * Touch: tap = controls; ← Back, ▲ ▼ the channel before / after (live);
 * double-tap left / right = back / forward 10 s, the middle = pause.
 * ===================================================================== */
'use strict';
(() => {
  const N = window.SealNative;
  if (!N || !window.SEAL_UT) return;
  const nativePlay = N.play, nativeCommand = N.playerCommand;
  let cfg = null;          // the last thing player-tv.js asked to play
  let here = false;        // playing here (not in Player.qml)
  let preferHere = false;  // the media service failed this session: start here
  let box = null, video = null, engine = null, progressTimer = 0, hideTimer = 0, nextTimer = 0;

  const send = (type, extra = {}) => window.__nativeEvent('player', JSON.stringify({
    type, pos: video ? Math.round(video.currentTime * 1000) : 0,
    dur: video && isFinite(video.duration) ? Math.round(video.duration * 1000) : 0, ...extra }));
  const clock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

  N.play = json => {
    cfg = JSON.parse(json);
    if (preferHere) { if (here) stopEngine(); else build(); return start(); }
    if (here) close(false);
    nativePlay(json);
  };
  N.playerCommand = json => {
    if (!here) return nativeCommand(json);
    const c = JSON.parse(json);
    if (c.cmd === 'close') close(true);
    else if (c.cmd === 'subtitle') box.querySelector('.up-sub').textContent = c.text || '';
    else if (c.cmd === 'osd') osd(c.text);
    else if (c.cmd === 'channels' && c.channels && c.channels.length > 1) { cfg.canZap = true; showZap(); }
  };

  // Player.qml couldn't play it: here instead
  window.SealEvents.on('player', ev => {
    if (!ev || ev.type !== 'fallback' || !cfg) return;
    preferHere = true;
    if (!cfg.live && ev.pos > 0) cfg.start = ev.pos;
    build();
    start();
  });

  function build() {
    if (box) { box.classList.remove('hidden'); return; }
    box = document.createElement('div');
    box.id = 'utPlayer';
    box.innerHTML = `<video playsinline></video>
      <div class="up-osd hidden"></div>
      <div class="up-ctl">
        <div class="up-top"><button class="up-btn" data-a="back" aria-label="Back">←</button>
          <div class="up-words"><div class="up-title"></div><div class="up-sub"></div></div>
          <button class="up-btn zap" data-a="prev" aria-label="Previous channel">▲</button><button class="up-btn zap" data-a="next" aria-label="Next channel">▼</button></div>
        <div class="up-bottom"><button class="up-btn vod" data-a="back10">−10</button><button class="up-btn big" data-a="play">❚❚</button><button class="up-btn vod" data-a="fwd10">+10</button>
          <div class="up-bar vod"><span class="up-now">0:00</span><input type="range" min="0" max="1000" value="0" class="up-seek"><span class="up-all">0:00</span></div>
          <div class="up-live">LIVE</div></div>
      </div>
      <div class="up-msg hidden"><p></p><button class="btn primary" data-a="close">Close</button></div>`;
    document.body.appendChild(box);
    video = box.querySelector('video');
    box.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (!a) return tap(e);
      e.stopPropagation();
      ({ back: () => close(true), close: () => close(true), prev: () => zap(-1), next: () => zap(1),
        back10: () => skip(-10), fwd10: () => skip(10), play: () => (video.paused ? video.play() : video.pause()) })[a.dataset.a]();
      controls(true);
    });
    const seek = box.querySelector('.up-seek');
    seek.addEventListener('input', () => { clearTimeout(hideTimer); });
    seek.addEventListener('change', () => { if (isFinite(video.duration)) video.currentTime = seek.value / 1000 * video.duration; controls(true); });
    video.addEventListener('timeupdate', () => {
      if (!isFinite(video.duration)) return;
      box.querySelector('.up-now').textContent = clock(video.currentTime);
      box.querySelector('.up-all').textContent = clock(video.duration);
      if (document.activeElement !== seek) seek.value = Math.round(video.currentTime / video.duration * 1000);
    });
    video.addEventListener('play', () => { box.querySelector('[data-a=play]').textContent = '❚❚'; controls(true); });
    video.addEventListener('pause', () => { box.querySelector('[data-a=play]').textContent = '▶'; controls(true, true); });
    video.addEventListener('ended', ended);
    video.addEventListener('error', () => failed(video.error ? 'error ' + video.error.code : ''));
  }

  function start() {
    here = true;
    box.classList.remove('hidden');
    box.classList.toggle('live', !!cfg.live);
    box.querySelector('.up-title').textContent = cfg.title || '';
    box.querySelector('.up-sub').textContent = cfg.subtitle || '';
    box.querySelector('.up-msg').classList.add('hidden');
    showZap();
    const url = N.streamUrl(cfg.url, cfg.ua || '');
    const src = String(cfg.url).split('?')[0].toLowerCase();
    stopEngine();
    if (/\.m3u8$/.test(src) && window.Hls && Hls.isSupported()) {
      engine = new Hls({ startPosition: cfg.start ? cfg.start / 1000 : -1 });
      engine.loadSource(url);
      engine.attachMedia(video);
      engine.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) failed(d.details); });
    } else if (/\.ts$/.test(src) && window.mpegts && mpegts.isSupported()) {
      engine = mpegts.createPlayer({ type: 'mpegts', isLive: !!cfg.live, url }, { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: true });
      engine.attachMediaElement(video);
      engine.load();
      engine.on(mpegts.Events.ERROR, (t, d) => failed(d || t));
    } else {
      video.src = url;
      if (cfg.start > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = cfg.start / 1000; }, { once: true });
    }
    video.play().catch(() => { /* the media's own error says why */ });
    clearInterval(progressTimer);
    progressTimer = setInterval(() => { if (!video.paused) send('progress'); }, 5000);
    controls(true);
  }

  function stopEngine() {
    if (engine) { try { engine.destroy(); } catch { /* gone */ } engine = null; }
    if (video) { video.removeAttribute('src'); video.load(); }
  }

  function close(tell) {
    if (!here) return;
    here = false;
    if (tell) send('closed');
    clearInterval(progressTimer); clearTimeout(nextTimer);
    stopEngine();
    box.classList.add('hidden');
  }

  function ended() {
    send('ended');
    if (!cfg.next) return;   // player-tv.js closes us
    let left = 10;
    const msg = box.querySelector('.up-msg');
    const tick = () => {
      if (!here) return;
      if (left <= 0) { msg.classList.add('hidden'); return send('next'); }
      msg.querySelector('p').textContent = `Next episode in ${left--} s — ${cfg.next}`;
      nextTimer = setTimeout(tick, 1000);
    };
    msg.querySelector('button').textContent = 'Play now';
    msg.querySelector('button').dataset.a = 'next';
    msg.classList.remove('hidden');
    msg.querySelector('button').onclick = e => { e.stopPropagation(); clearTimeout(nextTimer); msg.classList.add('hidden'); send('next'); };
    tick();
  }

  function failed(why) {
    if (!here) return;
    const msg = box.querySelector('.up-msg');
    msg.querySelector('p').textContent = `This can't be played here${why ? ` (${why})` : ''}. It may be offline, or the VPN may be off.`;
    const b = msg.querySelector('button');
    b.textContent = 'Close'; b.dataset.a = 'close'; b.onclick = null;
    msg.classList.remove('hidden');
    send('error', { message: String(why || '') });
  }

  function zap(dir) { osd(dir < 0 ? '▲  Previous channel' : '▼  Next channel'); send('zap', { dir }); }
  function skip(s) {
    if (cfg.live || !isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + s));
    osd(`${s < 0 ? '⏪  −10 s' : '⏩  +10 s'}   ${clock(video.currentTime)}`);
  }
  function showZap() { box.querySelectorAll('.zap').forEach(b => b.classList.toggle('hidden', !(cfg.live && cfg.canZap))); }

  function osd(t) {
    const o = box.querySelector('.up-osd');
    o.textContent = t;
    o.classList.remove('hidden');
    clearTimeout(o._t);
    o._t = setTimeout(() => o.classList.add('hidden'), 1600);
  }

  function controls(on, stay) {
    box.classList.toggle('show', on);
    clearTimeout(hideTimer);
    if (on && !stay) hideTimer = setTimeout(() => { if (!video.paused) box.classList.remove('show'); }, 4000);
  }

  // tap: controls; double-tap: skip / pause
  let lastTap = 0, single = 0;
  function tap(e) {
    const now = Date.now(), f = e.clientX / innerWidth;
    if (now - lastTap < 300) {
      clearTimeout(single);
      lastTap = 0;
      if ((f > 0.35 && f < 0.65) || cfg.live) { if (video.paused) video.play(); else video.pause(); osd(video.paused ? '❚❚  Paused' : '▶  Playing'); }
      else skip(f < 0.5 ? -10 : 10);
      return;
    }
    lastTap = now;
    single = setTimeout(() => controls(!box.classList.contains('show')), 300);
  }

  // Back (phone.js): close the player first
  const back = window.__tvBack;
  window.__tvBack = () => { if (here) { close(true); return true; } return back ? back() : false; };
})();
