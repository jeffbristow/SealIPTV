/* =====================================================================
 * Seal IPTV — main.js   (Electron main process)
 * ---------------------------------------------------------------------
 * Sections:
 *   1. Start-up: data folder, modules
 *   2. The window
 *   3. Network guard: VPN blocking, User-Agent, CORS for streams
 *   4. Commands from the window (ipc)
 *   5. Playing: preparing a stream, VLC
 *   6. Updates (updater.js; bootstrap.js runs the newest package)
 *   7. Dev: screenshots (SEAL_IPTV_SHOTS)
 * ===================================================================== */
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, session, protocol, powerSaveBlocker } = require('electron');
const { Readable } = require('stream');
const { Media } = require('./media');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('./store');
const { Library } = require('./library');
const { Catalog } = require('./catalog');
const { VpnGuard } = require('./vpn');
const { Xtream } = require('./xtream');
const { Parental } = require('./parental');
const { SyncService } = require('./sync');
const { Artwork } = require('./artwork');
const { Trending } = require('./trending');
const { Studios } = require('./studios');
const tvfind = require('./tvfind');
const franchises = require('./franchises');
const { ImageCache } = require('./imagecache');
const { Updater } = require('./updater');

/* =================================================================
 * 1. START-UP
 * ================================================================= */
// SEAL_IPTV_DATA: use another data folder (tests and screenshots never touch yours)
if (process.env.SEAL_IPTV_DATA) app.setPath('userData', path.resolve(process.env.SEAL_IPTV_DATA));
if (!app.requestSingleInstanceLock()) { app.quit(); }

// the version running: a downloaded update (bootstrap.js says which) or the installed one
const VERSION = process.env.SEAL_IPTV_RUNNING_VERSION || app.getVersion();
const UA = { seal: `SealIPTV/${VERSION}`, vlc: 'VLC/3.0.21 LibVLC/3.0.21' };

let store, library, catalog, vpn, win, parental, sync, artwork, trending, updater, imageCache, media;

function userAgent() {
  const n = store.getSettings().network;
  if (n.userAgent === 'custom' && n.customUserAgent) return n.customUserAgent;
  return UA[n.userAgent] || UA.seal;
}

function init() {
  const dir = app.getPath('userData');
  const secure = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: s => safeStorage.encryptString(s).toString('base64'),
    decrypt: b => safeStorage.decryptString(Buffer.from(b, 'base64'))
  };
  store = new Store(dir, secure);
  library = new Library(dir);
  vpn = new VpnGuard({ getSettings: () => store.getSettings() });
  parental = new Parental(store);
  catalog = new Catalog({ dir, store, vpn, library, userAgent, parental });
  artwork = new Artwork({ dir, getSettings: () => store.getSettings(), allowed: () => vpn.allowed(), userAgent: () => UA.seal });
  trending = new Trending({ dir, getSettings: () => store.getSettings(), allowed: () => vpn.allowed(), userAgent: () => UA.seal });
  // the Disney / Netflix / Prime collections: the newest list we have now, a newer one looked for a little later
  const studios = new Studios({ dir, allowed: () => vpn.allowed(), userAgent: () => UA.seal });
  franchises.setStudios(studios.data());
  setTimeout(() => studios.refresh().then(d => { if (d) franchises.setStudios(d); }).catch(() => { /* next time */ }), 20000).unref();
  sync = new SyncService({
    dataDir: dir, store, library, secure, appVersion: VERSION,
    onApplied: types => send('sync:applied', [...types]),
    onProfileGone: id => catalog.remove(id),
    onProfileJoined: (from, to) => catalog.rename(from, to)
  });
  updater = new Updater({ current: VERSION, installed: app.getVersion(), dir: path.join(dir, 'updates'), userAgent: UA.seal });
  sync.onLocalChange = type => syncSoon(type === 'pos' ? 20000 : 1500);
  // other PCs' changes: every 15 s, and as soon as the window is used again
  setInterval(() => syncSoon(0), 15000).unref();
  // downloads and recordings (media.js): Windows kept awake while one runs
  let awakeId = null;
  media = new Media({
    dir, store, catalog, library, vpn, userAgent, fetch: (u, o) => globalThis.fetch(u, o),
    videos: path.join(app.getPath('videos'), 'Seal IPTV'),
    notify: send,
    awake: { start: () => { if (awakeId == null) awakeId = powerSaveBlocker.start('prevent-app-suspension'); }, stop: () => { if (awakeId != null) powerSaveBlocker.stop(awakeId); awakeId = null; } },
    freeSpace: async f => { try { fs.mkdirSync(f, { recursive: true }); const s = await fs.promises.statfs(f); return s.bavail * s.bsize; } catch { return null; } }
  });
  media.start();
  vpn.on('status', s => send('vpn:status', s));
  vpn.start();
  vpn.check({ force: true }).catch(() => {});
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

