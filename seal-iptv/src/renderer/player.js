/* =====================================================================
 * Seal IPTV — player.js   (full-window player)
 * ---------------------------------------------------------------------
 * Player.play(req, opts)
 *   req:  { kind: live|movie|episode, id, name, image, ext,
 *           seriesId, seriesName, season, episode }
 *   opts: { start: seconds (skips the resume question),
 *           channels: [...], index   — live: channel up / down
 *           queue: [req, ...]        — series: next episode }
 *
 * Engines, chosen by the address and tried in turn until one plays:
 *   hls.js   .m3u8 (HLS)            mpegts.js  .ts / live without extension
 *   native   .mp4 / .mkv / .webm (Chromium's own decoder)
 *
 * Sections:
 *   1. Elements + state
 *   2. Starting (VPN refusal, resume question)
 *   3. Engines + fallback
 *   4. Progress, watched, next episode
 *   5. Controls + keyboard
 *   6. Stopping
 * ===================================================================== */
'use strict';

const Player = (() => {
  /* =================================================================
   * 1. ELEMENTS + STATE
   * ================================================================= */
  const root = $('#player');
  const video = $('#video');
  const SAVE_EVERY = 10000;
  let cur = null;          // what's playing (see play())
  let idleTimer = null;
  let dragging = false;
  let nextTimer = null;

  try { const v = Number(localStorage.getItem('sealiptv.volume')); if (v >= 0 && v <= 1) video.volume = v; } catch { /* default volume */ }
  AvSync.bind(video, $('#pCanvas'), $('#pSubsBox'));

  const metaOf = r => r.kind === 'episode'
    ? { name: r.name, image: r.image, seriesId: r.seriesId, seriesName: r.seriesName, season: r.season, episode: r.episode, ext: r.ext }
    : { name: r.name, image: r.image, ext: r.ext };

  /* =================================================================
   * 2. STARTING
   * ================================================================= */
  async function play(req, opts = {}) {
    if (cur) await stop({ keepOpen: true });
    let prep;
    try {
      prep = await call('play:prepare', { kind: req.kind, id: req.id, ext: req.ext, seriesId: req.seriesId });
    } catch (e) {
      if (e.code === 'LOCKED') {
        if (!root.classList.contains('hidden')) close();
        if (await askPin(e.locked)) return play(req, opts);
        return;
      }
      if (root.classList.contains('hidden')) return fail(e);
      close();
      return fail(e);
    }
    let start = 0;
    if (!prep.live) {
      if (opts.start != null) start = opts.start;
      else if (prep.resume && prep.resume.pos > 0) {
        const mode = state.settings.playback.resume;
        if (mode === 'always') start = prep.resume.pos;
        else if (mode === 'ask') {
          const r = await dialog({
            title: 'Pick up where you left off?',
            html: `<p>You stopped <b>${esc(req.kind === 'episode' ? `${req.seriesName} · ${epLabel(req.season, req.episode)}` : req.name)}</b> at ${fmtTime(prep.resume.pos)}${prep.resume.dur ? ` of ${fmtTime(prep.resume.dur)}` : ''}.</p>`,
            okText: `Resume from ${fmtTime(prep.resume.pos)}`, extraText: 'Start over'
          });
          if (r === null) { if (!root.classList.contains('hidden') && !cur) close(); return; }
          start = r === 'extra' ? 0 : prep.resume.pos;
        }
      }
    }
    cur = {
      req, opts, prep, key: prep.key, meta: metaOf(req), live: prep.live,
      start, started: false, marked: false, lastSave: 0, engines: [], hls: null, mts: null, retries: 0, attempts: []
    };
    openUi();
    attach();
  }

  function openUi() {
    const r = cur.req;
    show(root, true);
    $('#pTitle').textContent = r.kind === 'episode' ? (r.seriesName || r.name) : r.name;
    $('#pSub').textContent = r.kind === 'episode' ? `${epLabel(r.season, r.episode)} · ${r.name}` : r.kind === 'live' ? (r.cat || '') : '';
    show($('#pLive'), cur.live);
    for (const id of ['#pSeek', '#pBack10', '#pFwd30']) show($(id), !cur.live);
    show($('#pPrevCh'), cur.live && !!cur.opts.channels);
    show($('#pNextCh'), cur.live && !!cur.opts.channels);
    show($('#pNextEp'), !!nextEpisode());
    show($('#pAudio'), false); show($('#pSubs'), false);
    hideMsg(); hideNext();
    $('#pTime').textContent = cur.live ? '' : '0:00';
    $('#pSeek').value = 0;
    AvSync.refreshDevice();
    poke();
    if (cur.live) liveGuide(cur);
  }

  async function liveGuide(c) {
    try {
      const epg = await call('epg:short', c.req.id);
      const now = Date.now();
      const on = epg.find(e => e.start <= now && now < e.end) || epg[0];
      if (cur === c && on) $('#pSub').textContent = `${c.req.cat ? c.req.cat + ' · ' : ''}Now: ${on.title}${on.end ? ` (until ${fmtClock(on.end)})` : ''}`;
    } catch { /* no guide */ }
  }

  /* =================================================================
   * 3. ENGINES + FALLBACK
   * ================================================================= */
  function engineOrder(url, live) {
    const u = url.split('?')[0].toLowerCase();
    const has = { hls: !!(window.Hls && Hls.isSupported()), mpegts: !!(window.mpegts && mpegts.getFeatureList().mseLivePlayback) };
    let order;
    if (/\.m3u8$/.test(u)) order = ['hls', 'native', 'mpegts'];
    else if (/\.ts$/.test(u)) order = ['mpegts', 'hls', 'native'];
    else if (/\.(mp4|mkv|webm|m4v|mov)$/.test(u)) order = ['native'];
    else order = live ? ['mpegts', 'hls', 'native'] : ['native', 'hls', 'mpegts'];
    return order.filter(e => e === 'native' || has[e]);
  }

  function attach() {
    cur.engines = engineOrder(cur.prep.url, cur.live);
    tryNext();
  }

  /** Start the next engine; when none is left, show the error. */
  function tryNext(lastError) {
    const c = cur;
    if (!c) return;
    if (c.engine && lastError) c.attempts.push(`${c.engine}: ${lastError}`);
    destroyEngine();
    const engine = c.engines.shift();
    if (!engine) return failPlay(lastError);
    c.engine = engine;
    const url = c.prep.url;
    if (engine === 'hls') {
      const hls = new Hls({ enableWorker: true, startPosition: c.start > 0 ? c.start : -1, maxBufferLength: 40, backBufferLength: 60, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4 });
      c.hls = hls;
      let netRetries = 0, mediaRetries = 0;
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (cur !== c || !d.fatal) return;
        if (!c.started) return tryNext(describeHls(d));
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 3) return setTimeout(() => cur === c && hls.startLoad(), 1500);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 2) { if (mediaRetries === 2) hls.swapAudioCodec(); return hls.recoverMediaError(); }
        failPlay(describeHls(d));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (cur === c) tracks(); });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { if (cur === c) tracks(); });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (cur === c) tracks(); });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (engine === 'mpegts') {
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: c.live, url }, {
        enableWorker: false, enableStashBuffer: !c.live, lazyLoad: !c.live, autoCleanupSourceBuffer: true,
        liveBufferLatencyChasing: c.live, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5
      });
      c.mts = p;
      p.on(mpegts.Events.ERROR, (type, detail, info) => {
        if (cur !== c) return;
        const why = `${type}${detail ? ' / ' + detail : ''}${info && info.msg ? ': ' + info.msg : ''}`;
        if (!c.started) return tryNext(why);
        if (c.live && c.retries++ < 3) return setTimeout(() => { if (cur === c) { c.engines.unshift('mpegts'); tryNext(why); } }, 2000);
        failPlay(why);
      });
      p.attachMediaElement(video);
      p.load();
    } else {
      video.src = url;
    }
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* autoplay errors show through 'error' */ });
  }

  const describeHls = d => {
    const what = [d.type, d.details].filter(Boolean).join(' / ');
    if (d.response && d.response.code) return `${what} (the server answered ${d.response.code}${d.response.text ? ' ' + d.response.text : ''})`;
    return (what || 'unknown error') + (d.reason ? `: ${d.reason}` : d.error && d.error.message ? `: ${d.error.message}` : '');
  };

  video.addEventListener('loadedmetadata', () => {
    if (!cur) return;
    if (cur.engine !== 'hls' && cur.start > 0 && !cur.live && Number.isFinite(video.duration)) { try { video.currentTime = Math.min(cur.start, video.duration - 5); } catch { /* not seekable */ } }
  });
  video.addEventListener('playing', () => { if (cur && !cur.started) { cur.started = true; hideMsg(); } $('#pPlay').textContent = '⏸'; });
  video.addEventListener('pause', () => { $('#pPlay').textContent = '▶'; saveProgress(true); poke(); });
  video.addEventListener('error', () => {
    if (!cur || cur.engine !== 'native') return;
    const e = video.error;
    const why = (e ? ({ 1: 'stopped', 2: 'network error', 3: 'the video couldn\'t be decoded', 4: 'this format isn\'t supported' }[e.code] || 'error ' + e.code) : 'error') + (e && e.message ? ` (${e.message})` : '');
    if (!cur.started) return tryNext(why);
    failPlay(why);
  });
  video.addEventListener('waiting', () => { if (cur && cur.started) poke(); });

  async function failPlay(why) {
    const c = cur;
    if (!c) return;
    // a stream that stops may mean the VPN dropped (the guard cancels everything then)
    const v = await call('vpn:check').catch(() => null);
    if (cur !== c) return;
    if (v && v.required && !v.ok) { close('vpn'); onVpnStatus(v); return vpnBlocked(v); }
    if (c.engine && why && !c.attempts.some(a => a.startsWith(c.engine + ':'))) c.attempts.push(`${c.engine}: ${why}`);
    const net = await call('play:netlog').catch(() => []);
    const details = [
      `Seal IPTV ${state.version} · ${c.req.kind} "${c.req.name}" · ${new Date().toISOString()}`,
      `Address: ${c.prep.shown}`,
      `User-Agent: ${c.prep.ua}`,
      'Tried:', ...c.attempts.map(a => '  ' + a),
      'Provider answered:', ...(net.length ? net.map(n => `  ${n.method} ${n.kind} ${n.url} -> ${n.error || n.status}${n.type ? ' ' + n.type : ''}${n.location ? ' -> ' + n.location : ''}`) : ['  (nothing — no request reached the network)'])
    ].join('\n');
    console.log('Playback failed\n' + details);
    destroyEngine();
    showMsg(`<div class="box"><h3>This ${c.live ? 'channel' : c.req.kind === 'episode' ? 'episode' : 'movie'} can't be played here</h3>
      <p class="muted small">${esc(why || 'The stream didn\'t start.')}</p>
      <p class="small">It may be offline, or use a format the built-in player can't play. VLC usually can.</p>
      <div class="row gap" style="justify-content:center;margin-top:12px"><button class="btn" id="pmRetry">Try again</button><button class="btn primary" id="pmVlc">Open in VLC</button><button class="btn ghost" id="pmClose">Close</button></div>
      <details class="p-details"><summary class="small muted">Details</summary><pre class="selectable">${esc(details)}</pre><button class="btn small" id="pmCopy">Copy details</button></details></div>`);
    $('#pmCopy').onclick = () => navigator.clipboard.writeText(details).then(() => toast('Details copied. Your username and password are hidden in them.')).catch(() => toast('Couldn\'t copy — select the text instead.', 'err'));
    $('#pmRetry').onclick = () => { hideMsg(); c.start = video.currentTime || c.start; c.started = false; attach(); };
    $('#pmVlc').onclick = () => { openVlc(); };
    $('#pmClose').onclick = () => close();
  }

  function destroyEngine() {
    if (cur && cur.hls) { try { cur.hls.destroy(); } catch { /* gone */ } cur.hls = null; }
    if (cur && cur.mts) { try { cur.mts.destroy(); } catch { /* gone */ } cur.mts = null; }
    video.removeAttribute('src');
    try { video.load(); } catch { /* nothing loaded */ }
  }

  /** Audio + subtitle menus (HLS only: that's where the tracks are known). */
  function tracks() {
    const hls = cur && cur.hls;
    const a = $('#pAudio'), s = $('#pSubs');
    if (!hls) return;
    const at = hls.audioTracks || [];
    show(a, at.length > 1);
    a.innerHTML = at.map((t, i) => `<option value="${i}">🔈 ${esc(t.name || t.lang || 'Track ' + (i + 1))}</option>`).join('');
    a.value = String(hls.audioTrack);
    a.onchange = () => { hls.audioTrack = Number(a.value); };
    const st = hls.subtitleTracks || [];
    show(s, st.length > 0);
    s.innerHTML = '<option value="-1">Subtitles off</option>' + st.map((t, i) => `<option value="${i}">${esc(t.name || t.lang || 'Subtitles ' + (i + 1))}</option>`).join('');
    s.value = String(hls.subtitleTrack);
    s.onchange = () => { hls.subtitleTrack = Number(s.value); hls.subtitleDisplay = Number(s.value) >= 0; };
  }

  /* =================================================================
   * 4. PROGRESS, WATCHED, NEXT EPISODE
   * ================================================================= */
  video.addEventListener('timeupdate', () => {
    if (!cur || cur.live) return;
    const pos = video.currentTime, dur = video.duration;
    if (!dragging && Number.isFinite(dur) && dur > 0) $('#pSeek').value = Math.round((pos / dur) * 1000);
    $('#pTime').textContent = Number.isFinite(dur) ? `${fmtTime(pos)} / ${fmtTime(dur)}` : fmtTime(pos);
    const pb = state.settings.playback;
    if (pb.autoWatched && !cur.marked && Number.isFinite(dur) && dur > 60 && (pos / dur) * 100 >= pb.watchedPercent) markWatched();
    if (Date.now() - cur.lastSave > SAVE_EVERY) saveProgress();
  });

  function saveProgress(force) {
    const c = cur;
    if (!c || c.live || c.marked || !c.started) return;
    if (!force && Date.now() - c.lastSave < SAVE_EVERY) return;
    c.lastSave = Date.now();
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    call('lib:progress', c.key, video.currentTime, dur, c.meta).catch(() => {});
  }

  function markWatched() {
    const c = cur;
    if (!c || c.marked) return;
    c.marked = true;
    call('lib:watched', c.key, true, c.meta).then(() => toast(`Marked "${c.req.kind === 'episode' ? `${c.req.seriesName} ${epLabel(c.req.season, c.req.episode)}` : c.req.name}" as watched.`)).catch(() => {});
  }

  function nextEpisode() {
    const q = cur && cur.opts.queue;
    if (!q || cur.req.kind !== 'episode') return null;
    const i = q.findIndex(x => x.id === cur.req.id);
    return i >= 0 ? q[i + 1] || null : null;
  }

  video.addEventListener('ended', () => {
    if (!cur || cur.live) return;
    if (state.settings.playback.autoWatched) markWatched();
    const nx = nextEpisode();
    if (nx && state.settings.playback.autoNext) return countdown(nx);
    close();
  });

  function countdown(nx) {
    let n = 10;
    const box = $('#pNext');
    const draw = () => {
      box.innerHTML = `<div class="small muted">Next episode in ${n}s</div><div style="font-weight:600;margin:4px 0 10px">${esc(epLabel(nx.season, nx.episode))} · ${esc(nx.name)}</div>
        <div class="row gap"><button class="btn primary small" id="pnNow">Play now</button><button class="btn small" id="pnStop">Cancel</button></div>`;
      $('#pnNow').onclick = () => { hideNext(); play(nx, { queue: cur.opts.queue, start: 0 }); };
      $('#pnStop').onclick = () => { hideNext(); close(); };
    };
    show(box, true);
    draw();
    nextTimer = setInterval(() => { if (--n <= 0) { hideNext(); play(nx, { queue: cur.opts.queue, start: 0 }); } else draw(); }, 1000);
  }
  function hideNext() { clearInterval(nextTimer); nextTimer = null; show($('#pNext'), false); }

  function zap(step) {
    const ch = cur && cur.opts.channels;
    if (!ch) return;
    const i = cur.opts.index + step;
    if (i < 0 || i >= ch.length) return;
    const it = ch[i];
    play({ kind: 'live', id: it.id, name: it.name, image: it.logo, cat: it.catName }, { channels: ch, index: i });
  }

  function openVlc() {
    if (!cur) return;
    const r = cur.req;
    const start = cur.live ? 0 : video.currentTime || cur.start || 0;
    const title = r.kind === 'episode' ? `${r.seriesName} ${epLabel(r.season, r.episode)} ${r.name}` : r.name;
    saveProgress(true);
    close();
    openExternal({ kind: r.kind, id: r.id, ext: r.ext, seriesId: r.seriesId, title, start });
  }

  /* =================================================================
   * 5. CONTROLS + KEYBOARD
   * ================================================================= */
  function poke() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (cur && !video.paused && !dragging && $('#pSync').classList.contains('hidden')) root.classList.add('idle'); }, 3000);
  }
  root.addEventListener('mousemove', poke);

  const toggle = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  const seekBy = s => { if (cur && !cur.live && Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + s)); poke(); };
  const fullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen().catch(() => {}); };
  const setVol = v => {
    video.volume = Math.max(0, Math.min(1, v));
    video.muted = video.volume === 0;
    $('#pVol').value = Math.round(video.volume * 100);
    $('#pMute').textContent = video.muted ? '🔇' : '🔊';
    try { localStorage.setItem('sealiptv.volume', String(video.volume)); } catch { /* not kept */ }
  };
  $('#pVol').value = Math.round(video.volume * 100);

  $('#pPlay').onclick = toggle;
  video.onclick = toggle;
  video.ondblclick = fullscreen;
  $('#pBack').onclick = () => close();
  $('#pBack10').onclick = () => seekBy(-10);
  $('#pFwd30').onclick = () => seekBy(30);
  $('#pFull').onclick = fullscreen;
  $('#pVlc').onclick = openVlc;
  $('#pPrevCh').onclick = () => zap(-1);
  $('#pNextCh').onclick = () => zap(1);
  $('#pNextEp').onclick = () => { const nx = nextEpisode(); if (nx) { saveProgress(true); play(nx, { queue: cur.opts.queue, start: 0 }); } };
  $('#pMute').onclick = () => { video.muted = !video.muted; $('#pMute').textContent = video.muted ? '🔇' : '🔊'; };
  $('#pVol').oninput = e => setVol(Number(e.target.value) / 100);
  const seek = $('#pSeek');
  seek.oninput = () => { dragging = true; if (Number.isFinite(video.duration)) $('#pTime').textContent = `${fmtTime((seek.value / 1000) * video.duration)} / ${fmtTime(video.duration)}`; };
  seek.onchange = () => { dragging = false; if (cur && Number.isFinite(video.duration)) video.currentTime = (seek.value / 1000) * video.duration; poke(); };

  /* ---- audio sync (avsync.js) ---- */
  const syncUi = (ms, dev) => {
    $('#psSlider').value = ms;
    $('#psValue').textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    $('#psDesc').textContent = AvSync.describe(ms);
    $('#psDevice').textContent = dev || '';
    $('#pSyncBtn').textContent = ms ? `⏱ ${ms > 0 ? '+' : ''}${ms} ms` : '⏱ Sync';
  };
  AvSync.onChange(syncUi);
  let osdTimer = null;
  const osd = text => { const o = $('#pOsd'); o.textContent = text; show(o, true); clearTimeout(osdTimer); osdTimer = setTimeout(() => show(o, false), 1600); };
  const nudge = step => { const ms = AvSync.nudge(step); osd(`Audio sync ${ms > 0 ? '+' : ''}${ms} ms · ${AvSync.describe(ms)}`); };
  $('#pSyncBtn').onclick = () => { show($('#pSync'), $('#pSync').classList.contains('hidden')); poke(); };
  $('#psSlider').oninput = e => AvSync.set(e.target.value);
  $('#psMinus').onclick = () => nudge(-10);
  $('#psPlus').onclick = () => nudge(10);
  $('#psZero').onclick = () => { AvSync.set(0); osd('Audio sync off'); };
  $('#psTest').onclick = async () => {
    const wasPlaying = !video.paused;
    video.pause();
    show($('#pSync'), false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    await AvSync.test();
    if (cur && wasPlaying) video.play().catch(() => {});
  };

  document.addEventListener('keydown', e => {
    if (root.classList.contains('hidden') || !$('#dlgModal').classList.contains('hidden')) return;
    if (e.key === '[' || e.key === '{') { e.preventDefault(); nudge(e.shiftKey || e.key === '{' ? -50 : -10); poke(); return; }
    if (e.key === ']' || e.key === '}') { e.preventDefault(); nudge(e.shiftKey || e.key === '}' ? 50 : 10); poke(); return; }
    if (/INPUT|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    const k = e.key;
    const handled = {
      ' ': toggle, k: toggle, K: toggle,
      ArrowLeft: () => seekBy(-10), ArrowRight: () => seekBy(30),
      ArrowUp: () => setVol(video.volume + 0.1), ArrowDown: () => setVol(video.volume - 0.1),
      PageUp: () => zap(-1), PageDown: () => zap(1),
      f: fullscreen, F: fullscreen, m: () => $('#pMute').click(), M: () => $('#pMute').click(),
      n: () => $('#pNextEp').click(), N: () => $('#pNextEp').click(),
      Escape: () => { if (document.fullscreenElement) document.exitFullscreen(); else close(); }
    }[k];
    if (handled) { e.preventDefault(); handled(); poke(); }
  });

  /* =================================================================
   * 6. STOPPING
   * ================================================================= */
  async function stop({ keepOpen = false } = {}) {
    hideNext();
    if (!cur) return;
    saveProgress(true);
    destroyEngine();
    AvSync.stop();
    show($('#pSync'), false);
    cur = null;
    call('play:stopped').catch(() => {});
    if (!keepOpen) show(root, false);
  }

  function close(reason) {
    const wasOpen = !root.classList.contains('hidden');
    stop();
    show(root, false);
    hideMsg();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // the page behind shows progress / watched marks: draw it again
    if (wasOpen && reason !== 'vpn' && ['home', 'movie', 'show', 'favorites'].includes(state.view)) render();
  }

  function showMsg(html) { const m = $('#pMsg'); m.innerHTML = html; show(m, true); root.classList.remove('idle'); }
  function hideMsg() { show($('#pMsg'), false); $('#pMsg').innerHTML = ''; }

  window.addEventListener('beforeunload', () => saveProgress(true));

  return { play, close, isOpen: () => !root.classList.contains('hidden') };
})();
