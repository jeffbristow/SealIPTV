/* =====================================================================
 * Seal IPTV for Fire TV — player-tv.js
 * ---------------------------------------------------------------------
 * The same Player.play(req, opts) / close() / isOpen() as player.js on
 * Windows, but the video plays in Android's own player (ExoPlayer, in
 * PlayerActivity.java): hardware HEVC, AC-3 / E-AC-3 sound, MKV, TS.
 *
 * Android tells us (window.__nativeEvent 'player'):
 *   progress { pos, dur }       every few seconds -> resume point, auto "watched"
 *   ended                       -> watched; Android shows the next-episode countdown
 *   next                        -> play the next episode
 *   zap { dir }                 ↑ / ↓ (or CH+ / CH−) on a live channel
 *   avsync { ms }               changed in the player's ☰ menu -> saved for this audio device
 *   external { pos }            "Open in another app" chosen in the player
 *   error { message }           the stream didn't play
 *   closed { pos, dur }         Back / Home
 * and for the channel guide (OK / ← on a live channel):
 *   guide                       opened -> the whole category is loaded and sent (cmd 'channels')
 *   epgNeed { ids }             rows in view -> what's on now / next (cmd 'epg')
 *   tune { index }              a channel chosen in the guide
 *   number { num }              a channel number typed on the remote
 *   last                        0 / ⟲: the channel watched before
 * ===================================================================== */
'use strict';