/* Sync soon: local changes after a short pause (resume points after 20 s), others' every 15 s. */
let syncTimer = null, syncDue = 0;
function syncSoon(ms) {
  if (!sync || !sync.connected()) return;
  const due = Date.now() + ms;
  if (syncTimer && syncDue <= due) return;
  clearTimeout(syncTimer);
  syncDue = due;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    sync.sync().catch(() => {}).finally(() => send('sync:status', sync.status()));
  }, ms);
}

/* =================================================================
 * 2. THE WINDOW
 * ================================================================= */
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 620,
    backgroundColor: '#121418',
    title: 'Seal IPTV',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    startedOk();
    if (process.env.SEAL_IPTV_SHOTS) runShots(process.env.SEAL_IPTV_SHOTS);
  });
  // links in plot texts etc. open in the browser, never in the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('focus', () => syncSoon(300));
  // a recording would end with the window: asked first
  win.on('close', e => {
    if (process.env.SEAL_IPTV_SHOTS || !media) return;
    const b = media.busy();
    if (!b.recording.length && !b.scheduled) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Close Seal IPTV', 'Keep it open'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Seal IPTV', message: b.recording.length ? `"${b.recording.join('", "')}" ${b.recording.length === 1 ? 'is' : 'are'} being recorded.` : `${b.scheduled} recording${b.scheduled === 1 ? ' is' : 's are'} scheduled for the next 24 hours.`,
      detail: `Recordings only happen while Seal IPTV is open. Closing it ${b.recording.length ? 'stops the recording (what has been recorded so far is kept)' : 'means they won\'t be recorded'}.${b.downloading ? ' Downloads go on the next time Seal IPTV starts.' : ''}`
    });
    if (r === 1) e.preventDefault();
  });
}

/* =================================================================
 * 3. NETWORK GUARD
 *    Every web request from the window goes to the provider (streams,
 *    posters, logos) — the app's own files are file://. So: while the
 *    VPN is required and not confirmed, all of them are cancelled.
 *    Providers rarely send CORS headers, which the player's segment
 *    requests need; they're added here.
 * ================================================================= */
function installNetGuard(ses) {
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  ses.webRequest.onBeforeRequest(filter, (d, cb) => {
    if (!vpn.allowed()) return cb({ cancel: true });
    cb({});
  });
  ses.webRequest.onBeforeSendHeaders(filter, (d, cb) => {
    const h = { ...d.requestHeaders, 'User-Agent': playUa || userAgent() };
    delete h.Origin; delete h.origin; delete h.Referer; delete h.referer;
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived(filter, (d, cb) => {
    note(d, { status: d.statusCode, type: header(d.responseHeaders, 'content-type'), location: header(d.responseHeaders, 'location') });
    const h = {};
    for (const [k, v] of Object.entries(d.responseHeaders || {})) if (!/^access-control-/i.test(k)) h[k] = v;
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Headers'] = ['*'];
    h['Access-Control-Expose-Headers'] = ['*'];
    if (d.method === 'OPTIONS') return cb({ responseHeaders: h, statusLine: 'HTTP/1.1 200 OK' });
    cb({ responseHeaders: h });
  });
  ses.webRequest.onErrorOccurred(filter, d => note(d, { error: d.error }));
}
let playUa = null;   // an M3U entry's own User-Agent while it plays

/* What the provider answered for the streams of the last play (for "Copy details"
   when a stream won't play). Images aren't kept; user names / passwords are masked. */
const netLog = [];
const header = (h, name) => { for (const [k, v] of Object.entries(h || {})) if (k.toLowerCase() === name) return String(v); return ''; };
function note(d, info) {
  if (!playing || d.resourceType === 'image') return;
  netLog.push({ at: Date.now(), method: d.method, kind: d.resourceType, url: mask(d.url), ...info, location: info.location ? mask(info.location) : undefined });
  if (netLog.length > 40) netLog.shift();
}
function mask(url) {
  let out = String(url);
  try {
    const p = store.getProfile(store.getSettings().activeProfile);
    for (const secret of [p.password, p.username].filter(s => s && s.length > 1)) {
      out = out.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
    }
  } catch { /* no profile */ }
  return out.replace(/([?&](username|password|token|key)=)[^&]*/gi, '$1***');
}
let playing = false;

/* =================================================================
 * 4. COMMANDS FROM THE WINDOW
 *    Every handler answers { ok: true, data } or { ok: false, error, code, vpn }.
 * ================================================================= */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null, vpn: e.vpn || null, locked: e.locked || null }; }
  });
}
const pid = () => {
  const id = store.getSettings().activeProfile;
  if (!id) throw new Error('Add a playlist first (Settings → Playlists).');
  return id;
};

