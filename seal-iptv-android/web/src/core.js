/* =====================================================================
 * Seal IPTV for Fire TV — core.js   (what main.js is on Windows)
 * ---------------------------------------------------------------------
 * The same store / library / catalog / VPN guard / parental / sync
 * modules as Windows (../../seal-iptv/src/main), bundled by build.js
 * with small stand-ins for Node (shims/). The window talks to it
 * through window.api.invoke(channel, …) exactly as on Windows, so the
 * same app.js runs on both.
 *
 * Different on Fire TV:
 *   - playing: Android's own player (player-tv.js + PlayerActivity.java)
 *   - "Open in VLC" -> "Open in another app" (Android picks the app)
 *   - the VPN: Android says whether a VPN is connected (the ProtonVPN
 *     app); Proton's API then confirms it's Proton, as on Windows
 *   - posters / logos are blocked by Android while the VPN guard says so
 *   - no playlist files from disk (links and Xtream logins)
 *
 * Sections:
 *   1. Start-up
 *   2. Network guard + sync timers
 *   3. Commands (same channels as main.js)
 * ===================================================================== */
require('./shims/native');
const { N, nativeCall, onEvent } = require('./shims/native');
const { Store } = require('../../../seal-iptv/src/main/store');
const { Library } = require('../../../seal-iptv/src/main/library');
const { Catalog } = require('../../../seal-iptv/src/main/catalog');
const { VpnGuard } = require('../../../seal-iptv/src/main/vpn');
const { Xtream } = require('../../../seal-iptv/src/main/xtream');
const { Parental } = require('../../../seal-iptv/src/main/parental');
const { SyncService } = require('../../../seal-iptv/src/main/sync');
const { Artwork } = require('../../../seal-iptv/src/main/artwork');
const { Trending } = require('../../../seal-iptv/src/main/trending');
const { Studios } = require('../../../seal-iptv/src/main/studios');
const franchises = require('../../../seal-iptv/src/main/franchises');

/* =================================================================
 * 1. START-UP
 * ================================================================= */
const DATA = '/data';
// the version of these pages and logic (build.js writes it in); the APK can be older
const VERSION = typeof __SEAL_VERSION__ !== 'undefined' ? __SEAL_VERSION__ : (N && N.appVersion()) || '0.0.0';
// start-up steps for adb logcat -s SealWeb (MainActivity passes on messages starting "[seal]")
const T0 = Date.now();
const trace = (...a) => console.log(`[seal] ${a.join(' ')} (${Date.now() - T0} ms)`);
trace('core', VERSION, 'starts');
const UA = { seal: `SealIPTV/${VERSION} (Fire TV)`, vlc: 'VLC/3.0.21 LibVLC/3.0.21' };
const listeners = new Map();
const send = (ch, data) => { for (const fn of listeners.get(ch) || []) { try { fn(data); } catch (e) { console.error(e); } } };

const secure = { available: () => true, encrypt: s => N.encrypt(s), decrypt: b => { const r = N.decrypt(b); if (r == null) throw new Error('cannot decrypt'); return r; } };
const store = new Store(DATA, secure);
const library = new Library(DATA);
const vpn = new VpnGuard({ getSettings: () => store.getSettings(), vpnActive: () => N.vpnActive() || null });
const parental = new Parental(store);
function userAgent() {
  const n = store.getSettings().network;
  if (n.userAgent === 'custom' && n.customUserAgent) return n.customUserAgent;
  return UA[n.userAgent] || UA.seal;
}
const catalog = new Catalog({ dir: DATA, store, vpn, library, userAgent, parental });
const artwork = new Artwork({ dir: DATA, getSettings: () => store.getSettings(), allowed: () => vpn.allowed(), userAgent: () => UA.seal });
const trending = new Trending({ dir: DATA, getSettings: () => store.getSettings(), allowed: () => vpn.allowed(), userAgent: () => UA.seal });
// the Disney / Netflix / Prime collections: the newest list we have now, a newer one looked for a little later
const studios = new Studios({ dir: DATA, allowed: () => vpn.allowed(), userAgent: () => UA.seal });
franchises.setStudios(studios.data());
setTimeout(() => studios.refresh().then(d => { if (d) { franchises.setStudios(d); trace('studios: a newer list,', d.built); } }).catch(e => trace('studios:', e.message)), 20000);
const sync = new SyncService({
  dataDir: DATA, store, library, secure, appVersion: VERSION,
  onApplied: types => send('sync:applied', [...types]),
  onProfileGone: id => catalog.remove(id),
  onProfileJoined: (from, to) => catalog.rename(from, to)
});