const Player = (() => {
  const N = window.SealNative;
  let cur = null;
  const SAVE_EVERY = 10000;
  let sentList = null;          // the channel list Android has (sent again only when it's another one)
  const onAir = new Map();       // channel id -> { at, now, next } (what's on, for the guide)
  const prevOf = c => ({ req: c.req, opts: { ...c.opts, prev: null } });   // one step back only
  const brief = ch => ch.map(it => ({ id: String(it.id), name: it.name, num: it.num ? String(it.num) : '' }));

  const metaOf = r => r.kind === 'episode'
    ? { name: r.name, image: r.image, seriesId: r.seriesId, seriesName: r.seriesName, season: r.season, episode: r.episode, ext: r.ext }
    : { name: r.name, image: r.image, ext: r.ext };

  function nextEpisode(c = cur) {
    const q = c && c.opts.queue;
    if (!q || c.req.kind !== 'episode') return null;
    const i = q.findIndex(x => x.id === c.req.id);
    return i >= 0 ? q[i + 1] || null : null;
  }

  async function play(req, opts = {}) {
    let prep;
    try {
      prep = await call('play:prepare', { kind: req.kind, id: req.id, ext: req.ext, seriesId: req.seriesId });
    } catch (e) {
      if (e.code === 'LOCKED') { if (await askPin(e.locked)) return play(req, opts); return; }
      if (cur) close();
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
          if (r === null) return;
          start = r === 'extra' ? 0 : prep.resume.pos;
        }
      }
    }
    await AvSync.refreshDevice();
    // the channel watched before, for 0 / ⟲ (only when it's another channel)
    if (req.kind === 'live' && cur && cur.live && cur.req.id !== req.id && opts.prev === undefined) opts.prev = prevOf(cur);
    if (req.kind === 'live' && opts.prev === undefined && cur && cur.live) opts.prev = cur.opts.prev;
    const c = { req, opts, prep, key: prep.key, meta: metaOf(req), live: prep.live, marked: false, lastSave: 0, pos: start, dur: 0 };
    cur = c;
    const nx = nextEpisode(c);
    const ch = prep.live && opts.channels && opts.channels.length > 1 ? opts.channels : null;
    const title = req.kind === 'episode' ? (req.seriesName || req.name) : req.name;
    const sub = req.kind === 'episode' ? `${epLabel(req.season, req.episode)} · ${req.name}` : req.kind === 'live' ? (req.cat || '') : '';
    N.play(JSON.stringify({
      url: prep.url, ua: prep.ua, live: prep.live, start: Math.floor(start * 1000), title, subtitle: sub,
      avsync: AvSync.get(), device: AvSync.device(),
      canZap: !!(opts.channels && opts.channels.length > 1),
      next: nx && state.settings.playback.autoNext ? `${epLabel(nx.season, nx.episode)} · ${nx.name}` : '',
      hasNext: !!nx, guide: prep.live,
      ...(ch ? { index: opts.index, ...(ch !== sentList ? { channels: brief(ch) } : {}) } : { channels: [] })
    }));
    sentList = ch;
    if (req.kind === 'live') guide(c);
  }

  async function guide(c) {
    try {
      const epg = await call('epg:short', c.req.id);
      const now = Date.now();
      const on = epg.find(e => e.start <= now && now < e.end) || epg[0];
      if (cur === c && on) N.playerCommand(JSON.stringify({ cmd: 'subtitle', text: `${c.req.cat ? c.req.cat + ' · ' : ''}Now: ${on.title}${on.end ? ` (until ${fmtClock(on.end)})` : ''}` }));
    } catch { /* no guide */ }
  }

  function saveProgress(c, force) {
    if (!c || c.live || c.marked || !c.pos) return;
    if (!force && Date.now() - c.lastSave < SAVE_EVERY) return;
    c.lastSave = Date.now();
    call('lib:progress', c.key, c.pos, c.dur, c.meta).catch(() => {});
  }

  function markWatched(c) {
    if (!c || c.marked) return;
    c.marked = true;
    call('lib:watched', c.key, true, c.meta).catch(() => {});
  }

  function finish(c) {
    if (cur === c) cur = null;
    call('play:stopped').catch(() => {});
    if (['home', 'movie', 'show', 'favorites'].includes(state.view)) render();
  }

  window.SealEvents.on('player', async ev => {
    const c = cur;
    if (!c || !ev) return;
    if (ev.pos != null) c.pos = ev.pos / 1000;
    if (ev.dur > 0) c.dur = ev.dur / 1000;
    const pb = state.settings.playback;
    switch (ev.type) {
      case 'progress':
        if (!c.live && pb.autoWatched && c.dur > 60 && (c.pos / c.dur) * 100 >= pb.watchedPercent) markWatched(c);
        saveProgress(c);
        break;
      case 'ended':
        if (pb.autoWatched) markWatched(c);
        if (!nextEpisode(c) || !pb.autoNext) { N.playerCommand(JSON.stringify({ cmd: 'close' })); }
        break;
      case 'next': {
        const nx = nextEpisode(c);
        saveProgress(c, true);
        if (nx) play(nx, { queue: c.opts.queue, start: 0 });
        break;
      }
      case 'zap': {
        const ch = c.opts.channels;
        if (!ch) break;
        const i = c.opts.index + (ev.dir > 0 ? 1 : -1);
        if (i < 0 || i >= ch.length) break;
        const it = ch[i];
        play({ kind: 'live', id: it.id, name: it.name, image: it.logo, cat: it.catName }, { ...c.opts, channels: ch, index: i, prev: prevOf(c) });
        break;
      }
      case 'guide':        // the guide opened: the whole category (Live TV only had the first pages)
        fullList(c).catch(() => {});
        break;
      case 'epgNeed':
        sendOnAir(c, (ev.ids || []).map(String)).catch(() => {});
        break;
      case 'tune':
        tuneTo(c, ev.index);
        break;
      case 'number': {
        await fullList(c).catch(() => {});
        const i = (c.opts.channels || []).findIndex(it => String(it.num) === String(ev.num));
        if (i >= 0) tuneTo(c, i);
        else N.playerCommand(JSON.stringify({ cmd: 'osd', text: `No channel ${ev.num} here` }));
        break;
      }
      case 'last': {
        const p = c.opts.prev;
        if (!p) { N.playerCommand(JSON.stringify({ cmd: 'osd', text: 'No channel before this one yet' })); break; }
        play(p.req, { ...p.opts, prev: prevOf(c) });
        break;
      }
      case 'avsync':
        AvSync.set(ev.ms);
        toast(`Audio sync for ${AvSync.device() || 'this sound output'}: ${ev.ms > 0 ? '+' : ''}${ev.ms} ms`);
        break;
      case 'external': {
        saveProgress(c, true);
        const r = c.req;
        finish(c);
        openExternal({ kind: r.kind, id: r.id, ext: r.ext, seriesId: r.seriesId, title: r.kind === 'episode' ? `${r.seriesName} ${epLabel(r.season, r.episode)}` : r.name, start: c.pos });
        break;
      }
      case 'error': {
        const v = await call('vpn:check').catch(() => null);
        if (v && v.required && !v.ok) { N.playerCommand(JSON.stringify({ cmd: 'close' })); finish(c); onVpnStatus(v); return vpnBlocked(v); }
        break;   // Android shows the message with "Open in another app"
      }
      case 'closed':
        saveProgress(c, true);
        finish(c);
        break;
    }
  });

  /* changes in Settings / the sync test reach a running player */
  AvSync.onChange(ms => { if (cur) N.playerCommand(JSON.stringify({ cmd: 'avsync', ms })); });
  window.SealEvents.on('audio', () => AvSync.refreshDevice({ announce: true }));

  function tuneTo(c, i) {
    const ch = c.opts.channels;
    const it = ch && ch[i];
    if (!it || String(it.id) === String(c.req.id)) return;
    play({ kind: 'live', id: it.id, name: it.name, image: it.logo, cat: it.catName }, { ...c.opts, channels: ch, index: i, prev: prevOf(c) });
  }

  /** The whole category the channel was chosen in (Live TV loads it page by page), sent to the guide once. */
  async function fullList(c) {
    if (c.opts.full) return;
    if (!c.opts.list) {
      if (c.opts.channels && c.opts.channels.length > 1) return;   // a shelf / my category: its channels are the list
      const it = await call('catalog:item', 'live', c.req.id).catch(() => null);   // on its own: the channel's category
      c.opts.list = { cat: (it && it.cat) || '', q: '' };
    }
    const r = await call('catalog:list', { section: 'live', cat: c.opts.list.cat, q: c.opts.list.q, offset: 0, limit: 20000 });
    if (cur !== c || !r.items || !r.items.length) return;
    c.opts.channels = r.items;
    c.opts.full = true;
    c.opts.index = Math.max(0, r.items.findIndex(it => String(it.id) === String(c.req.id)));
    sentList = r.items;
    N.playerCommand(JSON.stringify({ cmd: 'channels', channels: brief(r.items), index: c.opts.index }));
  }

  /** What's on now and next for the guide's rows (asked of the provider, kept 10 minutes). */
  async function sendOnAir(c, ids) {
    const items = [];
    const flush = () => { if (items.length && cur === c) N.playerCommand(JSON.stringify({ cmd: 'epg', items: items.splice(0) })); };
    for (const id of ids) {
      let x = onAir.get(id);
      if (!x || Date.now() - x.at > 600000) {
        let epg = [];
        try { epg = await call('epg:short', id); } catch { /* no guide */ }
        if (cur !== c) return;
        const t = Date.now();
        const i = epg.findIndex(e => e.start <= t && t < e.end);
        const on = i >= 0 ? epg[i] : null, nx = i >= 0 ? epg[i + 1] : epg.find(e => e.start > t);
        x = { at: Date.now(), now: on ? `Now: ${on.title}${on.end ? ` · until ${fmtClock(on.end)}` : ''}` : '', next: nx ? `${fmtClock(nx.start)} ${nx.title}` : '' };
        onAir.set(id, x);
      }
      items.push({ id, now: x.now, next: x.next });
      if (items.length >= 4) flush();
    }
    flush();
  }

  function close() {
    if (!cur) return;
    N.playerCommand(JSON.stringify({ cmd: 'close' }));
  }

  return { play, close, isOpen: () => !!cur };
})();