function registerIpc() {
  handle('app:init', () => ({
    version: VERSION,
    settings: store.getSettings(),
    profiles: store.listProfiles(),
    vpn: vpn.status(),
    catalog: store.getSettings().activeProfile ? catalog.summary(store.getSettings().activeProfile) : null,
    stale: store.getSettings().activeProfile ? catalog.stale(store.getSettings().activeProfile) : false,
    dataDir: app.getPath('userData'),
    parental: parental.status(),
    sync: sync.status(),
    lists: store.getSettings().activeProfile ? library.lists(store.getSettings().activeProfile) : [],
    hostname: os.hostname()
  }));

  /* ---- settings + playlists ---- */
  handle('settings:set', patch => {
    const before = store.getSettings().vpn;
    const s = store.setSettings(patch);
    if (JSON.stringify(before) !== JSON.stringify(s.vpn)) vpn.check({ force: true }).catch(() => {});
    return s;
  });
  handle('profiles:test', async p => {
    const existing = p.id ? store.getProfile(p.id) : null;
    const clean = Store.cleanProfile(p, existing);
    if (clean.type === 'xtream' && !clean.password && existing) clean.password = existing.password;
    return catalog.test(clean);
  });
  handle('profiles:save', p => {
    const was = p && p.id ? catalog.guideAddress(p.id) : '';
    const saved = store.saveProfile(p);
    if (catalog.guideAddress(saved.id) !== was) catalog.guide.forget(saved.id);
    return saved;
  });
  handle('profiles:delete', id => { store.deleteProfile(id); library.remove(id); catalog.remove(id); return store.listProfiles(); });
  handle('profiles:use', id => { store.getProfile(id); store.setSettings({ activeProfile: id }); return { summary: catalog.summary(id), stale: catalog.stale(id) }; });
  handle('profiles:fromLink', link => Xtream.fromM3uUrl(link));
  handle('dialog:m3uFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a playlist', filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:exe', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the player', filters: [{ name: 'Programs', extensions: ['exe'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  /* ---- catalogue ---- */
  handle('catalog:refresh', () => catalog.refresh(pid(), text => send('catalog:step', text)));
  handle('trending:home', async () => catalog.trending(pid(), await trending.get({ wait: true })));
  handle('catalog:summary', () => catalog.summary(pid()));
  handle('catalog:cats', (section, opts) => catalog.cats(pid(), section, opts || {}));
  handle('catalog:list', opts => catalog.list(pid(), opts || {}));
  handle('catalog:item', (section, id) => catalog.item(pid(), section, id));
  handle('catalog:search', q => catalog.search(pid(), q));
  handle('catalog:recent', (section, opts = {}) => catalog.recent(pid(), section, 20, !!opts.homeSafe));
  handle('details:movie', id => catalog.movieInfo(pid(), id));
  handle('details:series', id => catalog.seriesInfo(pid(), id));
  handle('epg:short', id => catalog.epg(pid(), id));
  handle('epg:grid', ids => catalog.epgMany(pid(), ids));

  /* ---- library ---- */
  handle('lib:favorite', (key, on, meta) => library.setFavorite(pid(), key, on, meta));
  handle('lib:watched', (key, on, meta) => library.setWatched(pid(), key, on, meta));
  handle('lib:watchedMany', (items, on) => library.setWatchedMany(pid(), items, on));
  handle('lib:progress', (key, pos, dur, meta) => library.setProgress(pid(), key, pos, dur, meta));
  handle('lib:clearProgress', key => library.clearProgress(pid(), key));
  handle('lib:continue', () => library.continueWatching(pid(), 60).filter(p => catalog.homeSafe(pid(), p.key, p)).slice(0, 20).map(p => ({ ...p, poster: catalog.posterFor(pid(), p.key, p) })));
  handle('lib:favorites', kind => catalog.withLogos(pid(), library.favorites(pid(), kind, catalog.favSort(kind)).filter(f => catalog.visibleKey(pid(), f.key, f))));
  handle('lib:arrangeFavorites', (kind, keys) => catalog.withLogos(pid(), library.arrangeFavorites(pid(), kind, keys).filter(f => catalog.visibleKey(pid(), f.key, f))));
  handle('lib:watchlist', (key, on, meta) => library.setWatchlist(pid(), key, on, catalog.watchMeta(pid(), key, meta)));
  handle('lib:onWatchlist', key => library.onWatchlist(pid(), key));
  handle('lib:watchlistItems', (opts = {}) => catalog.watchlist(pid(), { home: !!opts.home }));
  handle('events:list', kind => catalog.eventsPage(pid(), kind === 'ppv' ? 'ppv' : 'sports'));
  handle('events:home', () => catalog.eventsHome(pid()));
  handle('lists:all', () => library.lists(pid()));
  handle('lists:save', (id, o) => library.saveList(pid(), id, o));
  handle('lists:remove', id => library.removeList(pid(), id));
  handle('lists:items', id => catalog.withLogos(pid(), library.listItems(pid(), id).filter(f => catalog.visibleKey(pid(), f.key, f))));
  handle('lists:of', key => library.listsOf(pid(), key));
  handle('lists:set', (id, key, on, meta) => library.setListed(pid(), id, key, on, meta));
  handle('lists:title', (id, key, title) => library.setListedTitle(pid(), id, key, title));
  handle('collections:list', q => catalog.collections(pid(), q));

  /* ---- downloads + recordings (media.js) ---- */
  // only what may be shown now (a locked category's titles / channels left out)
  const mediaShown = it => { try { return catalog.visibleKey(it.pid, it.type === 'download' ? it.key : 'live:' + it.channel.id, it.type === 'download' ? { ...it.meta, seriesId: it.req.seriesId } : {}); } catch { return true; } };
  handle('media:list', () => ({ items: media.list().filter(mediaShown), used: media.used(), limit: media.limit(), folder: media.folder() }));
  handle('media:of', keys => { const id = pid(), out = {}; for (const k of keys || []) { const d = media.downloadOf(k); if (d && media.get(d.id).pid === id) out[k] = d; } return out; });
  handle('media:download', async (req, meta) => { const id = pid(); await catalog.streamUrl(id, req); return media.addDownload(id, req, meta); });
  handle('media:downloadMany', async list => { const id = pid(); for (const { req, meta } of list || []) { await catalog.streamUrl(id, req); media.addDownload(id, req, meta); } return (list || []).length; });
  handle('media:pause', id => media.pause(id));
  handle('media:resume', id => media.resume(id));
  handle('media:remove', (id, deleteFile) => media.remove(id, { deleteFile: deleteFile !== false }));
  handle('media:recordNow', async (o, force) => { const id = pid(); await catalog.streamUrl(id, { kind: 'live', id: o.channel.id }); return media.recordNow(id, o, { force: !!force }); });
  handle('media:schedule', async o => { const id = pid(); await catalog.streamUrl(id, { kind: 'live', id: o.channel.id }); return media.schedule(id, o); });
  handle('media:stop', id => media.stop(id));
  handle('media:answer', (id, record) => media.answer(id, !!record));
  handle('media:show', id => { const f = media.fileOf(id); if (f) shell.showItemInFolder(f.file); else shell.openPath(media.folder()); return true; });
  handle('media:openFolder', () => { fs.mkdirSync(media.folder(), { recursive: true }); return shell.openPath(media.folder()); });
  handle('media:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Where downloads and recordings go', defaultPath: media.folder(), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  handle('collections:get', (id, order, kind) => catalog.collection(pid(), id, order, kind));

  /* ---- parental controls + category choices ---- */
  handle('parental:status', () => parental.status());
  handle('parental:unlock', pin => parental.unlock(pin));
  handle('parental:lock', () => parental.lock());
  handle('parental:setPin', (pin, current) => parental.setPin(pin, current));
  handle('parental:removePin', current => parental.removePin(current));
  handle('parental:options', (opts, pin) => parental.setOptions(opts || {}, pin));
  handle('parental:searchHidden', (on, pin) => parental.setSearchHidden(!!on, pin));

  /* ---- sync (seal-iptv-server) ---- */
  handle('sync:status', () => sync.status());
  handle('sync:probe', server => sync.probe(server));
  handle('sync:connect', async opts => { const r = await sync.connect(opts || {}); return r; });
  handle('sync:now', async () => { await sync.sync(); return sync.status(); });
  handle('sync:disconnect', () => sync.disconnect());
  handle('sync:devices', () => sync.devices());
  // "Connect a TV": the TVs on the home network showing "Set up from your phone"; send one this vault
  handle('tv:find', () => tvfind.find({ addresses: tvfind.lanAddresses(require('os').networkInterfaces()) }));
  handle('tv:send', async ({ address, code, passphrase }) => {
    const inv = await sync.invite(passphrase);
    const r = await tvfind.send({ address, code, data: { kind: 'join', server: inv.server, username: inv.username, authKey: inv.authKey, vaultKey: inv.vaultKey, from: require('os').hostname() } });
    if (r.ok && inv.fresh) sync.keepAuthKey(inv.authKey);
    return r;
  });
  handle('sync:revoke', id => sync.revoke(id));
  handle('sync:destroy', pass => sync.destroy(pass));
  handle('cats:flag', (section, catId, patch, pin) => {
    patch = patch || {};
    if ('lock' in patch) parental.allowChange(pin);   // locking / unlocking a category needs the PIN
    return library.setCatFlag(pid(), `${section}:${catId}`, patch);
  });
  handle('lib:clearHistory', () => library.clearHistory(pid()));

  /* ---- posters the provider doesn't have (artwork.js) ---- */
  handle('art:find', list => artwork.find(list, { addresses: true }));   // shown through sealimg: (kept on disk)
  handle('art:keep', (url, data) => artwork.keep(url, data));
  handle('art:testKey', key => artwork.testTmdb(key));
  handle('art:clear', () => artwork.clear());

  /* ---- VPN ---- */
  handle('vpn:check', () => vpn.check({ force: true }));
  handle('vpn:adapters', () => vpn.adapters());
  handle('vpn:publicIp', () => vpn.publicIp());
  handle('vpn:openProton', () => {
    const exe = protonExe();
    if (!exe) throw new Error('ProtonVPN isn\'t installed in the usual place. Open it from the Start menu.');
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    return true;
  });

  /* ---- playing ---- */
  handle('play:prepare', req => preparePlay(req));
  handle('play:stopped', () => { playUa = null; playing = false; media.afterPlay(); return true; });
  handle('play:netlog', () => netLog.slice());
  handle('play:external', req => playExternal(req));
  handle('play:findVlc', () => findVlc());
}

/* =================================================================
 * 5. PLAYING
 * ================================================================= */
/**
 * req: { kind: live|movie|episode, id, ext, seriesId }
 * -> { url, live, key, resume: { pos, dur } | null }
 * Refuses (code 'VPN') when the VPN is required and not confirmed.
 */
async function preparePlay(req) {
  // a downloaded / recorded file: no provider, no stream used
  if (req.file) {
    const f = media.playInfo(req.file);
    netLog.length = 0;
    return { url: f.url, shown: f.file, ua: userAgent(), live: false, key: f.key, resume: f.resume, local: true };
  }
  const id = pid();
  await vpn.ensure();
  const s = await catalog.streamUrl(id, req);
  // one more stream: a download waits, a recording is only stopped when the user said so (STREAMS: asked)
  media.beforePlay({ force: !!req.force });
  playUa = s.ua || null;
  playing = true;
  netLog.length = 0;
  const key = `${req.kind}:${req.id}`;
  return { url: s.url, shown: mask(s.url), ua: s.ua || userAgent(), live: s.live, key, resume: s.live ? null : library.getProgress(id, key) };
}

function protonExe() {
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Proton', 'VPN', 'ProtonVPN.Launcher.exe');
  return fs.existsSync(base) ? base : null;
}

function findVlc() {
  const set = store.getSettings().playback.externalPlayer;
  if (set && fs.existsSync(set)) return set;
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const p = path.join(root, 'VideoLAN', 'VLC', 'vlc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Open in VLC (or the player in Settings). Same VPN rule as the built-in player. */
async function playExternal(req) {
  const exe = findVlc();
  if (!exe) throw new Error('VLC wasn\'t found. Install VLC, or choose a player in Settings → Playback.');
  let s;
  if (req.file) s = { url: media.playInfo(req.file).file };
  else {
    const id = pid();
    await vpn.ensure();
    s = await catalog.streamUrl(id, req);
    // VLC is one more stream too (Seal IPTV can't see when it's closed: only checked now)
    if (!media.canStream()) throw new Error(`Seal IPTV is set to use ${media.limit()} stream${media.limit() === 1 ? '' : 's'} at a time, and ${media.limit() === 1 ? 'it is' : 'they are'} in use (a recording). Stop it, or allow more streams in Settings → Recordings & downloads.`);
  }
  const args = [s.url];
  if (/vlc\.exe$/i.test(exe)) {
    args.push(`--http-user-agent=${s.ua || userAgent()}`, '--no-video-title-show');
    if (req.title) args.push(`--meta-title=${req.title}`);
    if (req.start > 0) args.push(`--start-time=${Math.floor(req.start)}`);
  }
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
  return true;
}

/* =================================================================
 * 6. UPDATES
 * ================================================================= */
/* the window showed: this version starts fine (bootstrap.js counts starts that don't) */
function startedOk() {
  if (!process.env.SEAL_IPTV_UPDATE_FILE) return;
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'updates', 'boot.json')); } catch { /* none */ }
}

function registerUpdates() {
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install((got, total) => send('update:progress', { got, total })));
  handle('update:restart', () => { setTimeout(() => { app.relaunch(); app.exit(0); }, 200); return true; });
  handle('update:openPage', url => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(String(url)); return true; });
}

/* =================================================================
 * 7. DEV: SCREENSHOTS
 *    SEAL_IPTV_SHOTS=steps.json: [{ js, wait, file }] — runs each js in
 *    the window, waits, saves a PNG, then quits. Used by devtest/shots.js.
 * ================================================================= */
async function runShots(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  win.webContents.on('console-message', e => { if (e.level === 'warning' || e.level === 'error') console.log('console:', e.message); });
  await sleep(1200);
  for (const s of steps) {
    try {
      if (s.js) await win.webContents.executeJavaScript(s.js, true);
    } catch (e) { console.log('step failed:', e.message); }
    await sleep(s.wait || 800);
    if (s.file) {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(s.file, img.toPNG());
      console.log('saved', s.file);
    }
    if (s.log) console.log(s.log, await win.webContents.executeJavaScript(s.logJs || 'null', true));
  }
  app.quit();
}

/* ================================================================= */
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// posters / logos as sealimg://img/?u=<address>: kept on disk (imagecache.js)
protocol.registerSchemesAsPrivileged([
  { scheme: 'sealimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // downloads / recordings as sealfile://media/<id>/<name>: only the files media.js saved (Range for seeking)
  { scheme: 'sealfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);
function registerFiles() {
  protocol.handle('sealfile', async req => {
    let id = '';
    try { id = new URL(req.url).pathname.split('/')[1] || ''; } catch { /* bad address */ }
    const f = media && media.fileOf(id);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
    if (!f) return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    const size = fs.statSync(f.file).size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    let start = 0, end = size - 1, status = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
      else start = Math.max(0, size - Number(m[2]));
      if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Access-Control-Allow-Origin': '*' } });
      status = 206;
    }
    // (the page is file://: the player's requests are cross-origin)
    const headers = { 'Content-Type': f.type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(size ? Readable.toWeb(fs.createReadStream(f.file, { start, end })) : null, { status, headers });
  });
}
function registerImages() {
  imageCache = new ImageCache({ dir: path.join(app.getPath('userData'), 'images'), fetch: (u, o) => session.defaultSession.fetch(u, o), allowed: () => vpn.allowed() });
  protocol.handle('sealimg', async req => {
    let u = '';
    try { u = new URL(req.url).searchParams.get('u') || ''; } catch { /* bad address */ }
    const r = await imageCache.get(u);
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.type, 'Cache-Control': 'max-age=86400' } });
  });
}

app.whenReady().then(() => {
  init();
  installNetGuard(session.defaultSession);
  registerImages();
  registerFiles();
  registerIpc();
  registerUpdates();
  createWindow();
});
app.on('before-quit', () => { try { if (media) media.shutdown(); } catch { /* saved as it was */ } try { library.flush(); } catch { /* nothing to save */ } try { artwork.flush(); } catch { /* nothing to save */ } try { imageCache.flushFailed(); } catch { /* nothing to save */ } });
app.on('window-all-closed', () => app.quit());
