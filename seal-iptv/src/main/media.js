/* =====================================================================
 * Seal IPTV — media.js   (Windows only: downloads and recordings)
 * ---------------------------------------------------------------------
 * Movies / episodes downloaded to watch offline, and live TV recorded —
 * now, or at a time (from the TV Guide, or a channel and a time).
 * Saved in media.json: [{ id, type: download | recording, status … }].
 *
 * STREAMS AT ONCE (Settings → Recordings & downloads, default 1)
 *   Providers allow a number of streams at the same time. Playing,
 *   each recording and the download running each use one. When there
 *   isn't one free:
 *     - playing: the download waits (it goes on after); a recording is
 *       only stopped when the user says so (error STREAMS -> asked)
 *     - recording now: the same (and while something plays, asked)
 *     - a scheduled recording that's due while something plays: the
 *       window is asked (media:conflict); no answer in a minute = it
 *       records (that's what was asked for)
 *     - scheduling: refused when more recordings than that would overlap
 *   Only while Seal IPTV is open; Windows is kept awake meanwhile.
 *
 * Sections:
 *   1. Saved list + files
 *   2. Streams at once
 *   3. Downloads
 *   4. Recordings (now, scheduled)
 *   5. Running a job
 *   6. Playing a saved file
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const capture = require('./capture');

const TICK_MS = 10000;
const ASK_MS = 60000;                 // a scheduled recording waits this long for an answer, then records
const EARLY_MS = 60000;               // recordings from the guide start a minute early …
const LATE_MS = 5 * 60000;            // … and end five minutes late (programmes rarely keep time)
const MAX_REC_MS = 12 * 3600000;
const MIN_FREE = 500 * 1024 * 1024;   // stops when the disk gets this full
const STREAMS_MAX = 10;

const clean = s => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 110) || 'Video';
const two = n => String(n).padStart(2, '0');
const stamp = t => { const d = new Date(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}`; };
const err = (msg, code, extra = {}) => Object.assign(new Error(msg), { code }, extra);

class Media {
  /**
   * @param o.dir       the app's data folder (media.json)
   * @param o.store     Store (settings.media)
   * @param o.catalog   Catalog (stream addresses, the guide)
   * @param o.library   Library (watched / resume points shared with the streamed copy)
   * @param o.vpn       VpnGuard (ensure(), allowed())
   * @param o.fetch     fetch
   * @param o.userAgent () -> User-Agent
   * @param o.videos    the default folder (Windows' Videos\Seal IPTV)
   * @param o.notify    (event, data) -> the window (media:changed, media:conflict, media:note, media:takeover)
   * @param o.awake     { start(), stop() } — Windows kept awake while something is saved
   * @param o.freeSpace async (folder) -> bytes free (null: unknown)
   */
  constructor(o) {
    Object.assign(this, { dir: o.dir, store: o.store, catalog: o.catalog, library: o.library, vpn: o.vpn, fetch: o.fetch, userAgent: o.userAgent, videos: o.videos, notify: o.notify || (() => {}), awake: o.awake || { start() {}, stop() {} }, freeSpace: o.freeSpace || (async () => null) });
    this.askMs = o.askMs || ASK_MS;   // (shorter in tests)
    this.file = path.join(this.dir, 'media.json');
    this.items = [];
    this.jobs = new Map();          // id -> { ctl, kind }
    this.playing = false;           // the built-in player has a stream open (main.js preparePlay / play:stopped)
    this.saveTimer = null;
    this.sentAt = 0;
    this.load();
  }

  /* =================================================================
   * 1. SAVED LIST + FILES
   * ================================================================= */
  load() {
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || []; } catch { this.items = []; }
    // Seal IPTV was closed while these ran
    for (const it of this.items) {
      if (it.type === 'download' && it.status === 'downloading') it.status = 'queued';
      if (it.type === 'recording' && it.status === 'recording') {
        if (it.end > Date.now()) it.status = 'scheduled';
        else this._ended(it, 'Seal IPTV was closed during the recording.');
      }
    }
  }

  save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items.map(({ _ask, ...i }) => i) }));
      fs.renameSync(tmp, this.file);
    };
    if (now) write(); else this.saveTimer = setTimeout(write, 500);
  }

  /** the window draws its pages again (progress: at most once a second) */
  changed(progress = false) {
    this.save();
    if (progress && Date.now() - this.sentAt < 1000) return;
    this.sentAt = Date.now();
    this.notify('media:changed', null);
  }

  settings() { return { streams: 1, folder: '', ...((this.store.getSettings() || {}).media || {}) }; }
  folder() { return this.settings().folder || this.videos; }
  limit() { return Math.max(1, Math.min(STREAMS_MAX, Number(this.settings().streams) || 1)); }

  /** <folder>\<sub>\<name> — with (2), (3) … when that's taken */
  _base(sub, name) {
    const dir = path.join(this.folder(), ...sub.map(clean));
    fs.mkdirSync(dir, { recursive: true });
    const taken = b => { try { return fs.readdirSync(dir).some(f => f.startsWith(path.basename(b) + '.')); } catch { return false; } };
    let b = path.join(dir, clean(name));
    for (let n = 2; taken(b) || this.items.some(i => i.base === b && i.status !== 'failed'); n++) b = path.join(dir, `${clean(name)} (${n})`);
    return b;
  }

  /** for the window: newest first, without the internals */
  list() {
    return this.items.map(({ state, base, _ask, ...i }) => ({ ...i, bytes: (state && state.bytes) || i.bytes || 0, total: (state && state.total) || i.total || 0, done: state && state.done, note: (state && state.note) || '' }))
      .sort((a, b) => (b.added || 0) - (a.added || 0));
  }

  get(id) { return this.items.find(i => i.id === id) || null; }
  _id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /** what's saved of a title (key: movie:9, episode:4) -> { id, status } or null */
  downloadOf(key) {
    const it = this.items.find(i => i.type === 'download' && i.key === key && i.status !== 'failed');
    return it ? { id: it.id, status: it.status, bytes: (it.state && it.state.bytes) || it.bytes || 0, total: (it.state && it.state.total) || it.total || 0 } : null;
  }

  /** Delete: the item, and (deleteFile) its file */
  remove(id, { deleteFile = true } = {}) {
    const it = this.get(id);
    if (!it) return false;
    this._abort(id, 'removed');
    if (deleteFile) for (const f of [it.file, it.state && it.state.part]) if (f) try { fs.unlinkSync(f); } catch { /* gone already */ }
    this.items = this.items.filter(i => i !== it);
    this.changed();
    this.kick();
    return true;
  }

  /* =================================================================
   * 2. STREAMS AT ONCE
   * ================================================================= */
  _running(type) { return [...this.jobs.values()].filter(j => !type || j.type === type).length; }
  used() { return (this.playing ? 1 : 0) + this._running(); }

  /** downloads that may run: the free streams (playing and recordings first), at most one */
  _pauseDownloadsFor(need) {
    for (const [id, j] of this.jobs) {
      if (this.used() + need <= this.limit()) break;
      if (j.type === 'download') { this._abort(id, 'waiting'); const it = this.get(id); if (it) it.status = 'waiting'; }
    }
  }

  /**
   * The player is about to open a stream (main.js preparePlay). A download waits for it;
   * a recording only stops if the user said so (force) — else an error STREAMS to ask.
   */
  beforePlay({ force = false } = {}) {
    if (this.playing) return;   // another channel: the same stream
    if (this.used() + 1 > this.limit()) this._pauseDownloadsFor(1);
    if (this.used() + 1 > this.limit()) {
      const recs = this.items.filter(i => this.jobs.has(i.id) && i.type === 'recording');
      if (!force) {
        const names = recs.map(r => `"${r.title}"`).join(', ');
        const n = this.limit();
        throw err(`${names} ${recs.length === 1 ? 'is' : 'are'} being recorded, and Seal IPTV is set to use ${n} stream${n === 1 ? '' : 's'} at a time. Playing this stops ${recs.length === 1 ? 'the recording' : 'a recording'}.`, 'STREAMS', { vpn: { recordings: recs.map(r => ({ id: r.id, title: r.title })) } });
      }
      // the newest recording is the one stopped
      for (const r of recs.reverse()) { if (this.used() + 1 <= this.limit()) break; this.stop(r.id, { forPlay: true }); }
    }
    this.playing = true;
    this.changed();
  }

  /** VLC: is there a stream free (downloads wait for it)? Nothing is stopped */
  canStream() {
    if (this.used() + 1 > this.limit()) this._pauseDownloadsFor(1);
    if (this.used() + 1 > this.limit()) return false;
    setTimeout(() => this.kick(), 60000);   // the paused download goes on after a while (VLC isn't watched)
    return true;
  }

  afterPlay() {
    if (!this.playing) return;
    this.playing = false;
    this.kick();
    this.changed();
  }

  /* =================================================================
   * 3. DOWNLOADS
   * ================================================================= */
  /**
   * req: what the player would play ({ kind: movie | episode, id, ext, seriesId });
   * meta: { title, image, year, seriesName, season, episode, name }
   */
  addDownload(pid, req, meta = {}) {
    if (!['movie', 'episode'].includes(req.kind)) throw new Error('Only movies and episodes can be downloaded.');
    const key = `${req.kind}:${req.id}`;
    const had = this.items.find(i => i.type === 'download' && i.key === key && i.pid === pid && i.status !== 'failed');
    if (had) return had.id;
    this.items = this.items.filter(i => !(i.type === 'download' && i.key === key && i.pid === pid && i.status === 'failed'));
    const ep = req.kind === 'episode';
    const title = String(meta.title || 'Movie');
    const name = ep ? `${meta.seriesName || 'Series'} - S${two(meta.season || 1)}E${two(meta.episode || 0)}${meta.name && !/^episode \d+$/i.test(meta.name) ? ' - ' + meta.name : ''}`
      : meta.year && !/\(\d{4}\)/.test(title) ? `${title} (${meta.year})` : title;
    const it = {
      id: this._id(), type: 'download', pid, key, req: { kind: req.kind, id: String(req.id), ext: req.ext || '', seriesId: req.seriesId ? String(req.seriesId) : '' },
      title: ep ? meta.seriesName || meta.title || 'Series' : meta.title || 'Movie', sub: ep ? `S${meta.season || 1} · E${meta.episode || '?'}${meta.name ? ' · ' + meta.name : ''}` : meta.year ? String(meta.year) : '',
      image: meta.image || '', meta: { name: meta.name || meta.title || '', seriesId: req.seriesId || '', seriesName: meta.seriesName || '', season: meta.season, episode: meta.episode, image: meta.image || '' },
      status: 'queued', added: Date.now(), base: this._base(ep ? ['Series', meta.seriesName || 'Series'] : ['Movies'], name)
    };
    this.items.push(it);
    this.changed();
    this.kick();
    return it.id;
  }

  pause(id) {
    const it = this.get(id);
    if (!it || it.type !== 'download' || !['queued', 'downloading', 'waiting'].includes(it.status)) return false;
    this._abort(id, 'paused');
    it.status = 'paused';
    this.changed();
    this.kick();
    return true;
  }

  resume(id) {
    const it = this.get(id);
    if (!it || it.type !== 'download' || !['paused', 'failed', 'waiting'].includes(it.status)) return false;
    it.status = 'queued';
    delete it.error;
    this.changed();
    this.kick();
    return true;
  }

  /** start what may start: due recordings first, then one download if a stream is free */
  kick() {
    this.tick();
    if (this._running('download') || this.used() >= this.limit()) return;
    const next = this.items.filter(i => i.type === 'download' && ['waiting', 'queued'].includes(i.status)).sort((a, b) => (a.status === 'waiting' ? -1 : 0) - (b.status === 'waiting' ? -1 : 0) || a.added - b.added)[0];
    if (next) this._run(next);
  }

  /* =================================================================
   * 4. RECORDINGS
   * ================================================================= */
  _overlapping(start, end, except) {
    return this.items.filter(i => i.type === 'recording' && i.id !== except && ['scheduled', 'recording'].includes(i.status) && i.start < end && start < i.end);
  }

  /**
   * A recording at a time. o: { channel: { id, name, logo }, start, end, title, guide: true (a programme: a minute early, five late) }
   * Refused when it would need more streams than allowed (other recordings then).
   */
  schedule(pid, o) {
    const ch = o.channel || {};
    if (!ch.id) throw new Error('Choose the channel to record.');
    let start = Number(o.start), end = Number(o.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('The recording has to end after it starts.');
    if (o.guide) { start -= EARLY_MS; end += LATE_MS; }
    if (end <= Date.now()) throw new Error('That time has passed already.');
    if (end - start > MAX_REC_MS) throw new Error('A recording can be 12 hours at most.');
    const over = this._overlapping(start, end);
    const n = this.limit();
    if (over.length + 1 > n) {
      throw new Error(`Seal IPTV is set to use ${n} stream${n === 1 ? '' : 's'} at a time, and ${over.map(r => `"${r.title}"`).join(', ')} ${over.length === 1 ? 'is' : 'are'} recorded then. Allow more streams in Settings → Recordings & downloads if your provider does.`);
    }
    const it = {
      id: this._id(), type: 'recording', pid, channel: { id: String(ch.id), name: String(ch.name || ''), logo: ch.logo || '' },
      title: String(o.title || ch.name || 'Recording').slice(0, 120), start, end, status: 'scheduled', added: Date.now(), now: !!o.now
    };
    this.items.push(it);
    this.changed();
    this.tick();
    return it.id;
  }

  /**
   * Record a channel from now until o.end. When there isn't a stream for it: a download waits;
   * what plays is only stopped when the window asked (force) — else error STREAMS (playing: true).
   */
  recordNow(pid, o, { force = false } = {}) {
    const end = Number(o.end) || Date.now() + 2 * 3600000;
    if (this.used() + 1 > this.limit()) this._pauseDownloadsFor(1);
    if (this.used() + 1 > this.limit()) {
      const recs = this.items.filter(i => this.jobs.has(i.id) && i.type === 'recording');
      const n = this.limit();
      if (recs.length >= n) throw new Error(`${recs.map(r => `"${r.title}"`).join(', ')} ${recs.length === 1 ? 'is' : 'are'} being recorded, and Seal IPTV is set to use ${n} stream${n === 1 ? '' : 's'} at a time. Stop ${recs.length === 1 ? 'it' : 'one'} first, or allow more streams in Settings → Recordings & downloads.`);
      if (this.playing && !force) throw err(`Seal IPTV is set to use ${n} stream${n === 1 ? '' : 's'} at a time, and one is playing. Recording stops what's playing.`, 'STREAMS', { vpn: { playing: true } });
    }
    const id = this.schedule(pid, { ...o, start: Date.now(), end, now: true });
    return id;
  }

  /** a recording: stopped now (the file kept), or a scheduled one taken off. forPlay: to play something else */
  stop(id, { forPlay = false } = {}) {
    const it = this.get(id);
    if (!it || it.type !== 'recording') return false;
    if (it.status === 'scheduled') { this.items = this.items.filter(i => i !== it); this.changed(); return true; }
    if (it.status !== 'recording') return false;
    it.stopAsked = !forPlay;
    this._abort(id, 'stopped');
    return true;
  }

  /** the window's answer to media:conflict: record (it closed the player) or skip */
  answer(id, record) {
    const it = this.get(id);
    if (!it || it.status !== 'scheduled') return false;
    if (!record) { it.status = 'skipped'; it.error = 'Skipped: something was playing.'; delete it._ask; this.changed(); return true; }
    it._ask = { at: 0, yes: true };
    this.tick();
    return true;
  }

  /** a recording that ended early: what it has is kept (stopped), or nothing (failed) */
  _ended(it, error) {
    const part = it.state && it.state.part;
    let size = 0;
    try { size = part ? fs.statSync(part).size : 0; } catch { size = 0; }
    if (size > 0) {
      const f = part.replace(/\.part$/, '');
      try { fs.renameSync(part, f); it.file = f; } catch { it.file = part; }
      it.status = 'stopped';
      it.bytes = size;
    } else {
      it.status = 'failed';
      if (part) try { fs.unlinkSync(part); } catch { /* none */ }
    }
    it.error = error;
    delete it.state;
  }

  /** every 10 s: recordings that are due start; ones whose time passed are missed */
  tick() {
    const now = Date.now();
    for (const it of this.items) {
      if (it.type !== 'recording' || it.status !== 'scheduled' || it.start > now) continue;
      if (it.end <= now) { it.status = 'missed'; it.error = 'Seal IPTV wasn\'t open then.'; this.changed(); continue; }
      if (this.used() + 1 > this.limit()) this._pauseDownloadsFor(1);
      if (this.used() + 1 > this.limit()) {
        const recs = this._running('recording');
        if (recs >= this.limit() || !this.playing) {
          if (now - it.start > 2 * 60000) { it.status = 'skipped'; it.error = 'Another recording was using the stream.'; this.changed(); }
          continue;
        }
        // something plays: ask once; no answer in a minute = record (the window closes the player)
        if (!it._ask) { it._ask = { at: now }; this.notify('media:conflict', { id: it.id, title: it.title, channel: it.channel.name, streams: this.limit() }); }
        else if (it._ask.yes || now - it._ask.at > this.askMs) { if (!it._ask.told) { it._ask.told = true; this.notify('media:takeover', { id: it.id, title: it.title }); } }
        continue;
      }
      delete it._ask;
      this._run(it);
    }
  }

  start() {
    this.timer = setInterval(() => { try { this.kick(); } catch { /* next time */ } }, TICK_MS);
    if (this.timer.unref) this.timer.unref();
    this.kick();
  }

  /** closing Seal IPTV: what's running stops (recordings keep what they have) */
  shutdown() {
    clearInterval(this.timer);
    for (const id of [...this.jobs.keys()]) this._abort(id, 'quit');
    for (const it of this.items) {
      if (it.type === 'download' && it.status === 'downloading') it.status = 'queued';
    }
    this.save(true);
  }

  /** what would be lost by closing now: { recording: [titles], downloading: n, scheduled: n (next 24 h) } */
  busy() {
    const now = Date.now();
    return {
      recording: this.items.filter(i => i.type === 'recording' && this.jobs.has(i.id)).map(i => i.title),
      downloading: this.items.filter(i => i.type === 'download' && ['downloading', 'queued', 'waiting'].includes(i.status)).length,
      scheduled: this.items.filter(i => i.type === 'recording' && i.status === 'scheduled' && i.start < now + 24 * 3600000).length
    };
  }

  /* =================================================================
   * 5. RUNNING A JOB
   * ================================================================= */
  _abort(id, why) {
    const j = this.jobs.get(id);
    if (!j) return;
    j.why = why;
    j.ctl.abort();
    this.jobs.delete(id);
    this._awake();
  }

  _awake() {
    if (this.jobs.size && !this.awakeOn) { this.awakeOn = true; this.awake.start(); }
    if (!this.jobs.size && this.awakeOn) { this.awakeOn = false; this.awake.stop(); }
  }

  async _run(it) {
    const ctl = new AbortController();
    const job = { ctl, type: it.type, why: '' };
    this.jobs.set(it.id, job);
    this._awake();
    it.status = it.type === 'download' ? 'downloading' : 'recording';
    delete it.error;
    if (it.type === 'recording') {
      it.startedAt = it.startedAt || Date.now();
      if (!it.base) it.base = this._base(['Recordings'], `${it.channel.name} - ${it.title === it.channel.name ? '' : it.title + ' - '}${stamp(Math.max(it.start, Date.now()))}`.replace(/ - - /, ' - '));
      this.notify('media:note', { text: `Recording "${it.title}" on ${it.channel.name}.` });
    }
    this.changed();
    let done = null, error = null;
    try {
      const free = await this.freeSpace(this.folder());
      if (free != null && free < MIN_FREE * 2) throw new Error('There isn\'t enough space left on the disk.');
      await this.vpn.ensure();
      const s = it.type === 'download'
        ? await this.catalog.streamUrl(it.pid, it.req)
        : await this.catalog.streamUrl(it.pid, { kind: 'live', id: it.channel.id }, { record: true });
      const o = {
        fetch: this.fetch, ua: s.ua || this.userAgent(), signal: ctl.signal, allowed: () => this.vpn.allowed(), state: it.state,
        until: it.type === 'recording' ? it.end : 0,
        onProgress: st => {
          it.state = st;
          // every 64 MB: the disk nearly full -> stop (keeping what there is)
          if ((st.bytes || 0) - (job.checked || 0) > 64 * 1024 * 1024) {
            job.checked = st.bytes;
            this.freeSpace(this.folder()).then(f => { if (f != null && f < MIN_FREE && this.jobs.get(it.id) === job) { job.why = 'disk'; ctl.abort(); } }).catch(() => {});
          }
          this.changed(true);
        }
      };
      done = it.type === 'download'
        ? await (capture.isHls(s.url) ? capture.hls(s.url, it.base, o) : capture.file(s.url, it.base, o))
        : await capture.live(s.url, it.base, o);
    } catch (e) { error = e; }
    if (this.jobs.get(it.id) === job) this.jobs.delete(it.id);
    this._awake();
    if (!this.items.includes(it)) return;   // deleted meanwhile
    const why = job.why;
    if (done) {
      Object.assign(it, { status: 'done', file: done.file, bytes: done.bytes, total: done.total, finished: Date.now() });
      delete it.state;
      if (it.type === 'recording' && !done.bytes) { it.status = 'failed'; it.error = 'Nothing came from the channel.'; }
      this.notify('media:note', { text: it.status === 'done' ? `${it.type === 'download' ? 'Downloaded' : 'Recorded'} "${it.title}${it.type === 'download' && it.sub ? ' · ' + it.sub : ''}".` : `Couldn't record "${it.title}": ${it.error}` });
    } else if (it.type === 'download') {
      if (why === 'paused' || why === 'waiting') it.status = why;
      else if (why === 'quit') it.status = 'queued';
      else if (why === 'disk') { it.status = 'paused'; it.error = 'Paused: the disk is nearly full.'; }
      else { it.status = 'failed'; it.error = error ? error.message : 'Stopped.'; this.notify('media:note', { text: `Couldn't download "${it.title}": ${it.error}`, error: true }); }
    } else {
      // a recording stopped early keeps what it has
      const msg = why === 'stopped' ? (it.stopAsked ? 'Stopped early.' : 'Stopped to play something else.') : why === 'quit' ? 'Seal IPTV was closed during the recording.' : why === 'disk' ? 'Stopped: the disk is nearly full.' : error ? error.message : 'Stopped.';
      this._ended(it, msg);
      it.finished = Date.now();
      if (why !== 'quit') this.notify('media:note', { text: it.status === 'stopped' ? `Recording of "${it.title}" stopped: ${msg}` : `Couldn't record "${it.title}": ${msg}`, error: it.status === 'failed' });
    }
    this.changed();
    if (why !== 'quit') setTimeout(() => this.kick(), 0);
  }

  /* =================================================================
   * 6. PLAYING A SAVED FILE (main.js: sealfile://media/<id>/<name>)
   * ================================================================= */
  /** -> { file, type } for the protocol, or null */
  fileOf(id) {
    const it = this.get(id);
    if (!it || !it.file || !['done', 'stopped'].includes(it.status) || !fs.existsSync(it.file)) return null;
    const ext = path.extname(it.file).slice(1).toLowerCase();
    return { file: it.file, type: { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', ts: 'video/mp2t', mov: 'video/quicktime', avi: 'video/x-msvideo' }[ext] || 'application/octet-stream' };
  }

  /** what the player gets for a saved file: the address, and the title's own key (watched / resume shared) */
  playInfo(id) {
    const it = this.get(id);
    const f = this.fileOf(id);
    if (!it || !f) throw new Error('That file isn\'t there any more.');
    const key = it.type === 'download' ? it.key : '';
    return { url: `sealfile://media/${it.id}/${encodeURIComponent(path.basename(f.file))}`, key, live: false, resume: key ? this.library.getProgress(it.pid, key) : null, file: f.file };
  }
}

module.exports = { Media, clean, EARLY_MS, LATE_MS };