/* =================================================================
 * 2. NETWORK GUARD + SYNC TIMERS
 * ================================================================= */
let playUa = null;
const guard = () => { try { N.setGuard(!vpn.allowed(), playUa || userAgent()); } catch { /* old bridge */ } };
vpn.on('status', s => { guard(); send('vpn:status', s); });
vpn.start();
vpn.check({ force: true }).catch(() => {}).finally(guard);
guard();

let syncTimer = null, syncDue = 0;
function syncSoon(ms) {
  if (!sync.connected()) return;
  const due = Date.now() + ms;
  if (syncTimer && syncDue <= due) return;
  clearTimeout(syncTimer);
  syncDue = due;
  syncTimer = setTimeout(() => { syncTimer = null; sync.sync().catch(() => {}).finally(() => send('sync:status', sync.status())); }, ms);
}
sync.onLocalChange = type => syncSoon(type === 'pos' ? 20000 : 1500);
setInterval(() => syncSoon(0), 15000);
// back to the app (from the Fire TV home screen, ProtonVPN …): check the VPN, sync
// the summary of the playlist keeps up with what was watched (catalog.keepRefs)
const keepRefs = () => { try { catalog.keepRefs(store.getSettings().activeProfile); } catch { /* next time */ } };
onEvent('resume', () => { vpn.check({ force: true }).catch(() => {}); syncSoon(300); keepRefs(); });
onEvent('network', () => vpn.check({ force: true }).catch(() => {}));

/* =================================================================
 * 3. COMMANDS — the same channels as main.js on Windows
 * ================================================================= */
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
const pid = () => {
  const id = store.getSettings().activeProfile;
  if (!id) throw new Error('Add a playlist first (Settings → Playlists).');
  return id;
};

// the playlist in use, fetched ahead while the page starts (the bridge took 15 s for a big one)
const readAhead = (() => {
  const id = store.getSettings().activeProfile;
  if (!id) return Promise.resolve(false);
  return require('fs').readAhead(catalog._file(id)).then(ok => { trace('playlist summary read ahead:', ok); return ok; });
})();

/* A playlist saved in sections (catalog.js): a section's file is fetched ahead, without holding up the
   page, before a command that needs it — Movies opened the first time, a search … */
const NEEDS = {
  'catalog:cats': a => [a[0]],
  'catalog:list': a => [a[0] && a[0].section],
  'catalog:search': () => ['live', 'movies', 'series'],
  'collections:list': () => ['movies', 'series'],
  'collections:get': () => ['movies', 'series'],
  'events:list': () => ['live'],
  'events:home': () => ['live']
};
const reading = new Map();   // file -> its fetch, so two commands don't fetch it twice
async function readSections(list) {
  const id = store.getSettings().activeProfile;
  if (!id) return;
  const want = catalog.unread(id).filter(s => list.includes(s));
  await Promise.all(want.map(s => {
    const f = catalog._secFile(id, s);
    if (!reading.has(f)) {
      const t = Date.now();
      reading.set(f, require('fs').readAhead(f).then(ok => trace(s, 'read ahead:', ok, Date.now() - t, 'ms')).finally(() => reading.delete(f)));
    }
    return reading.get(f);
  }));
  // read some other way meanwhile: let go of the copy
  for (const s of want) if (!catalog.unread(id).includes(s)) require('fs').dropAhead(catalog._secFile(id, s));
}

handle('app:init', async () => {
  await readAhead;
  const id = store.getSettings().activeProfile;
  if (id && !catalog.mem.has(id)) { catalog.get(id); trace('playlist summary ready, sections not read yet:', catalog.unread(id).join(' ') || 'none'); }
  return {
    version: VERSION,
    settings: store.getSettings(),
    profiles: store.listProfiles(),
    vpn: vpn.status(),
    catalog: store.getSettings().activeProfile ? catalog.summary(store.getSettings().activeProfile) : null,
    stale: store.getSettings().activeProfile ? catalog.stale(store.getSettings().activeProfile) : false,
    dataDir: 'this Fire TV (app storage)',
    parental: parental.status(),
    sync: sync.status(),
    lists: store.getSettings().activeProfile ? library.lists(store.getSettings().activeProfile) : [],
    hostname: N.deviceName ? N.deviceName() : 'Fire TV',
    platform: 'tv'
  };
});

/* ---- settings + playlists ---- */
handle('settings:set', patch => {
  const before = JSON.stringify(store.getSettings().vpn);
  const s = store.setSettings(patch);
  if (before !== JSON.stringify(s.vpn)) vpn.check({ force: true }).catch(() => {}).finally(guard);
  guard();
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
handle('dialog:m3uFile', () => null);
handle('dialog:exe', () => null);

/* ---- catalogue ---- */
// after a reload the titles are all in memory: the trending ones are found then (Home never reads a section for them)
handle('catalog:refresh', () => catalog.refresh(pid(), text => send('catalog:step', text)).then(r => {
  try { const t = trending.saved(); if (t) catalog.trending(pid(), t, { read: false }); } catch { /* next time */ }
  return r;
}));
let trendFirst = null;
handle('trending:home', async () => {
  const t = await trending.get({ wait: true });
  const id = pid();
  // the first time (no matches kept yet): the sections are read a little later, in the background, to find them
  if (t && !trendFirst && !catalog.trendKept(id)) {
    trendFirst = setTimeout(() => readSections(['movies', 'series']).then(() => {
      catalog.trending(id, trending.saved(), { read: true });   // (from the copies just fetched)
      trace('trending: found in the playlist');
    }).catch(() => { trendFirst = null; }), 15000);
  }
  return catalog.trending(id, t, { read: false });
});
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
handle('collections:get', (id, order, kind) => catalog.collection(pid(), id, order, kind));
handle('lib:clearHistory', () => library.clearHistory(pid()));

/* ---- parental + categories ---- */
handle('parental:status', () => parental.status());
handle('parental:unlock', pin => parental.unlock(pin));
handle('parental:lock', () => parental.lock());
handle('parental:setPin', (pin, current) => parental.setPin(pin, current));
handle('parental:removePin', current => parental.removePin(current));
handle('parental:options', (opts, pin) => parental.setOptions(opts || {}, pin));
handle('parental:searchHidden', (on, pin) => parental.setSearchHidden(!!on, pin));
handle('cats:flag', (section, catId, patch, pin) => {
  patch = patch || {};
  if ('lock' in patch) parental.allowChange(pin);
  return library.setCatFlag(pid(), `${section}:${catId}`, patch);
});

/* ---- posters the provider doesn't have (artwork.js) ---- */
handle('art:find', list => artwork.find(list));
handle('art:keep', (url, data) => artwork.keep(url, data));
handle('art:testKey', key => artwork.testTmdb(key));
handle('art:clear', () => artwork.clear());

/* ---- sync ---- */
handle('sync:status', () => sync.status());
handle('sync:probe', server => sync.probe(server));
handle('sync:connect', opts => sync.connect(opts || {}));
handle('sync:now', async () => { await sync.sync(); return sync.status(); });
handle('sync:disconnect', () => sync.disconnect());
handle('sync:devices', () => sync.devices());

/* ---- "Set up from your phone": a QR code; the phone's page sends the sync server or a playlist
   (PhoneServer.java serves it; phone/link.js seals what's sent with the code in the QR code) ---- */
const phoneLink = require('../../../seal-iptv/src/main/setuplink');
const qrcode = require('qrcode-generator');
let phone = null;   // { key, bad } while the QR code is on the screen
const tvfind = require('../../../seal-iptv/src/main/tvfind');
/** the TV's address on the home network (Wi-Fi / Ethernet, not the VPN's) */
function lanAddress() {
  let all = {};
  try { all = JSON.parse(N.interfaces()); } catch { /* none */ }
  return tvfind.lanAddresses(all)[0] || '';
}
handle('phone:start', async () => {
  if (typeof N.phoneStart !== 'function') throw new Error('Install the newest Seal IPTV for Fire TV (Settings → About → Check for updates) to set it up from a phone.');
  const ip = lanAddress();
  if (!ip) throw new Error('The TV isn\'t on a home network (Wi-Fi or Ethernet), so a phone can\'t reach it.');
  const html = await (await globalThis.__pageFetch('phone.html')).text();
  // /hello: how another Seal IPTV on the network finds this TV ("Connect a TV")
  const port = N.phoneStart(8765, html, JSON.stringify({ app: 'seal-iptv-setup', v: 1, name: N.deviceName ? N.deviceName() : 'Fire TV' }));
  if (port < 0) throw new Error('The TV couldn\'t open its setup page on the home network.');
  const code = phoneLink.newCode();
  phone = { key: phoneLink.keyFrom(code), bad: 0 };
  const url = `http://${ip}:${port}/#${code}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  trace('phone setup: open on port', port);
  return { url, address: `${ip}:${port}`, code: phoneLink.pretty(code), svg: qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }) };
});
// (the server a few seconds later: the phone's answer may still be on its way when the window closes)
let phoneStopping = null;
// "Connect a TV" from this TV: find the others showing the setup window, send them this vault
handle('tv:find', () => {
  let all = {};
  try { all = JSON.parse(N.interfaces()); } catch { /* none */ }
  return tvfind.find({ addresses: tvfind.lanAddresses(all), timeout: 450, ports: [8765] });
});
handle('tv:send', async ({ address, code, passphrase }) => {
  const inv = await sync.invite(passphrase);
  const r = await tvfind.send({ address, code, data: { kind: 'join', server: inv.server, username: inv.username, authKey: inv.authKey, vaultKey: inv.vaultKey, from: N.deviceName ? N.deviceName() : 'Fire TV' } });
  if (r.ok && inv.fresh) sync.keepAuthKey(inv.authKey);
  return r;
});
handle('phone:stop', () => {
  phone = null;
  clearTimeout(phoneStopping);
  phoneStopping = setTimeout(() => { if (!phone) try { N.phoneStop(); } catch { /* old APK */ } }, 4000);
  return true;
});
onEvent('phonePost', async ({ id, body }) => {
  const answer = o => { try { N.phoneReply(id, JSON.stringify(o)); } catch { /* gone */ } };
  if (!phone) return answer({ ok: false, error: 'On the TV, open "Set up from your phone" again.' });
  let m;
  try { m = phoneLink.open(phone.key, body); }
  catch {
    // not sealed with this code: someone else on the network, or an old QR code — after 20, the TV stops listening
    if (++phone.bad >= 20) { phone = null; try { N.phoneStop(); } catch { /* gone */ } }
    return answer({ ok: false, error: 'That isn\'t the code on the TV. Scan the QR code on the TV again.' });
  }
  try { answer({ ok: true, text: await phoneDo(m) }); }
  catch (e) { answer({ ok: false, error: e.message || 'Something went wrong.' }); }
});
async function phoneDo(m) {
  // from a Seal IPTV that's in sync already ("Connect a TV"): its vault, joined as a device of our own
  if (m.kind === 'join') {
    const r = await sync.joinWith({ server: m.server, username: m.username, authKey: m.authKey, vaultKey: m.vaultKey, deviceName: N.deviceName ? N.deviceName() : 'Fire TV' });
    send('phone:done', { kind: 'sync', from: m.from || '' });
    return `${N.deviceName ? N.deviceName() : 'The TV'} is connected: ${Number(r.items || 0).toLocaleString()} records in sync. It's updating now.`;
  }
  if (m.kind === 'sync') {
    const r = await sync.connect({ server: m.server, username: m.username, passphrase: m.passphrase, create: false, deviceName: m.deviceName || (N.deviceName ? N.deviceName() : 'Fire TV') });
    send('phone:done', { kind: 'sync' });
    return `The TV is connected: ${Number(r.items || 0).toLocaleString()} records in sync. It's updating now.`;
  }
  if (m.kind === 'xtream' || m.kind === 'm3u') {
    const form = m.kind === 'xtream' ? { type: 'xtream', name: m.name || '', server: m.server, username: m.username, password: m.password } : { type: 'm3u', name: m.name || '', m3uUrl: m.m3uUrl };
    await catalog.test(Store.cleanProfile(form, null));   // the login works / the link is a playlist
    const saved = store.saveProfile(form);
    send('phone:done', { kind: 'playlist', id: saved.id, name: saved.name });
    return `"${saved.name}" was added. The TV is loading it now.`;
  }
  throw new Error('The TV doesn\'t know what to do with that.');
}
handle('sync:revoke', id => sync.revoke(id));
handle('sync:destroy', pass => sync.destroy(pass));

/* ---- VPN ---- */
handle('vpn:check', async () => { const s = await vpn.check({ force: true }); guard(); return s; });
handle('vpn:adapters', () => vpn.adapters());
handle('vpn:publicIp', () => vpn.publicIp());
handle('vpn:openProton', () => {
  if (!N.launchApp('ch.protonvpn.android')) throw new Error('ProtonVPN isn\'t installed on this Fire TV.');
  return true;
});

/* ---- playing (player-tv.js talks to Android's player) ---- */
handle('play:prepare', async req => {
  const id = pid();
  await vpn.ensure();
  const s = await catalog.streamUrl(id, req);
  playUa = s.ua || null;
  guard();
  const key = `${req.kind}:${req.id}`;
  return { url: s.url, shown: s.url.replace(/\/(live|movie|series)\/[^/]+\/[^/]+\//, '/$1/***/***/'), ua: s.ua || userAgent(), live: s.live, key, resume: s.live ? null : library.getProgress(id, key) };
});
handle('play:stopped', () => { playUa = null; guard(); return true; });
handle('play:netlog', () => []);
handle('play:findVlc', () => 'another app on this Fire TV (Android asks which)');
handle('play:external', async req => {
  const id = pid();
  await vpn.ensure();
  const s = await catalog.streamUrl(id, req);
  if (!N.openExternal(s.url, req.title || '', s.ua || userAgent())) throw new Error('No other video app on this Fire TV can open it. Install VLC for Fire TV from the Amazon Appstore.');
  return true;
});

/* ---- updates (UpdateManager.java: new pages, or a new APK for Android's installer) ---- */
const native = async method => { const r = await nativeCall(method); if (!r.ok) throw new Error(r.error); return r.data; };
handle('update:check', () => native('updateCheck'));
handle('update:install', async () => {
  const r = await native('updateInstall');
  if (r && r.reload) { try { library.flush(); artwork.flush(); } catch { /* saved later */ } setTimeout(() => N.updateRestart(), 1200); }
  return r;
});
handle('update:restart', () => { try { library.flush(); artwork.flush(); } catch { /* saved later */ } N.updateRestart(); return true; });
handle('update:openPage', () => { throw new Error('Download the installer on a PC: github.com/jeffbristow/SealIPTV/releases'); });
onEvent('updateProgress', p => send('update:progress', p));
// app.js started: these pages work (a downloaded version that doesn't get here twice is set aside)
window.__sealStarted = () => { try { N.webReady(); } catch { /* old APK */ } };

/* ---- the window's side (same shape as preload.js on Windows) ---- */
window.api = {
  invoke: async (channel, ...args) => {
    const fn = handlers[channel];
    if (!fn) return { ok: false, error: 'Unknown command: ' + channel };
    const t = Date.now();
    if (NEEDS[channel]) { try { await readSections(NEEDS[channel](args)); } catch { /* read when it's needed */ } }
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null, vpn: e.vpn || null, locked: e.locked || null }; }
    finally { if (Date.now() - t > 500) trace(channel, 'took', Date.now() - t, 'ms'); }
  },
  on: (channel, fn) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); }
};
window.SealEvents = { on: onEvent };
window.addEventListener('pagehide', () => { try { library.flush(); artwork.flush(); } catch { /* nothing to save */ } });
// the Fire TV home button doesn't unload the page: save the library now and then
setInterval(() => { try { library.flush(); artwork.flush(); } catch { /* later */ } }, 30000);
onEvent('pause', () => { try { library.flush(); artwork.flush(); } catch { /* later */ } keepRefs(); });
