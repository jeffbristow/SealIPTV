/* =====================================================================
 * Seal IPTV — app.js   (the window)
 * ---------------------------------------------------------------------
 * Sections:
 *   1. Helpers: call(), dialog, toasts, busy, images
 *   2. State + start-up
 *   3. Navigation, top bar, search
 *   4. VPN status (pill, "VPN required" dialog)
 *   5. Home
 *   6. Live TV
 *   7. Movies + Series (poster grids)
 *   8. Movie page
 *   9. Series page
 *  10. Favorites + search results
 *  11. Settings (playlists, VPN, playback, posters, library, about)
 *  12. Playlist dialog
 *  13. Reloading the playlist
 *  14. Updates (bar at the top, Settings → About)
 * player.js (loaded after this file) is the player; it uses these helpers.
 * ===================================================================== */
'use strict';

/** Fire TV (seal-iptv-android): same pages, a remote instead of a mouse, Android's player. */
const TV = !!window.SEAL_TV;
const OTHER_PLAYER = TV ? 'Open in another app' : 'Open in VLC';

/* =================================================================
 * 1. HELPERS
 * ================================================================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (el, on) => el.classList.toggle('hidden', !on);
const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

/** Main-process command; throws Error with .code / .vpn on failure. */
async function call(channel, ...args) {
  const r = await window.api.invoke(channel, ...args);
  if (r.ok) return r.data;
  const e = new Error(r.error);
  e.code = r.code;
  e.vpn = r.vpn;
  e.locked = r.locked;
  throw e;
}

/** Shows an error the right way: the VPN dialog for VPN refusals, a toast otherwise. */
function fail(e) {
  if (e && e.code === 'VPN') return vpnBlocked(e.vpn);
  if (e && e.code === 'LOCKED') {
    // the list we're in became locked (Lock now / time ran out): back to "All", no PIN prompt
    const sec = e.locked && state.sec[e.locked.section];
    if (sec && sec.cat === e.locked.cat && state.view === e.locked.section) { sec.cat = ''; return render(); }
    return askPin(e.locked).then(ok => { if (ok) render(); });
  }
  toast(e && e.message ? e.message : String(e), 'err');
}

function toast(text, kind = '') {
  const el = h(`<div class="toast ${kind}"></div>`);
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
}

function busy(text) {
  show($('#busy'), text !== false);
  $('#busyText').textContent = text || '';
}

/**
 * Generic dialog. Resolves with onOk()'s value, 'extra', or null (cancel).
 * onOk may return false to keep the dialog open.
 */
let dialogKey = null;   // the open dialog's Enter / Escape keys
function dialog({ title, html, okText = 'OK', cancelText = 'Cancel', hideCancel = false, onOk, extraText = null, wide = false, onOpen, danger = false }) {
  return new Promise(resolve => {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    $('#dlgModal .modal-card').classList.toggle('wide', wide);
    const ok = $('#dlgOk'), cancel = $('#dlgCancel'), extra = $('#dlgExtra');
    ok.textContent = okText;
    ok.classList.toggle('danger-ok', danger);   // it deletes: red, and Cancel is selected first
    cancel.textContent = cancelText;
    show(cancel, !hideCancel);
    extra.textContent = extraText || '';
    show(extra, !!extraText);
    show($('#dlgModal'), true);
    const done = v => { show($('#dlgModal'), false); ok.onclick = cancel.onclick = extra.onclick = $('#dlgX').onclick = null; document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => {
      // the dialog went away some other way (another dialog, a redraw): Enter is the page's again
      if (dialogKey !== key || $('#dlgModal').classList.contains('hidden')) { document.removeEventListener('keydown', key, true); return; }
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); ok.click(); }
    };
    if (dialogKey) document.removeEventListener('keydown', dialogKey, true);
    dialogKey = key;
    document.addEventListener('keydown', key, true);
    ok.onclick = async () => {
      ok.disabled = true;
      try { const v = onOk ? await onOk() : true; if (v !== false) done(v); } finally { ok.disabled = false; }
    };
    cancel.onclick = $('#dlgX').onclick = () => done(null);
    extra.onclick = () => done('extra');
    if (onOpen) onOpen();
    const first = $('#dlgBody').querySelector('input:not([type=checkbox]):not([type=radio]),select');
    setTimeout(() => (first || (danger && !hideCancel ? cancel : ok)).focus(), 30);
  });
}
const confirmBox = (title, text, okText = 'OK', danger = false) => dialog({ title, html: `<p>${esc(text)}</p>`, okText, danger });

const initials = name => String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/** A movie's / series' title for looking up a poster the provider doesn't have (Art below). */
const artAttrs = art => (art && (art.kind === 'movie' || art.kind === 'series') && art.name ? ` data-ak="${art.kind}" data-an="${esc(art.name)}" data-ay="${Number(art.year) || ''}"` : '');
/* Windows: pictures from the web go through sealimg: — kept on disk the first time (main/imagecache.js),
   so moving around and starting again doesn't fetch them again. (Fire TV: the address as it is.) */
const KEEPS_IMAGES = location.protocol === 'file:';
// TVs: the pages are https://appassets…, and newer WebViews block a provider's http:// pictures there (mixed
// content), so they go through the app's own address too (MainActivity -> ImageCache)
const TV_IMAGES = location.host === 'appassets.androidplatform.net' && !!(window.SealNative && window.SealNative.imageRoute);   // an older TV app: as before
const imgSrc = u => (KEEPS_IMAGES && /^https?:\/\//i.test(u || '') ? 'sealimg://img/?u=' + encodeURIComponent(u)
  : TV_IMAGES && /^https?:\/\//i.test(u || '') ? 'https://appassets.androidplatform.net/img/?u=' + encodeURIComponent(u) : u);
/* Windows: pictures looked up by title (Art below) remembered for this run, so a page drawn again
   shows them at once instead of initials -> asking -> swapping in. Also used instead of the
   provider's own picture: there's only one when that one was missing or broken. */
const artKey = a => `${a.kind}|${a.name}|${Number(a.year) || ''}`;
const artKnown = new Map();
/** <img> that falls back to initials (see the error listener below); art: { kind, name, year };
    fb: another picture to try first if this one doesn't load (an episode's still -> the series poster) */
/* a network's logo that comes with the app (main/networks.js: US local stations) sits on a light tile: several are black */
const pic = (src, name, cls = 'pi', art = null, fb = '') => (src = (art && artKnown.get(artKey(art))) || src || fb, fb = fb && fb !== src ? fb : '', src ? `<img class="${cls}${/^networks\//.test(src) ? ' net-logo' : ''}" loading="lazy" src="${esc(imgSrc(src))}" data-i="${esc(initials(name))}"${fb ? ` data-fb="${esc(imgSrc(fb))}"` : ''}${artAttrs(art)} alt="">` : `<span class="initials"${artAttrs(art)}>${esc(initials(name))}</span>`);
document.addEventListener('error', e => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
  if (t.tagName === 'IMG' && t.dataset.fb) { const fb = t.dataset.fb; delete t.dataset.fb; t.src = fb; return; }
  if (t.tagName === 'IMG' && t.dataset.i !== undefined) t.replaceWith(h(`<span class="initials"${artAttrs(t.dataset.ak && { kind: t.dataset.ak, name: t.dataset.an, year: t.dataset.ay })}>${esc(t.dataset.i)}</span>`));
}, true);
/* A kept picture (artwork.js) comes as a data: address of ~50 KB. A long grid never lets go of its
   cards, so it's shown as a blob: instead (a few bytes in the page), let go of once it's drawn: the
   picture then takes no more memory than one from the web. */
function artSrc(u) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(u || '');
  if (!m) return imgSrc(u);
  try {
    const bin = atob(m[2]), b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([b], { type: m[1] }));
  } catch { return u; }
}
document.addEventListener('load', e => { const t = e.target; if (t.tagName === 'IMG' && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src); }, true);

/* Posters the provider doesn't have (or whose link is broken): looked up by title — TVmaze,
   TMDB with a key — for the ones on screen, a batch at a time (artwork.js remembers them). */
const Art = (() => {
  const want = new Map();
  let timer = null, scanning = false;
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); queue(e.target); } }, { rootMargin: '400px' })
    : null;
  function queue(el) {
    want.set(el, { kind: el.dataset.ak, name: el.dataset.an, year: Number(el.dataset.ay) || 0 });
    clearTimeout(timer);
    timer = setTimeout(flush, 150);
  }
  async function flush() {
    const els = [...want.keys()].slice(0, 60);
    const list = els.map(el => want.get(el));
    for (const el of els) want.delete(el);
    if (want.size) timer = setTimeout(flush, 400);
    let urls;
    try { urls = await call('art:find', list); } catch { return; }
    urls.forEach((u, i) => {
      const el = els[i];
      if (u && KEEPS_IMAGES) artKnown.set(artKey(list[i]), u);
      if (u && el.isConnected) el.replaceWith(h(`<img class="pi" src="${esc(artSrc(u))}" data-i="${esc(el.textContent)}" alt="">`));
      keep(u);
    });
  }
  /* A picture found on the site (not one already kept: those come as data:): fetched once more
     (from the browser's cache, mostly) and handed to artwork.js to keep, so it isn't asked for again. */
  let keeping = Promise.resolve();
  const tried = new Set();
  function keep(u) {
    if (KEEPS_IMAGES || !u || !/^https:\/\//.test(u) || tried.has(u)) return;   // Windows keeps every picture anyway
    tried.add(u);
    keeping = keeping.then(() => new Promise(done => {
      const x = new XMLHttpRequest();
      x.open('GET', u);
      x.responseType = 'blob';
      x.timeout = 20000;
      x.onload = () => {
        if (x.status !== 200 || !/^image\//.test((x.response && x.response.type) || '')) return done();
        const r = new FileReader();
        r.onload = () => call('art:keep', u, r.result).catch(() => {}).then(done);
        r.onerror = done;
        r.readAsDataURL(x.response);
      };
      x.onerror = x.ontimeout = done;
      x.send();
    }));
  }
  function scan() {
    scanning = false;
    const a = state.settings && state.settings.artwork;
    if (!a || !a.lookup) return;
    for (const el of document.querySelectorAll('.initials[data-ak]:not([data-aq])')) { el.dataset.aq = '1'; if (io) io.observe(el); else queue(el); }
  }
  new MutationObserver(() => { if (!scanning) { scanning = true; requestAnimationFrame(scan); } }).observe(document.documentElement, { childList: true, subtree: true });
  return { scan, keep };
})();

const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
const fmtLeft = (pos, dur) => {
  if (!dur) return `at ${fmtTime(pos)}`;
  const m = Math.max(1, Math.round((dur - pos) / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
};
const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtClock = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const epLabel = (season, ep) => `S${season || 1} · E${ep || '?'}`;

/* =================================================================
 * 2. STATE + START-UP
 * ================================================================= */
const state = {
  version: '',
  settings: null,
  profiles: [],
  summary: null,
  vpn: null,
  dataDir: '',
  view: 'home',
  arg: null,
  history: [],
  q: '',
  sec: { live: { cat: '', sort: '' }, movies: { cat: '', sort: '' }, series: { cat: '', sort: '' } },
  live: { items: [], sel: null },
  refreshing: false,
  parental: { hasPin: false, unlocked: false, autoAdult: true, unlockMinutes: 0 },
  sync: { connected: false },
  lists: [],          // my own categories (lists:all): [{ id, name, icon, count }]
  listEdit: '',       // the category whose titles are being edited (renamed / taken out)
  listFocus: '',      // after a rename there: the title to put the focus back on
  hostname: ''
};
const profile = () => state.profiles.find(p => p.id === state.settings.activeProfile) || null;

async function start() {
  const r = await call('app:init');
  Object.assign(state, { version: r.version, settings: r.settings, profiles: r.profiles, summary: r.catalog, vpn: r.vpn, dataDir: r.dataDir, parental: r.parental, sync: r.sync, lists: r.lists || [], hostname: r.hostname });
  window.api.on('sync:applied', types => refreshAll(types).catch(() => {}));
  window.api.on('sync:status', s => { state.sync = s; if (state.view === 'settings') drawSyncPanel(); });
  updateLockBtn();
  window.api.on('vpn:status', onVpnStatus);
  window.api.on('catalog:step', t => { if (state.refreshing) { busyText(t); } });
  wireChrome();
  renderProfiles();
  renderMyNav();
  updateVpn();
  updateCounts();
  go('home', null, { push: false });
  if (profile() && r.stale) autoRefresh();
  window.api.on('update:progress', p => Upd.progress(p));
  if (window.__sealStarted) window.__sealStarted();   // Fire TV: these pages work (UpdateManager)
  if (state.settings.updates && state.settings.updates.check) setTimeout(() => Upd.check(false), 6000);
}

/** The start-up screen (index.html) fades away once Home is drawn. */
function endSplash() {
  const el = $('#splash');
  if (!el || el.classList.contains('gone')) return;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 400);
}

/** Reload the playlist on start-up when it's old — quietly, after the VPN check. */
async function autoRefresh() {
  try {
    if (state.settings.vpn.required) {
      const s = await call('vpn:check');
      onVpnStatus(s);
      if (!s.ok) { $('#refreshInfo').textContent = 'Playlist not updated: VPN is off'; return; }
    }
    await reload({ quiet: !!(state.summary && state.summary.fetchedAt) });
  } catch (e) { fail(e); }
}

/* =================================================================
 * 3. NAVIGATION, TOP BAR, SEARCH
 * ================================================================= */
const TITLES = { home: 'Home', live: 'Live TV', guide: 'TV Guide', movies: 'Movies', series: 'Series', favorites: 'Favorites', collections: 'Collections', collection: 'Collections', settings: 'Settings', search: 'Search', movie: 'Movies', show: 'Series' };

function go(view, arg = null, { push = true } = {}) {
  if (view === 'settings' && state.view !== 'settings' && settingsLocked()) {
    askPin(null, { why: 'Settings is locked.' }).then(ok => { if (ok) go(view, arg, { push }); }).catch(fail);
    return;
  }
  if (push && (state.view !== view || state.arg !== arg)) state.history.push({ view: state.view, arg: state.arg, focus: TV ? focusMark() : null });
  if (state.history.length > 50) state.history.shift();
  if (view !== state.view) state.favArrange = '';
  if (view !== state.view || arg !== state.arg) state.listEdit = '';
  state.view = view;
  state.arg = arg;
  render();
}

function back() {
  const prev = state.history.pop();
  if (prev) { state.view = prev.view; state.arg = prev.arg; render(); if (prev.focus) focusBack(prev.focus); }
}

/* TV: Back puts the focus on what it was on before (the poster you opened), scrolled to it.
   Remembered as its place among the page's focusable things, its text and the scroll. */
const FOCUSABLE_IN_VIEW = 'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]):not([type=hidden]), select:not([disabled]), a[href]';
function scrollerOf(el) {
  for (let p = el.parentElement; p && p.id !== 'view'; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
function focusMark() {
  const a = document.activeElement, view = $('#view');
  if (!a || !view.contains(a)) return null;
  const all = [...view.querySelectorAll(FOCUSABLE_IN_VIEW)];
  const sc = scrollerOf(a);
  return { idx: all.indexOf(a), text: a.textContent.trim().slice(0, 80), scroller: sc ? '.' + [...sc.classList].join('.') : '', top: sc ? sc.scrollTop : 0 };
}
function focusBack(m, tries = 0) {
  const view = $('#view');
  if (m.scroller && tries === 0) { const sc = view.querySelector(m.scroller); if (sc) sc.scrollTop = m.top; }   // also loads the rows that were there
  const all = [...view.querySelectorAll(FOCUSABLE_IN_VIEW)];
  // the same text nearest its old place (pages loaded since may have moved it a little), else the same place
  let el = null, best = Infinity;
  all.forEach((x, i) => { if (x.textContent.trim().slice(0, 80) === m.text && Math.abs(i - m.idx) < best) { best = Math.abs(i - m.idx); el = x; } });
  if (!el && tries >= 6) el = all[Math.min(m.idx, all.length - 1)];
  if (!el) { if (tries < 8) setTimeout(() => focusBack(m, tries + 1), 150 + tries * 100); return; }
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Re-draw part of a page, keeping the focus where it was in it (the remote's place: the same button). */
function keepFocus(box, draw) {
  const a = document.activeElement, all = () => [...box.querySelectorAll(FOCUSABLE_IN_VIEW)];
  const i = a && box.contains(a) ? all().indexOf(a) : -1;
  draw();
  if (i < 0) return;
  const now = all();
  const el = now[Math.min(i, now.length - 1)];
  if (el) el.focus({ preventScroll: true });
}

/* TV: a page drawn once it has loaded (a movie, a series) starts on its main button —
   unless the remote has already moved onto the page, or a dialog is up */
function tvStart(el) {
  if (!TV || !el || !el.isConnected) return;
  const a = document.activeElement;
  if (a && a !== document.body && $('#view').contains(a)) return;
  if (document.querySelector('#dlgModal:not(.hidden), #ctxMenu:not(.hidden), #tvPick')) return;
  el.focus({ preventScroll: true });
}

/** The sort list's first choice: what "no sort chosen" means right now. */
function sortDefaultLabel() {
  const sec = state.sec[state.view];
  return state.q ? 'Best match' : sec && sec.cat === '*fav' ? 'Favorites order' : 'Playlist order';
}

function render() {
  const v = state.view;
  $$('.nav').forEach(b => b.classList.toggle('active', (b.dataset.view === v && (v !== 'list' || b.dataset.arg === state.arg)) || (v === 'movie' && b.dataset.view === 'movies') || (v === 'show' && b.dataset.view === 'series') || (v === 'collection' && b.dataset.view === 'collections')));
  $('#viewTitle').textContent = v === 'list' ? ((listOf(state.arg) || {}).name || '') : TITLES[v] || '';
  const browse = ['live', 'movies', 'series'].includes(v);
  show($('#sortSel'), v === 'movies' || v === 'series');
  if (browse) $('#sortSel').value = state.sec[v].sort || '';
  $('#sortSel').options[0].textContent = sortDefaultLabel();
  show($('#search').parentElement, v !== 'settings');
  $('#search').placeholder = browse ? `Search ${TITLES[v]}` : 'Search channels, movies and series';
  updateHiddenSearchBtn();
  if (v !== 'search' && !browse && $('#search').value && document.activeElement !== $('#search')) $('#search').value = '';
  if (browse || v === 'search') $('#search').value = state.q;
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  if (!profile() && v !== 'settings') return renderWelcome(view);
  ({ home: renderHome, live: renderLive, guide: renderGuide, movies: renderBrowse, series: renderBrowse, favorites: renderFavorites, collections: renderCollections, collection: renderCollection, list: renderList, settings: renderSettings, search: renderSearch, movie: renderMovie, show: renderShow }[v] || renderHome)(view);
  if (TV && window.tvFocusFirst) window.tvFocusFirst();
}

/** Re-draw the current list without losing the focus in the search box. */
function renderKeepSearch() {
  const box = $('#search'), pos = box.selectionStart;
  render();
  box.focus();
  try { box.setSelectionRange(pos, pos); } catch { /* not a text box */ }
}

function wireChrome() {
  $$('.nav').forEach(b => b.onclick = () => { state.q = ''; $('#search').value = ''; go(b.dataset.view); });
  let t;
  $('#search').oninput = () => {
    clearTimeout(t);
    showRecent();
    t = setTimeout(() => {
      state.q = $('#search').value.trim();
      rememberSearch(state.q);
      if (['live', 'movies', 'series'].includes(state.view)) { $('#sortSel').options[0].textContent = sortDefaultLabel(); updateHiddenSearchBtn(); return renderKeepSearch(); }
      if (state.q) { if (state.view === 'search') render(); else go('search'); }
      else if (state.view === 'search') back();
    }, 250);
  };
  // recent searches: under the search box while it's empty and selected
  $('#search').addEventListener('focus', showRecent);
  $('#search').parentElement.addEventListener('focusout', () => setTimeout(() => { if (!$('#search').parentElement.contains(document.activeElement)) show($('#searchRecent'), false); }, 0));
  $('#sortSel').onchange = () => { state.sec[state.view].sort = $('#sortSel').value; render(); };
  $('#refreshBtn').onclick = () => reload().catch(fail);
  $('#profileSel').onchange = () => useProfile($('#profileSel').value);
  $('#hiddenSearchBtn').onclick = toggleHiddenSearch;
  $('#lockBtn').onclick = async () => { state.parental = await call('parental:lock'); afterLock(); toast(state.parental.lockSettings ? 'Locked categories and Settings are locked again.' : 'Locked categories are locked again.'); };
  document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) hideMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); }, true);
  $('#vpnPill').onclick = async () => {
    try { const s = await call('vpn:check'); onVpnStatus(s); if (!s.ok) vpnBlocked(s); else toast(s.title + (s.place ? ' · ' + s.place : '')); }
    catch (e) { fail(e); }
  };
  document.addEventListener('keydown', e => {
    if (!$('#player').classList.contains('hidden') || !$('#dlgModal').classList.contains('hidden')) return;
    if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) { e.preventDefault(); $('#search').focus(); $('#search').select(); }
    if ((e.key === 'Backspace' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) || (e.altKey && e.key === 'ArrowLeft')) { if (state.history.length) { e.preventDefault(); back(); } }
    if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; $('#search').oninput(); $('#search').blur(); }
  });
}

/* ---- recent searches (this device only) ---- */
const RECENT_KEY = 'seal.recentSearches';
const recentSearches = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(x => typeof x === 'string'); } catch { return []; } };
let recentTimer;
/** kept once the same search has stayed for a moment (not every letter typed) */
function rememberSearch(q) {
  clearTimeout(recentTimer);
  if (!q || q.length < 2) return;
  recentTimer = setTimeout(() => {
    if ($('#search').value.trim() !== q) return;
    const list = [q, ...recentSearches().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* not kept */ }
  }, 2000);
}
function showRecent() {
  const box = $('#searchRecent'), input = $('#search');
  const list = recentSearches();
  const on = !input.value && list.length && input.parentElement.contains(document.activeElement);
  show(box, !!on);
  if (!on) return;
  box.innerHTML = '<span class="faint small">Recent</span>';
  for (const q of list) {
    const b = h(`<button class="chip">${esc(q)}</button>`);
    b.onclick = () => { input.value = q; input.focus(); input.oninput(); };
    box.appendChild(b);
  }
  const clr = h('<button class="chip ghost">Clear</button>');
  clr.onclick = () => { try { localStorage.removeItem(RECENT_KEY); } catch { /* none */ } show(box, false); input.focus(); };
  box.appendChild(clr);
}

function renderProfiles() {
  const sel = $('#profileSel');
  sel.innerHTML = state.profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = state.settings.activeProfile || '';
  show(sel, state.profiles.length > 1);
  const p = profile();
  $('#profileName').textContent = p ? p.name : 'No playlist yet';
}

function updateCounts() {
  const c = state.summary && state.summary.counts;
  const f = n => (n ? n.toLocaleString() : '');
  $('#nLive').textContent = c ? f(c.live) : '';
  $('#nMovies').textContent = c ? f(c.movies) : '';
  $('#nSeries').textContent = c ? f(c.series) : '';
  const at = state.summary && state.summary.fetchedAt;
  $('#refreshInfo').textContent = at ? `Updated ${fmtDate(at)} ${fmtClock(at)}` : '';
  show($('#refreshBtn'), !!profile());
}

async function useProfile(id) {
  try {
    const r = await call('profiles:use', id);
    state.settings.activeProfile = id;
    state.summary = r.summary;
    state.sec = { live: { cat: '', sort: '' }, movies: { cat: '', sort: '' }, series: { cat: '', sort: '' } };
    state.history = [];
    state.lists = await call('lists:all').catch(() => []);
    renderProfiles(); renderMyNav(); updateCounts();
    go('home', null, { push: false });
    if (r.stale) autoRefresh();
  } catch (e) { fail(e); }
}

/** Infinite list: loads pages of fetchPage(offset) as the sentinel scrolls into view. */
function infinite(container, scroller, fetchPage, renderItem, empty) {
  const token = {};
  container._token = token;
  container.innerHTML = '';
  const sentinel = h('<div class="sentinel"></div>');
  container.appendChild(sentinel);
  const items = [];
  let offset = 0, total = Infinity, loading = false;
  // the first page taking a while (on a TV: a section of the playlist read the first time): say so
  const wait = h('<div class="empty">Loading…</div>');
  setTimeout(() => { if (!offset && loading && container._token === token) container.insertBefore(wait, sentinel); }, 300);
  const more = async () => {
    if (loading || offset >= total || container._token !== token) return;
    loading = true;
    try {
      const r = await fetchPage(offset);
      wait.remove();
      if (container._token !== token) return;
      total = r.total;
      const frag = document.createDocumentFragment();
      for (const it of r.items) { items.push(it); frag.appendChild(renderItem(it, items.length - 1)); }
      container.insertBefore(frag, sentinel);
      offset += r.items.length;
      if (!total) container.innerHTML = `<div class="empty">${empty}</div>`;
      if (!r.items.length) total = offset;
    } catch (e) { fail(e); total = 0; }
    finally { loading = false; }
    if (offset < total && sentinel.isConnected && sentinel.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom + 800) more();
  };
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: scroller, rootMargin: '900px' });
  io.observe(sentinel);
  more();
  return items;
}

/* =================================================================
 * 4. VPN STATUS
 * ================================================================= */
function onVpnStatus(s) {
  const wasOk = state.vpn && state.vpn.ok;
  state.vpn = s;
  updateVpn();
  if (s.required && !s.ok && typeof Player !== 'undefined' && Player.isOpen()) {
    Player.close('vpn');
    vpnBlocked(s);
  }
  // posters / logos were blocked while the VPN was off: show them now
  if (s.ok && wasOk === false && ['home', 'live', 'movies', 'series', 'favorites', 'collections', 'collection', 'movie', 'show'].includes(state.view) && $('#player').classList.contains('hidden')) render();
  if (state.view === 'settings') updateVpnBox();
}

function updateVpn() {
  const s = state.vpn, pill = $('#vpnPill');
  show(pill, !!(s && s.required));
  if (!s || !s.required) return;
  pill.classList.toggle('ok', s.ok);
  pill.classList.toggle('bad', !s.ok && s.state !== 'unknown');
  pill.querySelector('.txt').textContent = s.ok ? (s.place ? `VPN on · ${s.place}` : 'VPN on') : s.title;
  pill.title = `${s.title}${s.detail ? '\n' + s.detail : ''}\nClick to check again.`;
}

/** "VPN required" — shown instead of playing. */
async function vpnBlocked(s) {
  if (!$('#dlgModal').classList.contains('hidden')) return;
  s = s || state.vpn || {};
  const proton = (state.settings.vpn.provider === 'proton');
  const r = await dialog({
    title: 'VPN required',
    okText: 'OK', hideCancel: true, extraText: 'Check again',
    html: `<div class="vpn-block"><div class="shield">🛡️</div><div>
      <p><b>${esc(s.title || 'VPN is off')}</b></p>
      <p class="muted">${esc(s.detail || 'Connect your VPN, then try again.')}</p>
      <p class="small faint">Seal IPTV doesn't contact your IPTV provider while the VPN is off (Settings → VPN).</p>
      ${proton ? '<button class="btn" id="openProton">Open ProtonVPN</button>' : ''}</div></div>`,
    onOpen: () => { const b = $('#openProton'); if (b) b.onclick = () => call('vpn:openProton').then(() => toast('Opening ProtonVPN…')).catch(fail); }
  });
  if (r === 'extra') {
    const n = await call('vpn:check').catch(() => null);
    if (n) { onVpnStatus(n); if (n.ok) toast(`${n.title}${n.place ? ' · ' + n.place : ''}. You can play now.`); else vpnBlocked(n); }
  }
}

/* =================================================================
 * 4b. PARENTAL PIN, CATEGORY MENU
 * ================================================================= */
/** After locking: lists go back to "All", and a locked movie / series page is left. */
function afterLock() {
  updateLockBtn();
  for (const k of Object.keys(state.sec)) state.sec[k].cat = '';
  if (state.view === 'movie' || state.view === 'show') { state.history = []; return go('home', null, { push: false }); }
  if (state.view === 'settings' && settingsLocked()) { state.history = []; return go('home', null, { push: false }); }
  if ($('#player').classList.contains('hidden') && state.view !== 'settings') render();
}

function updateLockBtn() {
  const p = state.parental || {};
  show($('#lockBtn'), !!(p.hasPin && (p.unlocked || p.searchHidden)));
  $('#lockBtn .txt').textContent = p.unlocked ? 'Locked categories open · Lock' : 'Hidden categories in search · Lock';
  updateHiddenSearchBtn();
}

/* ---- "Include hidden" in search (parental PIN; ends with Lock or the "keep open" time) ---- */
function updateHiddenSearchBtn() {
  const b = $('#hiddenSearchBtn');
  if (!b) return;
  show(b, !!state.q && ['live', 'movies', 'series', 'search'].includes(state.view));
  const on = !!(state.parental && state.parental.searchHidden);
  b.classList.toggle('on', on);
  b.textContent = on ? '🙈 Hidden included · Stop' : '🙈 Include hidden';
}

/** A PIN prompt that runs fn(pin) — without opening the locked categories. */
function pinPrompt(why, fn) {
  return dialog({
    title: 'Parental PIN', okText: 'OK',
    html: `<p>${esc(why)}</p><input type="password" id="pinIn" class="pin-input" inputmode="numeric" maxlength="8" autocomplete="off"><p id="pinErr" class="error center"></p>`,
    onOk: async () => {
      try { return (await fn($('#pinIn').value)) || true; }
      catch (e) { $('#pinErr').textContent = e.message; $('#pinIn').select(); return false; }
    }
  });
}

async function toggleHiddenSearch() {
  try {
    if (state.parental.searchHidden) {
      state.parental = await call('parental:searchHidden', false);
      toast('Hidden categories are left out of search again.');
    } else {
      if (!state.parental.hasPin && !(await setPinDialog())) return;
      let s;
      try { s = await call('parental:searchHidden', true); }
      catch (e) {
        if (e.code !== 'PIN_NEEDED') throw e;
        s = await pinPrompt('Search hidden categories too? Enter the parental PIN.', pin => call('parental:searchHidden', true, pin));
        if (!s) return;
      }
      state.parental = s;
      toast(s.searchUntil ? `Search includes hidden categories until ${fmtClock(s.searchUntil)}.` : 'Search includes hidden categories until you lock or close Seal IPTV.');
    }
    updateLockBtn();
    if (state.view === 'search') render(); else renderKeepSearch();
  } catch (e) { fail(e); }
}

/** After another PC changed something: reload what the window shows. */
async function refreshAll(types = []) {
  const r = await call('app:init');
  Object.assign(state, { settings: r.settings, profiles: r.profiles, summary: r.catalog, parental: r.parental, sync: r.sync, lists: r.lists || [] });
  renderProfiles(); renderMyNav(); updateCounts(); updateLockBtn(); updateVpn();
  // a playlist that came from another PC: download its channels here
  if (profile() && state.summary && !state.summary.fetchedAt && !state.refreshing) autoRefresh();
  if (!$('#player').classList.contains('hidden') || !$('#dlgModal').classList.contains('hidden')) return;
  if (state.view === 'settings') {
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    return render();
  }
  // resume points alone don't change the lists; everything else (or pages that show them) is drawn again
  const onlyPos = types.length && types.every(t => t === 'pos');
  if (!onlyPos || ['home', 'movie', 'show', 'favorites', 'collection', 'list'].includes(state.view)) render();
}
// the PIN may run out (Settings → "Stay unlocked"): check now and then
setInterval(async () => {
  if (!state.parental || !(state.parental.unlocked || state.parental.searchHidden)) return;
  try {
    const s = await call('parental:status');
    const ended = (state.parental.unlocked && !s.unlocked) || (state.parental.searchHidden && !s.searchHidden);
    state.parental = s;
    if (ended) { if (!s.unlocked) afterLock(); else { updateLockBtn(); render(); } }
  } catch { /* later */ }
}, 30000);

/** Settings → Parental controls → "Ask for the PIN to open Settings", and it's locked now. */
const settingsLocked = () => !!(state.parental && state.parental.hasPin && state.parental.lockSettings && !state.parental.unlocked);

/** Ask for the PIN (or to create one, if there's none yet). Resolves true when unlocked. */
async function askPin(locked, { why } = {}) {
  if (!state.parental.hasPin) {
    const go = await dialog({ title: 'Parental PIN', okText: 'Set a PIN', html: `<p><b>${esc((locked && locked.name) || 'This')}</b> is locked by parental controls.</p><p class="muted small">Choose a PIN first. It will be needed to open locked categories and to change parental settings.</p>` });
    return go ? setPinDialog() : false;
  }
  const r = await dialog({
    title: 'Parental PIN', okText: 'Unlock',
    html: `<p>${why ? esc(why) : `<b>${esc((locked && locked.name) || 'This')}</b> is locked.`} Enter the parental PIN.</p>
      <input type="password" id="pinIn" class="pin-input" inputmode="numeric" maxlength="8" autocomplete="off"><p id="pinErr" class="error center"></p>`,
    onOk: async () => {
      try { state.parental = await call('parental:unlock', $('#pinIn').value); updateLockBtn(); return true; }
      catch (e) { $('#pinErr').textContent = e.message; $('#pinIn').select(); return false; }
    }
  });
  return !!r;
}

async function setPinDialog() {
  const change = state.parental.hasPin;
  const r = await dialog({
    title: change ? 'Change the parental PIN' : 'Set a parental PIN', okText: 'Save PIN',
    html: `${change ? '<label for="pinOld">Current PIN</label><input type="password" id="pinOld" class="pin-input" inputmode="numeric" maxlength="8">' : ''}
      <label for="pinNew">New PIN (4 to 8 digits)</label><input type="password" id="pinNew" class="pin-input" inputmode="numeric" maxlength="8">
      <label for="pinNew2">New PIN again</label><input type="password" id="pinNew2" class="pin-input" inputmode="numeric" maxlength="8">
      <p class="muted small">Write it down somewhere safe. If you forget it, the only way back is to reinstall Seal IPTV and delete its settings.</p><p id="pinErr" class="error"></p>`,
    onOk: async () => {
      const n = $('#pinNew').value;
      if (n !== $('#pinNew2').value) { $('#pinErr').textContent = 'The two new PINs are different.'; return false; }
      try { state.parental = await call('parental:setPin', n, change ? $('#pinOld').value : undefined); updateLockBtn(); return true; }
      catch (e) { $('#pinErr').textContent = e.message; return false; }
    }
  });
  if (r) toast(change ? 'Parental PIN changed.' : 'Parental PIN set. Locked categories are open until you lock them or close Seal IPTV.');
  return !!r;
}

/** Run a parental change; if the PIN is needed, ask and try again. */
async function withPin(fn, why) {
  try { return await fn(); }
  catch (e) {
    if (e.code !== 'PIN_NEEDED') throw e;
    if (!(await askPin(null, { why: why || 'Changing parental settings needs the PIN.' }))) return undefined;
    return fn();
  }
}

/** Small right-click menu: items [{ label, run }] or '-' */
function showMenu(ev, items) {
  const m = $('#ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(h('<div class="sep"></div>')); continue; }
    const b = h(`<button>${esc(it.label)}</button>`);
    b.onclick = () => { hideMenu(); it.run(); };
    m.appendChild(b);
  }
  show(m, true);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + 'px';
}
function hideMenu() { show($('#ctxMenu'), false); }

/** Hide / lock one category (category list right-click, Settings → Categories). */
async function setCatFlag(section, c, patch) {
  try {
    const r = await withPin(() => call('cats:flag', section, c.id, patch), 'Locking or unlocking a category needs the parental PIN.');
    return r !== undefined;
  } catch (e) { fail(e); return false; }
}

function catMenu(ev, section, c) {
  const autoAdult = state.parental.autoAdult !== false;
  const items = [{ label: '🙈 Hide this category', run: async () => { if (await setCatFlag(section, c, { hide: true })) { toast(`"${c.name}" is hidden. Show it again in Settings → Categories.`); if (state.sec[section].cat === c.id) state.sec[section].cat = ''; render(); } } }];
  if (c.locked) items.push({ label: '🔓 Remove the PIN lock', run: async () => { if (await setCatFlag(section, c, { lock: c.adult && autoAdult ? false : null })) { toast(`"${c.name}" no longer needs the PIN.`); render(); } } });
  else items.push({ label: '🔒 Lock with the parental PIN', run: async () => {
    if (!state.parental.hasPin && !(await setPinDialog())) return;
    if (await setCatFlag(section, c, { lock: c.adult && autoAdult ? null : true })) { toast(`"${c.name}" now needs the parental PIN.`); render(); }
  } });
  items.push('-', { label: '⚙️ All categories…', run: () => { state.catTab = section; state.setSec = 'categories'; go('settings'); } });
  showMenu(ev, items);
}

/* =================================================================
 * 5. HOME
 * ================================================================= */
function renderWelcome(view) {
  view.appendChild(h(`<div class="welcome">
    <img src="logo.svg" alt="">
    <h1>Welcome to Seal IPTV</h1>
    <p class="muted">Add the playlist from your IPTV provider: an <b>Xtream Codes</b> login (server, username and password) or an <b>M3U</b> playlist link or file. Seal IPTV doesn't come with any channels of its own.</p>
    <button class="btn primary big" id="wAdd">Add a playlist</button>
    <p class="small faint">Want it to play only through ProtonVPN or another VPN? Turn that on in Settings → VPN.</p>
  </div>`));
  $('#wAdd').onclick = () => editProfile(null);
}

function shelf(title, items, makeCard, { wide = false, more } = {}) {
  const el = h(`<div class="shelf"><div class="shelf-head"><h2>${esc(title)}</h2>${more ? '<button class="btn ghost small">See all</button>' : ''}</div><div class="shelf-row${wide ? ' wide' : ''}"></div></div>`);
  const row = el.querySelector('.shelf-row');
  items.forEach(it => row.appendChild(makeCard(it)));
  if (more) el.querySelector('.btn').onclick = more;
  return el;
}

async function renderHome(view) {
  const home = h('<div class="home"></div>');
  view.appendChild(home);
  const sum = state.summary || {};
  const c = sum.counts || { live: 0, movies: 0, series: 0 };
  if (!sum.fetchedAt) {
    home.appendChild(h(`<div class="welcome"><img src="logo.svg" alt=""><h1>Load your playlist</h1>
      <p class="muted">Seal IPTV hasn't loaded <b>${esc(profile().name)}</b> yet.</p><button class="btn primary big" id="hLoad">⟳ Load the playlist</button></div>`));
    $('#hLoad').onclick = () => reload().catch(fail);
    return;
  }
  // the counts and the account are in Settings → About; Home starts with something to watch
  const top = h('<div class="spot-slot"></div>');
  home.appendChild(top);

  const [cont, favLive, favMovies, favSeries, newMovies, newSeries] = await Promise.all([
    call('lib:continue'), call('lib:favorites', 'live'), call('lib:favorites', 'movie'), call('lib:favorites', 'series'),
    call('catalog:recent', 'movies', { homeSafe: true }), call('catalog:recent', 'series', { homeSafe: true })
  ].map(p => p.catch(() => [])));
  const mine = await Promise.all(state.lists.map(l => call('lists:items', l.id).catch(() => [])));
  if (!home.isConnected) return;
  // the spotlight: what you were watching, else the newest movie
  const spot = cont[0] ? spotlight(cont[0]) : newMovies.find(m => m.poster) ? spotlight(null, newMovies.find(m => m.poster)) : null;
  if (spot) top.appendChild(spot);
  if (cont.length > 1) home.appendChild(shelf('Continue watching', cont.slice(1), continueCard, { wide: true }));
  // what's popular on the streaming services, the titles this playlist has (filled in when they're in)
  const trend = h('<div class="trend-slot"></div>');
  home.appendChild(trend);
  if ((state.settings.artwork || {}).trending !== false) {
    call('trending:home').then(t => {
      if (!trend.isConnected || !t) return;
      if (t.movies.length) trend.appendChild(shelf('🔥 Trending movies', t.movies, posterCard));
      if (t.series.length) trend.appendChild(shelf('🔥 Trending series', t.series, posterCard));
    }).catch(() => { /* no trending today */ });
  }
  if (favLive.length) home.appendChild(shelf('Favorite channels', favLive.slice(0, 30), f => channelCard({ id: f.id, name: f.name, logo: f.image, fav: true }), { more: () => { state.sec.live.cat = '*fav'; go('live'); } }));
  state.lists.forEach((l, i) => { if (mine[i].length) home.appendChild(shelf(`${l.icon || LIST_ICONS[0]} ${l.name}`, mine[i].slice(0, 30), listCard, { more: () => go('list', l.id) })); });
  if (favMovies.length) home.appendChild(shelf('Favorite movies', favMovies.slice(0, 30), f => posterCard({ kind: 'movie', id: f.id, name: f.name, poster: f.image, fav: true }), { more: () => { state.sec.movies.cat = '*fav'; go('movies'); } }));
  if (favSeries.length) home.appendChild(shelf('Favorite series', favSeries.slice(0, 30), f => posterCard({ kind: 'series', id: f.id, name: f.name, poster: f.image, fav: true }), { more: () => { state.sec.series.cat = '*fav'; go('series'); } }));
  if (newMovies.length) home.appendChild(shelf('Recently added movies', newMovies, posterCard, { more: () => { state.sec.movies.sort = 'added'; state.sec.movies.cat = ''; go('movies'); } }));
  if (newSeries.length) home.appendChild(shelf('Recently added series', newSeries, posterCard, { more: () => { state.sec.series.sort = 'added'; state.sec.series.cat = ''; go('series'); } }));
  if (!cont.length && !favLive.length && !favMovies.length && !favSeries.length) {
    home.appendChild(h('<p class="muted" style="padding:10px 22px">Tip: click ☆ on a channel, movie or series to keep it on this page. Movies and episodes you start show up here so you can pick up where you left off.</p>'));
  }
}

/** The big panel at the top of Home: picture, title, where you are, ▶ Resume / Play and More info. */
function spotlight(p, movie) {
  const it = p || { kind: 'movie', id: movie.id, name: movie.name, image: movie.poster, year: movie.year, rating: movie.rating };
  const ep = it.kind === 'episode';
  const title = ep ? (it.seriesName || it.name) : it.name;
  const pct = p && p.dur ? Math.min(100, Math.max(2, (p.pos / p.dur) * 100)) : 0;
  const line = p ? (ep ? `${epLabel(p.season, p.episode)} · ${esc(p.name || '')} · ${fmtLeft(p.pos, p.dur)}` : fmtLeft(p.pos, p.dur))
    : ['New in your playlist', movie.year || '', movie.rating ? `★ ${movie.rating}` : ''].filter(Boolean).join(' · ');
  const el = h(`<section class="spotlight">
    <div class="spot-bg">${pic(it.image || it.poster, title, 'pi', null, it.poster)}</div>
    <div class="spot-poster">${pic(it.poster || it.image, title, 'pi', null, it.image)}</div>
    <div class="spot-body">
      <div class="spot-kicker">${p ? 'Continue watching' : 'Recently added'}</div>
      <h2>${esc(title)}</h2>
      <div class="spot-line">${p ? line : esc(line)}</div>
      ${pct ? `<div class="bar spot-bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
      <div class="spot-actions"><button class="btn primary big" data-a="play">▶ ${p ? 'Resume' : 'Play'}</button><button class="btn big" data-a="info">More info</button></div>
    </div></section>`);
  el.querySelector('[data-a=play]').onclick = () => p ? resumeFromHome(p) : Player.play({ kind: 'movie', id: movie.id, name: movie.name, image: movie.poster, ext: movie.ext });
  el.querySelector('[data-a=info]').onclick = () => ep ? (it.seriesId ? go('show', it.seriesId) : resumeFromHome(p)) : go('movie', it.id);
  return el;
}

function continueCard(p) {
  const name = p.kind === 'episode' ? (p.seriesName || p.name) : p.name;
  const sub = p.kind === 'episode' ? `${epLabel(p.season, p.episode)} · ${fmtLeft(p.pos, p.dur)}` : fmtLeft(p.pos, p.dur);
  const el = posterCard({ name, poster: p.image || p.poster, fb: p.poster, pos: p.pos, dur: p.dur, sub }, { wide: true, onClick: () => resumeFromHome(p) });
  return el;
}

async function resumeFromHome(p) {
  if (p.kind === 'movie') return Player.play({ kind: 'movie', id: p.id, name: p.name, image: p.image, ext: p.ext });
  let queue = null;
  if (p.seriesId) {
    try {
      const d = await call('details:series', p.seriesId);
      queue = episodeQueue(d);
    } catch { /* play just this one */ }
  }
  const req = { kind: 'episode', id: p.id, name: p.name, image: p.image, ext: p.ext, seriesId: p.seriesId, seriesName: p.seriesName, season: p.season, episode: p.episode };
  Player.play(queue ? queue.find(q => q.id === p.id) || req : req, { queue });
}

/* =================================================================
 * 6. LIVE TV
 * ================================================================= */
function catList(section, el, onPick) {
  return call('catalog:cats', section).then(r => {
    const cur = state.sec[section].cat;
    const all = [{ id: '', name: 'All', count: r.total }, { id: '*fav', name: '⭐ Favorites', count: null }, ...r.cats];
    el.innerHTML = '';
    for (const c of all) {
      const lock = c.locked ? `<span class="lock" title="${c.open ? 'Locked with the PIN — open now' : 'Locked with the parental PIN'}">${c.open ? '🔓' : '🔒'}</span>` : '';
      const b = h(`<button class="cat${c.id === cur ? ' active' : ''}">${lock}<span class="name">${esc(c.name)}</span><span class="n">${c.count != null ? c.count.toLocaleString() : ''}</span></button>`);
      b.title = c.name;
      b.onclick = async () => {
        if (c.locked && !c.open && !(await askPin({ name: c.name }))) return;
        state.sec[section].cat = c.id;
        if (c.locked && !c.open) return render();
        el.querySelectorAll('.cat').forEach(x => x.classList.remove('active')); b.classList.add('active'); onPick();
      };
      if (!c.id.startsWith('*')) b.oncontextmenu = e => { e.preventDefault(); catMenu(e, section, c); };
      el.appendChild(b);
    }
  }).catch(fail);
}

function renderLive(view) {
  view.appendChild(h('<div class="cats" id="cats"></div>'));
  view.appendChild(h('<div class="channels" id="chList"></div>'));
  view.appendChild(h(`<div class="live-info" id="liveInfo"><div class="empty">Choose a channel to see what's on.${TV ? '' : '<br><span class="small faint">Double-click or press Enter to watch.</span>'}</div></div>`));
  const list = $('#chList');
  const load = () => {
    state.live.items = infinite(list, list,
      offset => call('catalog:list', { section: 'live', cat: state.sec.live.cat, q: state.q, offset, limit: 150 }),
      (it, i) => channelRow(it, i),
      state.sec.live.cat === '*fav' ? 'No favorite channels yet. Click ☆ next to a channel.' : state.q ? 'No channels match your search.' : 'No channels here.');
  };
  catList('live', $('#cats'), load);
  load();
}

function channelRow(it, i) {
  const el = h(`<div class="channel" tabindex="0">
    <span class="num">${it.num || ''}</span>
    <span class="logo">${pic(it.logo, it.name)}</span>
    <span class="name" title="${esc(it.name)}">${esc(it.name)}</span>${it.fromHidden ? '<span class="tag" title="From a category you\'ve hidden">hidden category</span>' : ''}
    <button class="star${it.fav ? ' on' : ''}" title="Favorite">${it.fav ? '★' : '☆'}</button>
  </div>`);
  el.onclick = () => selectChannel(it, el);
  el.ondblclick = () => playChannel(i);
  // the remote's OK (tvnav.js): watch it — moving onto a channel already shows what's on
  el.tvOk = () => { if (state.live.sel !== it) selectChannel(it, el); playChannel(i); };
  el.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); playChannel(i); }   // (not pressed again by tvnav.js)
    if (e.key === 'ArrowDown' && el.nextElementSibling && el.nextElementSibling.classList.contains('channel')) { e.preventDefault(); el.nextElementSibling.focus(); el.nextElementSibling.click(); }
    if (e.key === 'ArrowUp' && el.previousElementSibling) { e.preventDefault(); el.previousElementSibling.focus(); el.previousElementSibling.click(); }
  };
  el.querySelector('.star').onclick = async e => {
    e.stopPropagation();
    await toggleFav(it, 'live', { name: it.name, image: it.logo, cat: it.cat });
    e.target.classList.toggle('on', it.fav);
    e.target.textContent = it.fav ? '★' : '☆';
    if (state.live.sel === it) selectChannel(it, el);
  };
  el.oncontextmenu = e => { e.preventDefault(); cardMenu(e, 'live', { id: it.id, name: it.name, image: it.logo, cat: it.cat }); };
  return el;
}

function playChannel(i) {
  const list = state.live.items;
  const it = list[i];
  if (!it) return;
  Player.play({ kind: 'live', id: it.id, name: it.name, image: it.logo, cat: it.catName }, { channels: list, index: i, list: { cat: state.sec.live.cat, q: state.q } });
}

async function selectChannel(it, el) {
  $$('#chList .channel.active').forEach(x => x.classList.remove('active'));
  el.classList.add('active');
  state.live.sel = it;
  const box = $('#liveInfo');
  const i = state.live.items.indexOf(it);
  box.innerHTML = `<div class="big-logo">${pic(it.logo, it.name)}</div>
    <h2 style="font-size:18px">${esc(it.name)}</h2><p class="muted small">${esc(it.catName || '')}</p>
    <div class="actions"><button class="btn primary" id="liPlay">▶ Watch</button><button class="btn" id="liFav">${it.fav ? '★ Favorite' : '☆ Favorite'}</button><button class="btn" id="liList" title="Put it in one of your own categories">＋ Category</button><button class="btn ghost" id="liVlc" title="${OTHER_PLAYER}">${TV ? 'Other app' : 'VLC'}</button></div>
    <div id="liEpg"><p class="muted small">Loading what's on…</p></div>`;
  $('#liPlay').onclick = () => playChannel(i);
  $('#liVlc').onclick = () => openExternal({ kind: 'live', id: it.id, title: it.name });
  $('#liList').onclick = () => pickLists('live:' + it.id, { name: it.name, image: it.logo, cat: it.cat });
  $('#liFav').onclick = async () => {
    await toggleFav(it, 'live', { name: it.name, image: it.logo, cat: it.cat });
    $('#liFav').textContent = it.fav ? '★ Favorite' : '☆ Favorite';
    const star = el.querySelector('.star'); star.classList.toggle('on', it.fav); star.textContent = it.fav ? '★' : '☆';
  };
  let epg = [];
  try { epg = await call('epg:short', it.id); } catch (e) { if (e.code === 'VPN') { $('#liEpg').innerHTML = '<p class="muted small">🛡️ The programme guide needs the VPN.</p>'; return; } }
  if (state.live.sel !== it) return;
  const now = Date.now();
  $('#liEpg').innerHTML = epg.length ? epg.map(e => `<div class="epg-item${e.start <= now && now < e.end ? ' now' : ''}">
      <div class="small muted">${e.start ? esc(fmtClock(e.start)) + ' – ' + esc(fmtClock(e.end)) : ''}</div>
      <div class="t">${esc(e.title)}</div>${e.desc ? `<div class="small muted">${esc(e.desc.slice(0, 260))}</div>` : ''}</div>`).join('')
    : '<p class="muted small">No programme guide for this channel.</p>';
}

/** Small card for a channel (Home, Favorites). */
function channelCard(it) {
  const el = h(`<div class="card wide" tabindex="0"><div class="poster" style="aspect-ratio:16/9;padding:14px">${pic(it.logo, it.name, 'pi logo-img')}${it.fav ? '<span class="badge fav">★</span>' : ''}${it.fromHidden ? '<span class="badge hid">Hidden category</span>' : ''}</div><div class="title">${esc(it.name)}</div></div>`);
  const img = el.querySelector('img');
  if (img) img.style.objectFit = 'contain';
  // the channels next to it (a Home shelf, Favorites, one of my categories) are the player's channel list
  el._ch = it;
  el.onclick = () => {
    const near = el.parentElement ? [...el.parentElement.children].map(x => x._ch).filter(Boolean) : [it];
    Player.play({ kind: 'live', id: it.id, name: it.name, image: it.logo }, { channels: near, index: Math.max(0, near.indexOf(it)) });
  };
  el.oncontextmenu = e => { e.preventDefault(); cardMenu(e, 'live', { id: it.id, name: it.name, image: it.logo }); };
  return el;
}

async function toggleFav(it, kind, meta) {
  try {
    it.fav = await call('lib:favorite', `${kind}:${it.id}`, !it.fav, meta);
    toast(it.fav ? `Added "${it.name}" to your favorites.` : `Removed "${it.name}" from your favorites.`);
  } catch (e) { fail(e); }
}

/* =================================================================
 * 6b. TV GUIDE — channels down the side, time across, favorites first
 * (the full guide, catalog.js / guide.js; a channel it hasn't got: the provider's own listings)
 * ================================================================= */
const GUIDE_HOURS = 12;
function renderGuide(view) {
  const ppm = TV ? 4 : 5;                                                   // pixels a minute
  const t0 = Math.floor((Date.now() - 30 * 60000) / 1800000) * 1800000;    // from the half hour before now
  const end = t0 + GUIDE_HOURS * 3600000;
  const x = ms => Math.max(0, Math.round((ms - t0) / 60000 * ppm));
  const width = x(end);
  const g = state.guide || (state.guide = { cat: null });
  let marks = '';
  for (let t = t0; t < end; t += 1800000) marks += `<span style="left:${x(t)}px">${esc(fmtClock(t))}</span>`;
  // (the choice of channels comes after the grid in the page, so the remote starts on the first channel; shown on top)
  const page = h(`<div class="guide">
    <div class="g-scroll" id="gScroll"><div class="g-grid" style="width:calc(var(--g-ch) + ${width}px)">
      <div class="g-times"><div class="g-corner"></div><div class="g-marks" style="width:${width}px">${marks}</div></div>
      <div id="gRows"></div>
      <div class="g-now" id="gNow"></div>
    </div></div>
    <div class="g-top"><div class="g-info" id="gInfo"><p class="muted small">Loading the TV guide…</p></div>
      <div class="g-pick"><label for="gCat" class="small muted">Channels</label><select id="gCat" disabled></select></div></div></div>`);
  view.appendChild(page);
  const scroller = $('#gScroll'), rows = $('#gRows'), info = $('#gInfo');
  const tick = () => {
    if (!page.isConnected) return clearInterval(timer);
    $('#gNow').style.left = `calc(var(--g-ch) + ${x(Date.now())}px)`;
    const a = document.activeElement, row = a && rows.contains(a) && a.closest('.g-row');
    if (row) showInfo(row, a._e);   // "Starts in 1 min" -> "On now"
  };
  const timer = setInterval(tick, 60000);
  tick();

  let items = [], vpnOff = false;
  const play = row => Player.play({ kind: 'live', id: row._ch.id, name: row._ch.name, image: row._ch.logo, cat: row._ch.catName }, { channels: items, index: row._i, list: { cat: g.cat, q: '' } });

  // what's selected, above the grid
  const showInfo = (row, e) => {
    const it = row._ch;
    if (!e) e = (row._list || []).find(p => p.start <= Date.now()) || null;
    if (!e) { info.innerHTML = `<h3>${esc(it.name)}</h3><p class="small muted">${vpnOff ? '🛡️ The TV guide needs the VPN.' : row._list ? 'No guide for this channel.' : 'Loading what\'s on…'}</p>`; return; }
    const now = Date.now(), on = e.start <= now && now < e.end;
    const mins = Math.max(1, Math.round(((on ? e.end : e.start) - now) / 60000));
    const span = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60 ? (mins % 60) + ' min' : ''}`.trim() : `${mins} min`;
    const when = on ? `<b class="g-live">On now</b> · ${span} left` : `Starts in ${span}`;
    info.innerHTML = `<div class="small muted">${esc(fmtClock(e.start))} – ${esc(fmtClock(e.end))} · ${when}</div>
      <h3>${esc(e.title)}</h3>${e.desc ? `<p class="small muted g-desc">${esc(e.desc)}</p>` : ''}<div class="small faint">${esc(it.name)}</div>`;
  };

  // a row's programmes (keeps the focus at the same time of day when they replace "…")
  const fill = (row, list) => {
    row._list = list;
    const box = row.querySelector('.g-progs');
    const a = document.activeElement, had = a && box.contains(a) ? a.getBoundingClientRect() : null;
    box.innerHTML = '';
    const now = Date.now();
    for (const e of list) {
      if (e.end <= t0 || e.start >= end) continue;
      const l = x(e.start), w = Math.max(4, x(e.end) - l - 3);
      // a programme of a few minutes: only a sliver (the info above says what it is)
      const c = h(`<div class="g-p${e.start <= now && now < e.end ? ' now' : ''}${w < 44 ? ' tiny' : ''}" tabindex="0" style="left:${l}px;width:${w}px">${w < 44 ? '' : `<span class="t">${esc(e.title)}</span><span class="s">${esc(fmtClock(e.start))}</span>`}</div>`);
      c._e = e;
      box.appendChild(c);
    }
    if (!box.firstChild) box.appendChild(h(`<div class="g-p none" tabindex="0" style="left:0;width:${width - 3}px"><span class="t">${vpnOff ? '🛡️ The TV guide needs the VPN' : 'No guide for this channel'}</span></div>`));
    if (had) {
      const mid = had.left + Math.min(had.width, 200) / 2;
      const cells = [...box.children];
      const to = cells.find(c => { const r = c.getBoundingClientRect(); return r.left <= mid && mid < r.right; }) || cells[0];
      to.focus({ preventScroll: true });
      showInfo(row, to._e);
    } else if (a && row.contains(a)) showInfo(row);   // on the channel's name: what's on now
  };

  // the rows near the screen ask for their programmes, a few channels at a time
  const want = new Set();
  let soon = null;
  const ask = () => {
    soon = null;
    const batch = [...want].slice(0, 20);
    batch.forEach(r => want.delete(r));
    if (!batch.length || !page.isConnected) return;
    call('epg:grid', batch.map(r => r._ch.id)).then(map => {
      for (const r of batch) fill(r, (map && map[r._ch.id]) || []);
    }).catch(e => {
      if (e.code === 'VPN') vpnOff = true;
      for (const r of batch) fill(r, []);
    }).finally(() => { if (want.size && !soon) soon = setTimeout(ask, 50); });
  };
  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting && !e.target._asked) { e.target._asked = true; want.add(e.target); io.unobserve(e.target); }
    if (want.size && !soon) soon = setTimeout(ask, 120);
  }, { root: scroller, rootMargin: '300px 0px' });

  const rowOf = (it, i) => {
    const row = h(`<div class="g-row"><div class="g-ch" tabindex="0"><span class="num">${it.num || ''}</span><span class="logo">${pic(it.logo, it.name)}</span><span class="name">${esc(it.name)}</span></div>
      <div class="g-progs" style="width:${width}px"><div class="g-p wait" tabindex="0" style="left:0;width:${width - 3}px"><span class="t faint">…</span></div></div></div>`);
    row._ch = it; row._i = i;
    row.firstChild.title = it.name;
    io.observe(row);
    return row;
  };

  // OK / Enter / a double-click on a channel or a programme: watch the channel; ☰ / right-click: its menu
  rows.addEventListener('focusin', e => { const row = e.target.closest('.g-row'); if (row) showInfo(row, e.target._e); });
  rows.addEventListener('click', e => { const row = e.target.closest('.g-row'); if (row && (TV || e.target.closest('.g-ch'))) play(row); });
  rows.addEventListener('dblclick', e => { const row = e.target.closest('.g-row'); if (row && !e.target.closest('.g-ch')) play(row); });
  rows.addEventListener('keydown', e => { const row = e.target.closest('.g-row'); if (row && e.key === 'Enter' && !TV) { e.preventDefault(); play(row); } });
  rows.addEventListener('contextmenu', e => {
    const row = e.target.closest('.g-row');
    if (!row) return;
    e.preventDefault();
    const it = row._ch;
    cardMenu(e, 'live', { id: it.id, name: it.name, image: it.logo, cat: it.cat });
  });

  const load = () => {
    scroller.scrollTop = 0;
    items = infinite(rows, scroller,
      // the first rows in: the choice of channels can be used, and the remote starts on the first channel
      offset => call('catalog:list', { section: 'live', cat: g.cat, offset, limit: 100 }).finally(() => setTimeout(() => {
        sel.disabled = false;
        if (!offset) tvStart(rows.querySelector('.g-ch') || sel);
      }, 0)),
      rowOf,
      g.cat === '*fav' ? 'No favorite channels yet. Choose "All channels", or press ☆ next to a channel in Live TV.' : 'No channels here.');
  };

  // the channels: favorites first (when there are any), then all of them, then each category
  const sel = $('#gCat');
  (async () => {
    const [cats, favs] = await Promise.all([call('catalog:cats', 'live'), call('catalog:list', { section: 'live', cat: '*fav', offset: 0, limit: 1 })]);
    if (!page.isConnected) return;
    if (g.cat == null) g.cat = favs.total ? '*fav' : '';
    const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
    sel.append(opt('*fav', '⭐ Favorites'), opt('', `All channels (${cats.total.toLocaleString()})`));
    for (const c of cats.cats) { const o = opt(c.id, `${c.locked && !c.open ? '🔒 ' : ''}${c.name} (${c.count.toLocaleString()})`); o._c = c; sel.appendChild(o); }
    sel.value = g.cat;
    if (sel.value !== g.cat) { g.cat = ''; sel.value = ''; }
    sel.onchange = async () => {
      const c = sel.selectedOptions[0] && sel.selectedOptions[0]._c;
      if (c && c.locked && !c.open && !(await askPin({ name: c.name }))) { sel.value = g.cat; return; }
      g.cat = sel.value;
      if (c && c.locked && !c.open) return render();
      load();
    };
    info.innerHTML = '<p class="muted small">Choose a channel to see what\'s on.</p>';
    load();
  })().catch(fail);
}

/* =================================================================
 * 7. MOVIES + SERIES (poster grids)
 * ================================================================= */
function renderBrowse(view) {
  const section = state.view;
  view.appendChild(h('<div class="cats" id="cats"></div>'));
  const scroller = h('<div class="fill scroll"></div>');
  const grid = h('<div class="grid" id="grid"></div>');
  scroller.appendChild(grid);
  view.appendChild(scroller);
  const load = () => infinite(grid, scroller,
    offset => call('catalog:list', { section, cat: state.sec[section].cat, q: state.q, sort: state.sec[section].sort, offset, limit: 120 }),
    it => posterCard(it),
    state.sec[section].cat === '*fav' ? `No favorite ${section} yet. Open one and click ☆ Favorite.` : state.q ? `No ${section} match your search.` : `No ${section} here.`);
  catList(section, $('#cats'), () => { scroller.scrollTop = 0; $('#sortSel').options[0].textContent = sortDefaultLabel(); load(); });
  load();
  if (state.q) {
    call('collections:list', state.q).then(cols => {
      if (!cols.length || !grid.isConnected) return;
      const hint = h('<div class="col-hint"></div>');
      for (const c of cols) {
        const b = h(c.studio ? `<button class="btn small">📚 ${esc(c.name)} <span class="faint">· ${c.have.toLocaleString()} in your playlist</span></button>` : `<button class="btn small">📚 ${esc(c.name)} in order <span class="faint">· ${c.have} of ${c.total}</span></button>`);
        b.onclick = () => go('collection', c.id);
        hint.appendChild(b);
      }
      scroller.insertBefore(hint, grid);
    }).catch(() => { /* no collections then */ });
  }
}

/** Poster card for a movie or series (it.kind 'movie' | 'series'), or anything with name/poster. */
function posterCard(it, opts = {}) {
  const wide = opts.wide;
  const pct = it.dur ? Math.min(100, Math.max(2, (it.pos / it.dur) * 100)) : 0;
  const sub = it.sub != null ? it.sub : [it.year || '', it.rating ? `★ ${it.rating}` : ''].filter(Boolean).join(' · ');
  const el = h(`<div class="card${wide ? ' wide' : ''}" tabindex="0">
    <div class="poster">${pic(it.poster || it.image, it.name, 'pi', { kind: it.kind, name: it.name, year: it.year }, it.fb)}
      ${it.fav ? '<span class="badge fav">★</span>' : ''}${it.watched ? '<span class="badge seen">✓ Watched</span>' : ''}${it.fromHidden ? '<span class="badge hid">Hidden category</span>' : ''}
      ${pct ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>
    <div class="title" title="${esc(opts.title || it.name)}">${esc(opts.title || it.name)}</div><div class="sub">${esc(sub)}</div></div>`);
  el.onclick = opts.onClick || (() => go(it.kind === 'series' ? 'show' : 'movie', it.id));
  if (it.kind === 'movie' || it.kind === 'series') el.oncontextmenu = e => { e.preventDefault(); cardMenu(e, it.kind, { id: it.id, name: it.name, image: it.poster || it.image, cat: it.cat }); };
  return el;
}

/* =================================================================
 * 8. MOVIE PAGE
 * ================================================================= */
async function renderMovie(view) {
  const id = state.arg;
  const page = h('<div class="detail"><div class="inner"><p class="muted">Loading…</p></div></div>');
  view.appendChild(page);
  let m = null, note = '';
  try { m = await call('details:movie', id); }
  catch (e) {
    if (e.code === 'LOCKED') { if (await askPin(e.locked)) return render(); return back(); }
    if (e.code !== 'VPN') return fail(e);
    m = await call('catalog:item', 'movies', id).catch(() => null);
    note = '🛡️ The VPN is off, so the movie\'s details couldn\'t be loaded.';
  }
  if (!page.isConnected) return;
  if (!m) { page.querySelector('.inner').innerHTML = '<p class="muted">This movie isn\'t in the playlist any more.</p>'; return; }
  const i = m.info || {};
  const name = i.name || m.name;
  const poster = i.poster || m.poster;
  const dur = i.duration || m.dur || 0;
  const meta = [...new Set([i.year || m.year || '', dur ? `${Math.round(dur / 60)} min` : '', i.genre || '', m.catName || ''].filter(Boolean))];
  const rating = i.rating || m.rating;
  page.innerHTML = `${i.backdrop || poster ? `<div class="backdrop" style="background-image:url('${esc(imgSrc(i.backdrop || poster))}')"></div>` : ''}
    <div class="inner">
      <button class="btn ghost small back tv-hide" id="mBack">← Back</button>
      <div class="head">
        <div class="poster">${pic(poster, name, 'pi', { kind: 'movie', name, year: i.year || m.year })}</div>
        <div style="min-width:0">
          <h2>${esc(name)}</h2>
          <div class="meta">${rating ? `<span class="rating">★ ${esc(rating)}</span>` : ''}${meta.map(x => `<span>${esc(x)}</span>`).join('<span>·</span>')}</div>
          <div class="actions" id="mActions"></div>
          ${i.plot ? `<p class="plot selectable">${esc(i.plot)}</p>` : ''}
          <div class="facts">${i.director ? `<p><b>Director</b> ${esc(i.director)}</p>` : ''}${i.cast ? `<p><b>Cast</b> ${esc(i.cast)}</p>` : ''}</div>
          ${note ? `<p class="muted small">${note}</p>` : ''}${i.error ? `<p class="muted small">Details: ${esc(i.error)}</p>` : ''}
        </div>
      </div>
    </div>`;
  $('#mBack').onclick = back;
  const req = { kind: 'movie', id: m.id, name, image: poster, ext: i.ext || m.ext };
  const actions = $('#mActions');
  const draw = () => keepFocus(actions, () => {
    actions.innerHTML = '';
    const add = (html, fn, cls = 'btn') => { const b = h(`<button class="${cls}">${html}</button>`); b.onclick = fn; actions.appendChild(b); };
    if (m.pos) {
      add(`▶ Resume from ${fmtTime(m.pos)}`, () => Player.play(req, { start: m.pos }), 'btn primary big');
      add('↺ Start over', () => Player.play(req, { start: 0 }), 'btn big');
    } else {
      add('▶ Play', () => Player.play(req), 'btn primary big');
    }
    add(m.fav ? '★ Favorite' : '☆ Favorite', async () => { await toggleFav(m, 'movie', { name, image: poster, cat: m.cat }); draw(); });
    add('＋ Category', () => pickLists('movie:' + m.id, { name, image: poster, cat: m.cat }));
    add(m.watched ? '✓ Watched' : '○ Mark as watched', async () => {
      try { m.watched = await call('lib:watched', 'movie:' + m.id, !m.watched, { name, image: poster }); if (m.watched) m.pos = 0; draw(); }
      catch (e) { fail(e); }
    });
    add(OTHER_PLAYER, () => openExternal({ ...req, title: name, start: m.pos || 0 }), 'btn ghost');
    if (i.trailer) add('Trailer', () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(i.trailer)}`), 'btn ghost');
  });
  draw();
  tvStart(actions.firstChild);
}

/* =================================================================
 * 9. SERIES PAGE
 * ================================================================= */
/** All episodes in order, as play requests. */
function episodeQueue(d) {
  const i = d.info || {};
  return (i.seasons || []).flatMap(s => s.episodes.map(e => ({
    kind: 'episode', id: e.id, ext: e.ext, seriesId: d.id, seriesName: i.name || d.name, season: s.num, episode: e.num,
    name: e.title || `Episode ${e.num}`, image: e.image || i.poster || d.poster, watched: e.watched, pos: e.pos, dur: e.dur
  })));
}

async function renderShow(view) {
  const id = state.arg;
  const page = h('<div class="detail"><div class="inner"><p class="muted">Loading episodes…</p></div></div>');
  view.appendChild(page);
  let d;
  try { d = await call('details:series', id); }
  catch (e) {
    if (e.code === 'LOCKED') { if (await askPin(e.locked)) return render(); return back(); }
    if (e.code === 'VPN') {
      const base = await call('catalog:item', 'series', id).catch(() => null);
      page.querySelector('.inner').innerHTML = `<button class="btn ghost small back" id="sBack">← Back</button><h2>${esc(base ? base.name : 'Series')}</h2><p class="muted">🛡️ The VPN is off, so the episodes couldn't be loaded. Connect your VPN, then open the series again.</p>`;
      $('#sBack').onclick = back;
      return vpnBlocked(e.vpn);
    }
    page.querySelector('.inner').innerHTML = `<button class="btn ghost small back" id="sBack">← Back</button><p class="error">${esc(e.message)}</p>`;
    $('#sBack').onclick = back;
    return;
  }
  if (!page.isConnected) return;
  const i = d.info;
  const name = i.name || d.name;
  const poster = i.poster || d.poster;
  const queue = episodeQueue(d);
  const meta = [i.year || d.year || '', `${i.seasons.length} season${i.seasons.length === 1 ? '' : 's'}`, `${queue.length} episodes`, i.genre || ''].filter(Boolean);
  page.innerHTML = `${i.backdrop || poster ? `<div class="backdrop" style="background-image:url('${esc(imgSrc(i.backdrop || poster))}')"></div>` : ''}
    <div class="inner">
      <button class="btn ghost small back tv-hide" id="sBack">← Back</button>
      <div class="head">
        <div class="poster">${pic(poster, name, 'pi', { kind: 'series', name, year: i.year || d.year })}</div>
        <div style="min-width:0">
          <h2>${esc(name)}</h2>
          <div class="meta">${(i.rating || d.rating) ? `<span class="rating">★ ${esc(i.rating || d.rating)}</span>` : ''}${meta.map(x => `<span>${esc(x)}</span>`).join('<span>·</span>')}</div>
          <div class="actions" id="sActions"></div>
          ${i.plot || d.plot ? `<p class="plot selectable">${esc(i.plot || d.plot)}</p>` : ''}
          ${i.cast ? `<div class="facts"><p><b>Cast</b> ${esc(i.cast)}</p></div>` : ''}
        </div>
      </div>
      <div class="seasons" id="sSeasons" data-tv-group></div>
      <div id="sEpisodes"></div>
    </div>`;
  $('#sBack').onclick = back;
  if (!queue.length) { $('#sEpisodes').innerHTML = '<p class="muted">The provider lists no episodes for this series.</p>'; }

  // which season to show: the one with the next episode to watch
  const nextUp = () => queue.find(q => q.pos && !q.watched) || queue.find(q => !q.watched) || null;
  let season = (nextUp() || queue[0] || { season: (i.seasons[0] || {}).num }).season;

  const drawActions = () => keepFocus($('#sActions'), () => {
    const a = $('#sActions');
    a.innerHTML = '';
    const add = (html, fn, cls = 'btn') => { const b = h(`<button class="${cls}">${html}</button>`); b.onclick = fn; a.appendChild(b); };
    const nx = nextUp();
    if (nx) add(`▶ ${nx.pos ? 'Resume' : queue.indexOf(nx) === 0 ? 'Play' : 'Continue'} ${epLabel(nx.season, nx.episode)}`, () => Player.play(nx, { queue, start: nx.pos || 0 }), 'btn primary big');
    else if (queue.length) add('↺ Watch again from the start', () => Player.play(queue[0], { queue, start: 0 }), 'btn big');
    add(d.fav ? '★ Favorite' : '☆ Favorite', async () => { await toggleFav(d, 'series', { name, image: poster, cat: d.cat }); drawActions(); });
    add('＋ Category', () => pickLists('series:' + d.id, { name, image: poster, cat: d.cat }));
    const inSeason = queue.filter(q => q.season === season);
    if (inSeason.length) {
      const allSeen = inSeason.every(q => q.watched);
      add(allSeen ? `○ Season ${season}: mark as not watched` : `✓ Mark season ${season} as watched`, async () => {
        try {
          await call('lib:watchedMany', inSeason.map(q => ({ key: 'episode:' + q.id, meta: { name: q.name, image: q.image, seriesId: d.id, seriesName: name, season: q.season, episode: q.episode } })), !allSeen);
          inSeason.forEach(q => { q.watched = !allSeen; if (q.watched) q.pos = 0; });
          drawSeason(); drawActions();
        } catch (e) { fail(e); }
      }, 'btn ghost');
    }
  });

  // a season's tab: its episodes underneath (on a TV, as soon as the remote moves onto it)
  const pickSeason = n => {
    season = n;
    $$('#sSeasons .season').forEach(b => b.classList.toggle('active', b._s === n));
    drawSeason(); drawActions();
  };
  const drawSeasons = () => keepFocus($('#sSeasons'), () => {
    const box = $('#sSeasons');
    box.innerHTML = '';
    for (const s of i.seasons) {
      const seen = s.episodes.length && queue.filter(q => q.season === s.num).every(q => q.watched);
      const b = h(`<button class="season${s.num === season ? ' active' : ''}">${esc(s.name || 'Season ' + s.num)}${seen ? ' ✓' : ''}</button>`);
      b._s = s.num;
      b.onclick = () => pickSeason(s.num);
      if (TV) b.onfocus = () => { if (season !== s.num) pickSeason(s.num); };
      box.appendChild(b);
    }
  });

  const drawSeason = () => keepFocus($('#sEpisodes'), () => {
    const box = $('#sEpisodes');
    box.innerHTML = '';
    for (const q of queue.filter(x => x.season === season)) {
      const pct = q.dur ? Math.min(100, (q.pos / q.dur) * 100) : 0;
      const el = h(`<div class="episode${q.watched ? ' seen' : ''}" tabindex="0">
        <div class="thumb">${q.image ? `<img class="pi" loading="lazy" src="${esc(imgSrc(q.image))}" data-i="E${q.episode}" alt="">` : `<span>E${q.episode}</span>`}${pct ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>
        <div class="txt"><div class="t">${q.episode}. ${esc(q.name)}</div>
          <div class="small muted">${q.pos ? esc(fmtLeft(q.pos, q.dur)) : q.watched ? 'Watched' : ''}</div></div>
        <button class="seen-btn${q.watched ? ' on' : ''}" title="${q.watched ? 'Watched — click to mark as not watched' : 'Mark as watched'}">✓</button>
      </div>`);
      const ep = (d.info.seasons.find(s => s.num === season) || { episodes: [] }).episodes.find(e => e.id === q.id);
      if (ep && ep.plot) el.querySelector('.txt').appendChild(h(`<div class="p">${esc(ep.plot)}</div>`));
      el.onclick = () => Player.play(q, { queue, start: q.pos || 0 });
      el.querySelector('.seen-btn').onclick = async e => {
        e.stopPropagation();
        try {
          q.watched = await call('lib:watched', 'episode:' + q.id, !q.watched, { name: q.name, image: q.image, seriesId: d.id, seriesName: name, season: q.season, episode: q.episode });
          if (q.watched) q.pos = 0;
          drawSeasons(); drawSeason(); drawActions();
        } catch (err) { fail(err); }
      };
      box.appendChild(el);
    }
  });
  drawActions(); drawSeasons(); drawSeason();
  if (i.seasons.length > 1) $('#sActions').dataset.tvDown = '#sSeasons .season.active';   // TV: ↓ from the buttons -> the season in use
  tvStart($('#sActions').firstChild);
}

/* =================================================================
 * 10. FAVORITES + SEARCH RESULTS
 * ================================================================= */
const FAV_SORTS = [['added', 'Newest'], ['name', 'A–Z'], ['custom', 'My order']];

/**
 * Favorites, per kind: newest first, A–Z or the user's own order (Settings
 * favorites.<kind>, synced). "Arrange" (in My order): drag the cards, or ◀ ▶ on
 * each card (the TV remote); the new order is saved a moment after the last move.
 */
async function renderFavorites(view, focus) {
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  const [live, movies, series] = await Promise.all(['live', 'movie', 'series'].map(k => call('lib:favorites', k).catch(() => [])));
  if (!page.isConnected) return;
  if (!live.length && !movies.length && !series.length) {
    page.appendChild(h('<div class="empty">No favorites yet.<br><span class="small">Click ☆ on a channel, movie or series to add it here.</span></div>'));
    return;
  }
  const redraw = sel => { view.innerHTML = ''; renderFavorites(view, sel); };
  const grid = (title, kind, items, make) => {
    if (!items.length) return;
    const sort = (state.settings.favorites || {})[kind] || 'added';
    const arranging = state.favArrange === kind && sort === 'custom';
    const head = h(`<div class="shelf" data-fk="${kind}"><div class="shelf-head"><h2>${esc(title)}</h2><span class="muted small">${items.length}</span>
      <div class="seg fav-sort">${FAV_SORTS.map(([v, t]) => `<button data-v="${v}" class="${sort === v ? 'active' : ''}">${t}</button>`).join('')}</div>
      ${sort === 'custom' && items.length > 1 ? `<button class="btn small${arranging ? ' primary' : ''}" data-arrange>${arranging ? 'Done' : 'Arrange'}</button>` : ''}</div>
      ${arranging ? `<p class="muted small fav-hint">${TV ? 'Press OK on ◀ or ▶ to move a poster.' : 'Drag the posters into the order you want, or use ◀ ▶.'}</p>` : ''}</div>`);
    head.querySelectorAll('.fav-sort button').forEach(b => b.onclick = async () => {
      if (b.dataset.v === sort) return;
      state.favArrange = '';
      await saveSettings({ favorites: { [kind]: b.dataset.v } });
      redraw(`[data-fk="${kind}"] [data-v="${b.dataset.v}"]`);
    });
    const ab = head.querySelector('[data-arrange]');
    if (ab) ab.onclick = () => { state.favArrange = arranging ? '' : kind; redraw(`[data-fk="${kind}"] [data-arrange]`); };
    page.appendChild(head);
    const g = h('<div class="grid" style="padding-top:0"></div>');
    let timer = 0, dragging = null;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => call('lib:arrangeFavorites', kind, [...g.children].map(c => c.dataset.key)).catch(fail), 400);
    };
    items.forEach(it => {
      const c = make(it);
      if (arranging) {
        c.dataset.key = it.key;
        c.onclick = null;
        c.tabIndex = -1;
        c.classList.add('arranging');
        c.draggable = !TV;
        const bar = h('<div class="arrange"><button title="Move earlier">◀</button><button title="Move later">▶</button></div>');
        // the neighbor moves, not this card, so the button keeps the focus
        const [l, r] = bar.querySelectorAll('button');
        l.onclick = e => { e.stopPropagation(); const p = c.previousElementSibling; if (p) { c.after(p); save(); } l.scrollIntoView({ block: 'nearest' }); };
        r.onclick = e => { e.stopPropagation(); const n = c.nextElementSibling; if (n) { c.before(n); save(); } r.scrollIntoView({ block: 'nearest' }); };
        c.querySelector('.poster').appendChild(bar);
        c.addEventListener('dragstart', e => { dragging = c; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        c.addEventListener('dragend', () => { c.classList.remove('dragging'); dragging = null; save(); });
      }
      g.appendChild(c);
    });
    if (arranging) {
      g.addEventListener('dragover', e => {
        if (!dragging) return;
        e.preventDefault();
        const t = e.target.closest('.card');
        if (!t || t === dragging || t.parentNode !== g) return;
        const box = t.getBoundingClientRect();
        if (e.clientX > box.left + box.width / 2) t.after(dragging); else t.before(dragging);
      });
      g.addEventListener('drop', e => e.preventDefault());
    }
    page.appendChild(g);
  };
  grid('Channels', 'live', live, f => channelCard({ id: f.id, name: f.name, logo: f.image, fav: true }));
  grid('Movies', 'movie', movies, f => posterCard({ kind: 'movie', id: f.id, name: f.name, poster: f.image, fav: true }));
  grid('Series', 'series', series, f => posterCard({ kind: 'series', id: f.id, name: f.name, poster: f.image, fav: true }));
  const f = focus && page.querySelector(focus);
  if (f) f.focus();
}

/* ---- Collections (main/franchises.js): Marvel, Star Wars … in release or story order ---- */
function collectionCard(c) {
  // the cover title's poster (looked up like any other when the playlist has none) …
  const cv = c.cover || {};
  const own = c.art && artKnown.get(artKey({ kind: 'collection', name: c.art }));   // its own poster, found earlier this run
  const el = posterCard({ name: cv.name || c.name, kind: cv.kind, year: cv.year, poster: own || c.poster, sub: c.studio ? `${c.have.toLocaleString()} in your playlist` : `${c.have} of ${c.total} in your playlist` }, { title: c.name, onClick: () => go('collection', c.id) });
  const ini = el.querySelector('.poster > .initials');
  if (ini) ini.textContent = initials(c.name);
  else el.querySelector('.poster > .pi').dataset.i = initials(c.name);
  // … until the collection's own poster comes back (TMDB, with a key; artwork.js remembers it)
  if (c.art && !own && state.settings.artwork && state.settings.artwork.lookup) {
    call('art:find', [{ kind: 'collection', name: c.art }]).then(([u]) => {
      if (u && KEEPS_IMAGES) artKnown.set(artKey({ kind: 'collection', name: c.art }), u);
      const p = u && el.querySelector('.poster > .pi, .poster > .initials');
      if (p) p.replaceWith(h(`<img class="pi" src="${esc(artSrc(u))}" data-i="${esc(initials(c.name))}" alt="">`));
      Art.keep(u);
    }).catch(() => { /* keep the cover */ });
  }
  return el;
}

async function renderCollections(view) {
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  const list = await call('collections:list').catch(e => { fail(e); return null; });
  if (!list || !page.isConnected) return;
  if (!list.length) {
    page.appendChild(h('<div class="empty">None of the collections are in your playlist yet.<br><span class="small">Disney, Netflix and Prime Video, Marvel, Star Wars, Star Trek, Harry Potter and more show up here when the playlist has their movies or shows.</span></div>'));
    return;
  }
  page.appendChild(h('<div class="shelf"><p class="muted small col-note">Disney\'s movies and what Netflix and Prime Video made, newest first; and the big franchises, movies and the shows that go with them, in the order they came out or in story order.</p></div>'));
  const g = h('<div class="grid" style="padding-top:0"></div>');
  list.forEach(c => g.appendChild(collectionCard(c)));
  page.appendChild(g);
}

/** Opens a collection's movie or show; with several versions (4K, HD …) asks which. */
async function openCollectionEntry(x) {
  const open = id => go(x.kind === 'series' ? 'show' : 'movie', id);
  if (x.versions.length < 2) return open(x.item.id);
  let pick = null;
  await dialog({
    title: x.title, okText: 'Cancel', hideCancel: true,
    html: `<p class="muted small">Your playlist has ${x.versions.length} versions of this ${x.kind === 'series' ? 'show' : 'movie'}.</p><div class="versions">${x.versions.map((v, i) => `<button class="btn" data-i="${i}">${esc(v.name)}</button>`).join('')}</div>`,
    onOpen: () => {
      const bs = $$('#dlgBody .versions button');
      bs.forEach(b => { b.onclick = () => { pick = x.versions[b.dataset.i]; $('#dlgOk').click(); }; });
      setTimeout(() => bs[0] && bs[0].focus(), 60);
    }
  });
  if (pick) open(pick.id);
}

/**
 * A studio's collection (Disney, Netflix, Prime): what the playlist has of it, newest first
 * or oldest first, all / movies / shows; drawn a page at a time (a thousand titles or more).
 */
async function renderStudio(view, focus) {
  const st = state.studio || (state.studio = { order: 'newest', kind: '' });
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  const col = await call('collections:get', state.arg, st.order, st.kind).catch(e => { fail(e); return null; });
  if (!page.isConnected) return;
  if (!col) { page.appendChild(h('<div class="empty">This collection isn\'t there any more.</div>')); return; }
  const both = col.counts.movie && col.counts.series;
  const seg = (k, opts) => `<div class="seg" data-k="${k}">${opts.map(([v, t]) => `<button data-v="${v}" class="${st[k] === v ? 'active' : ''}">${t}</button>`).join('')}</div>`;
  const head = h(`<div class="shelf"><div class="shelf-head"><h2>${esc(col.name)}</h2><span class="muted small">${col.have.toLocaleString()} in your playlist</span>
    ${seg('order', [['newest', 'Newest first'], ['oldest', 'Oldest first']])}
    ${both ? seg('kind', [['', 'All'], ['movie', `Movies (${col.counts.movie.toLocaleString()})`], ['series', `Shows (${col.counts.series.toLocaleString()})`]]) : ''}</div>
    <p class="muted small col-note">${col.id === 'studio-disney' ? 'Disney\'s movies: Walt Disney Pictures, Disney Animation, Pixar, Disney+ and Disney Channel films.' : `Made for ${esc(col.name)}: its own movies and shows.`} The list comes from Wikipedia and is brought up to date every few days.</p></div>`);
  head.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    const k = b.parentElement.dataset.k;
    if (st[k] === b.dataset.v) return;
    st[k] = b.dataset.v;
    view.innerHTML = '';
    renderStudio(view, `.seg[data-k="${k}"] [data-v="${b.dataset.v}"]`);
  });
  page.appendChild(head);
  const g = h('<div class="grid" style="padding-top:0"></div>');
  page.appendChild(g);
  infinite(g, page, offset => Promise.resolve({ items: col.items.slice(offset, offset + 120), total: col.items.length }),
    x => posterCard({ ...x.item, name: x.title, year: x.year, sub: [x.year, x.kind === 'series' ? 'Series' : '', x.versions.length > 1 ? `${x.versions.length} versions` : ''].filter(Boolean).join(' · ') }, { title: x.title, onClick: () => openCollectionEntry(x) }),
    st.kind ? 'None of these in your playlist.' : 'None of this collection is in your playlist.');
  const f = focus && page.querySelector(focus);
  if (f) f.focus();
}

async function renderCollection(view, focus) {
  if (/^studio-/.test(state.arg)) return renderStudio(view, focus);
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  const col = await call('collections:get', state.arg, (state.settings.collections || {}).order || 'release').catch(e => { fail(e); return null; });
  if (!page.isConnected) return;
  if (!col) { page.appendChild(h('<div class="empty">This collection isn\'t there any more.</div>')); return; }
  const next = col.items[col.next];
  const head = h(`<div class="shelf"><div class="shelf-head"><h2>${esc(col.name)}</h2><span class="muted small">${col.have} of ${col.total} in your playlist</span>
    ${col.hasStory ? `<div class="seg"><button data-o="release" class="${col.order === 'release' ? 'active' : ''}">Release order</button><button data-o="story" class="${col.order === 'story' ? 'active' : ''}">Story order</button></div>` : ''}
    ${next ? `<button class="btn primary small col-next"${col.hasStory ? '' : ' style="margin-left:auto"'}>▶ Next up: ${esc(next.title)}</button>` : ''}</div>
    <p class="muted small col-note">${col.order === 'story' ? `Story order: ${esc(col.storyNote)}.` : 'In the order they came out.'} Greyed out: not in your playlist.</p></div>`);
  head.querySelectorAll('.seg button').forEach(b => b.onclick = async () => {
    if (b.dataset.o === col.order) return;
    await saveSettings({ collections: { order: b.dataset.o } });
    view.innerHTML = '';
    renderCollection(view, `.seg [data-o="${b.dataset.o}"]`);
  });
  if (next) head.querySelector('.col-next').onclick = () => openCollectionEntry(next);
  page.appendChild(head);
  const g = h('<div class="grid" style="padding-top:0"></div>');
  col.items.forEach((x, i) => {
    const title = `${x.n} · ${x.title}`;
    let el;
    if (x.item) {
      const sub = [x.year, x.kind === 'series' ? 'Series' : '', x.versions.length > 1 ? `${x.versions.length} versions` : ''].filter(Boolean).join(' · ');
      el = posterCard({ ...x.item, name: x.title, year: x.year, sub }, { title, onClick: () => openCollectionEntry(x) });
      if (i === col.next) { el.classList.add('next'); el.querySelector('.poster').appendChild(h('<span class="badge nextup">Next up</span>')); }
    } else {
      el = h(`<div class="card missing" title="Not in your playlist"><div class="poster">${pic('', x.title, 'pi', { kind: x.kind, name: x.title, year: x.year })}</div>
        <div class="title">${esc(title)}</div><div class="sub">${esc([x.year, x.kind === 'series' ? 'Series' : '', 'Not in your playlist'].filter(Boolean).join(' · '))}</div></div>`);
    }
    g.appendChild(el);
  });
  page.appendChild(g);
  const f = focus && page.querySelector(focus);
  if (f) f.focus();
}

/* ---- My categories (main/library.js): the user's own — Kids, Date night … — in the menu, synced ---- */
const LIST_ICONS = ['🗂️', '🧸', '🎈', '❤️', '🍿', '🏆', '🎄', '🎃', '🎵', '🌙', '🔥', '⭐'];
const listOf = id => state.lists.find(l => l.id === id) || null;

/** The sidebar: one entry per category, then "＋ New category". */
function renderMyNav() {
  const box = $('#myNav');
  box.innerHTML = '';
  for (const l of state.lists) {
    const b = h(`<button class="nav" data-view="list" data-arg="${esc(l.id)}"><span class="ico">${esc(l.icon || LIST_ICONS[0])}</span><span class="nav-name">${esc(l.name)}</span></button>`);
    b.onclick = () => { state.q = ''; $('#search').value = ''; go('list', l.id); };
    b.oncontextmenu = e => { e.preventDefault(); listMenu(e, l); };
    box.appendChild(b);
  }
  if (profile()) {
    const add = h('<button class="nav nav-add" title="Make a category of your own and put any channels, movies and series in it"><span class="ico">＋</span>New category</button>');
    add.onclick = () => editList(null);
    box.appendChild(add);
  }
  $$('#myNav .nav').forEach(b => b.classList.toggle('active', state.view === 'list' && b.dataset.arg === state.arg));
}

async function loadLists() {
  state.lists = await call('lists:all').catch(() => state.lists);
  renderMyNav();
}

/** A new category (l null) or a new name / icon for one. Resolves the id, or null. */
async function editList(l, { open = true } = {}) {
  let icon = (l && l.icon) || LIST_ICONS[0];
  const id = await dialog({
    title: l ? 'Rename category' : 'New category',
    html: `${l ? '' : '<p class="muted small">Your own category in the menu, next to Movies and Series. Put any channels, movies and series in it: Kids, Date night, Christmas … It syncs to your other devices.</p>'}
      <label for="lName">Name</label><input type="text" id="lName" maxlength="40" value="${esc(l ? l.name : '')}" placeholder="Kids" spellcheck="false">
      <label style="margin-top:10px">Icon</label><div class="icon-pick" id="lIcons">${LIST_ICONS.map(i => `<button type="button" data-i="${i}" class="${i === icon ? 'active' : ''}">${i}</button>`).join('')}</div>
      <div class="error" id="lErr"></div>`,
    okText: l ? 'Save' : 'Create',
    onOpen: () => $$('#lIcons button').forEach(b => b.onclick = () => { icon = b.dataset.i; $$('#lIcons button').forEach(x => x.classList.toggle('active', x === b)); }),
    onOk: async () => {
      try { return await call('lists:save', l ? l.id : null, { name: $('#lName').value, icon }); }
      catch (e) { $('#lErr').textContent = e.message; return false; }
    }
  });
  if (!id) return null;
  await loadLists();
  if (!l && open) go('list', id);
  else if (state.view === 'list' || state.view === 'home') render();
  return id;
}

async function removeList(l) {
  if (!(await confirmBox('Delete category', `Delete "${l.name}"? The channels, movies and series in it stay in your playlist; only the category goes, on all your devices.`, 'Delete', true))) return;
  try { await call('lists:remove', l.id); } catch (e) { return fail(e); }
  await loadLists();
  toast(`"${l.name}" is deleted.`);
  if (state.view === 'list' && state.arg === l.id) { state.history = state.history.filter(x => !(x.view === 'list' && x.arg === l.id)); go('home', null, { push: false }); }
  else if (state.view === 'home') render();
}

function listMenu(ev, l) {
  showMenu(ev, [{ label: '✏️ Rename…', run: () => editList(l) }, '-', { label: '🗑️ Delete category…', run: () => removeList(l) }]);
}

/** "＋ Category": tick the categories a channel / movie / series is in (key live:1, movie:9, series:4). */
async function pickLists(key, meta) {
  let had;
  try { had = new Set(await call('lists:of', key)); } catch (e) { return fail(e); }
  const r = await dialog({
    title: 'Categories',
    html: `<p class="muted small">Put <b>${esc(meta.name)}</b> in your own categories:</p>
      <div class="list-pick">${state.lists.map(l => `<label class="check"><input type="checkbox" data-l="${esc(l.id)}" ${had.has(l.id) ? 'checked' : ''}> ${esc(l.icon || LIST_ICONS[0])} ${esc(l.name)}</label>`).join('') || '<p class="muted small">You have no categories of your own yet.</p>'}</div>
      <label for="lNew" style="margin-top:12px">${state.lists.length ? 'Or a new category' : 'A new category'}</label><input type="text" id="lNew" maxlength="40" placeholder="Kids" spellcheck="false">
      <div class="error" id="lErr"></div>`,
    okText: 'Save',
    onOk: async () => {
      try {
        const want = new Map($$('.list-pick input').map(c => [c.dataset.l, c.checked]));
        const name = $('#lNew').value.trim();
        if (name) want.set(await call('lists:save', null, { name, icon: LIST_ICONS[0] }), true);
        const added = [], removed = [];
        for (const [lid, on] of want) {
          if (on === had.has(lid)) continue;
          await call('lists:set', lid, key, on, meta);
          (on ? added : removed).push(lid);
        }
        return { added, removed, made: !!name };
      } catch (e) { $('#lErr').textContent = e.message; return false; }
    }
  });
  if (!r) return;
  if (r.made) await loadLists(); else state.lists = await call('lists:all').catch(() => state.lists);
  const names = ids => ids.map(id => `"${(listOf(id) || {}).name}"`).join(', ');
  if (r.added.length) toast(`Added "${meta.name}" to ${names(r.added)}.`);
  else if (r.removed.length) toast(`Took "${meta.name}" out of ${names(r.removed)}.`);
  if (state.view === 'list' || state.view === 'home') render();
}

/** Right-click (☰ Menu on Fire TV) on a channel, movie or series. */
function cardMenu(ev, kind, it) {
  const key = `${kind}:${it.id}`, meta = { name: it.name, image: it.image, cat: it.cat };
  const items = [{ label: '＋ Add to a category…', run: () => pickLists(key, meta) }];
  const l = state.view === 'list' && listOf(state.arg);
  if (l) items.push({ label: `✏️ Rename in "${l.name}"…`, run: () => renameListed(l, { key, name: it.name, shown: it.name }) }, { label: `✕ Take out of "${l.name}"`, run: async () => {
    try { await call('lists:set', l.id, key, false); } catch (e) { return fail(e); }
    toast(`Took "${it.name}" out of "${l.name}".`);
    render();
  } });
  showMenu(ev, items);
}

/** The name a title is shown with in one category only (FL | Fort Myers | NBC WBBH -> NBC). it: { key, name, shown } */
async function renameListed(l, it) {
  const title = await dialog({
    title: `Rename in ${l.name}`,
    html: `<p class="muted small">Only how it's shown in <b>${esc(l.name)}</b>; everywhere else it keeps its name${it.name && it.name !== it.shown ? ` (<b>${esc(it.name)}</b>)` : ''}. Leave it empty for that name again.</p>
      <label for="ltName">Name</label><input type="text" id="ltName" maxlength="80" value="${esc(it.shown)}" spellcheck="false"><div class="error" id="ltErr"></div>`,
    okText: 'Save',
    onOk: async () => {
      try { return { v: await call('lists:title', l.id, it.key, $('#ltName').value) }; }
      catch (e) { $('#ltErr').textContent = e.message; return false; }
    }
  });
  if (!title) return;
  state.listFocus = it.key;
  render();
}

/** A card for anything in a category: with the name given to it there, if any. */
const listCard = it => it.kind === 'live' ? channelCard({ id: it.id, name: it.title || it.name, logo: it.image })
  : posterCard({ kind: it.kind, id: it.id, name: it.title || it.name, poster: it.image, cat: it.cat, sub: it.kind === 'series' ? 'Series' : 'Movie' });

async function renderList(view) {
  const l = listOf(state.arg);
  if (!l) return go('home', null, { push: false });
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  let items;
  try { items = await call('lists:items', l.id); } catch (e) { return fail(e); }
  if (!page.isConnected) return;
  const editing = state.listEdit === l.id && items.length > 0;
  const bar = h(`<div class="list-bar"><span class="muted small">${items.length ? `${items.length} title${items.length === 1 ? '' : 's'}` : ''}</span><span class="spacer"></span>
    ${items.length ? `<button class="btn small${editing ? ' primary' : ''}" data-edit>${editing ? 'Done' : '✏️ Edit titles'}</button>` : ''}
    <button class="btn small ghost" data-rename>✏️ Rename</button><button class="btn small ghost danger apart" data-del>🗑️ Delete category</button></div>`);
  const eb = bar.querySelector('[data-edit]');
  if (eb) eb.onclick = () => { state.listEdit = editing ? '' : l.id; render(); setTimeout(() => { const b = $('.list-bar [data-edit]'); if (b) b.focus(); }, 30); };
  bar.querySelector('[data-rename]').onclick = () => editList(l);
  bar.querySelector('[data-del]').onclick = () => removeList(l);
  page.appendChild(bar);
  if (!items.length) {
    page.appendChild(h(`<div class="empty">Nothing in ${esc(l.name)} yet.<br><span class="small">Open a channel, movie or series and choose <b>＋ Category</b>, or ${TV ? 'select one and press ☰ Menu' : 'right-click one'} → Add to a category.</span></div>`));
    return;
  }
  for (const [kind, title] of [['live', 'Channels'], ['movie', 'Movies'], ['series', 'Series']]) {
    const its = items.filter(x => x.kind === kind);
    if (!its.length) continue;
    page.appendChild(h(`<div class="shelf"><div class="shelf-head"><h2>${title}</h2><span class="muted small">${its.length}</span></div>${editing ? `<p class="muted small fav-hint">✏️ gives a title another name in ${esc(l.name)} only; ✕ takes it out.</p>` : ''}</div>`));
    const g = h('<div class="grid" style="padding-top:0"></div>');
    for (const it of its) {
      const c = listCard(it);
      c.dataset.key = it.key;
      if (editing) {
        c.onclick = null;
        c.tabIndex = -1;
        c.classList.add('arranging');
        const tools = h('<div class="list-tools arrange"><button data-ren title="Rename in this category">✏️ Rename</button><button data-rm title="Take it out of this category">✕ Remove</button></div>');
        tools.querySelector('[data-ren]').onclick = e => { e.stopPropagation(); renameListed(l, { key: it.key, name: it.name, shown: it.title || it.name }); };
        tools.querySelector('[data-rm]').onclick = async e => {
          e.stopPropagation();
          try { await call('lists:set', l.id, it.key, false); } catch (err) { return fail(err); }
          const next = c.nextElementSibling || c.previousElementSibling;
          c.remove();
          if (!g.children.length) return render();
          const b = next && next.querySelector('[data-rm]');
          if (b) b.focus();
        };
        c.querySelector('.poster').after(tools);
      }
      g.appendChild(c);
    }
    page.appendChild(g);
  }
  // after a rename: back on the same title (it may have moved: A–Z by the new name)
  const back = state.listFocus && page.querySelector(`[data-key="${CSS.escape(state.listFocus)}"]`);
  state.listFocus = '';
  if (back) { const b = back.querySelector('[data-ren]') || back; b.focus(); b.scrollIntoView({ block: 'nearest' }); }
}

async function renderSearch(view) {
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  if (!state.q) return;
  const wait = h('<div class="empty">Searching…</div>');
  const slow = setTimeout(() => page.appendChild(wait), 300);   // the first search on a TV reads the whole playlist
  const [r, cols] = await Promise.all([call('catalog:search', state.q).catch(e => { fail(e); return null; }), call('collections:list', state.q).catch(() => [])]);
  clearTimeout(slow);
  wait.remove();
  if (!r || !page.isConnected) return;
  const total = r.live.total + r.movies.total + r.series.total;
  if (cols.length) {
    page.appendChild(h(`<div class="shelf"><div class="shelf-head"><h2>Collections</h2><span class="muted small">${cols.length}</span></div></div>`));
    const g = h('<div class="grid" style="padding-top:8px"></div>');
    cols.forEach(c => g.appendChild(collectionCard(c)));
    page.appendChild(g);
  }
  if (!total && cols.length) return;
  if (!total) { page.appendChild(h(`<div class="empty">Nothing matches "${esc(state.q)}".</div>`)); return; }
  const block = (title, res, make, section) => {
    if (!res.total) return;
    page.appendChild(h(`<div class="shelf"><div class="shelf-head"><h2>${esc(title)}</h2><span class="muted small">${res.total.toLocaleString()}</span></div></div>`));
    if (res.total > res.items.length) {
      const b = h(`<button class="btn ghost small" style="margin-left:22px">Show all ${res.total.toLocaleString()} in ${esc(title)}</button>`);
      b.onclick = () => { state.sec[section].cat = ''; go(section); };
      page.appendChild(b);
    }
    const g = h('<div class="grid" style="padding-top:8px"></div>');
    res.items.forEach((it, idx) => g.appendChild(make(it, idx, res.items)));
    page.appendChild(g);
  };
  block('Channels', r.live, (it, idx, all) => {
    const el = channelCard(it);
    el.onclick = () => Player.play({ kind: 'live', id: it.id, name: it.name, image: it.logo }, { channels: all, index: idx });
    return el;
  }, 'live');
  block('Movies', r.movies, it => posterCard(it), 'movies');
  block('Series', r.series, it => posterCard(it), 'series');
}

/* =================================================================
 * 11. SETTINGS
 * ================================================================= */
async function saveSettings(patch, note) {
  try { state.settings = await call('settings:set', patch); if (note) toast(note); }
  catch (e) { fail(e); }
}

function renderSettings(view) {
  const s = state.settings;
  const wrap = h('<div class="settings-wrap"><nav class="set-nav" id="setNav" data-tv-group></nav></div>');
  const page = h('<div class="settings"></div>');
  wrap.appendChild(page);
  view.appendChild(wrap);
  const add = (sec, el) => { el.dataset.sec = sec; page.appendChild(el); return el; };

  /* ---- playlists ---- */
  const pl = h(`<div class="panel"><div class="row"><h2 style="margin:0">Playlists</h2><span class="spacer"></span><button class="btn primary" id="stAdd">＋ Add playlist</button></div>
    <p class="muted small">Your IPTV provider's Xtream Codes login or M3U playlist. Favorites, watched marks and resume points are kept per playlist.</p><div id="stProfiles"></div></div>`);
  add('playlists', pl);
  const list = pl.querySelector('#stProfiles');
  if (!state.profiles.length) list.innerHTML = '<p class="muted">No playlist yet.</p>';
  for (const p of state.profiles) {
    const where = p.type === 'xtream' ? `Xtream Codes · ${p.server} · ${p.username}` : p.m3uUrl ? `M3U · ${new URL(p.m3uUrl).host}` : `M3U file · ${p.m3uFile}`;
    const row = h(`<div class="profile-row"><div class="txt"><b>${esc(p.name)}</b> ${p.id === s.activeProfile ? '<span class="tag on">In use</span>' : ''}<div class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(where)}</div></div>
      ${p.id !== s.activeProfile ? '<button class="btn small" data-a="use">Use</button>' : ''}<button class="btn small" data-a="edit">Edit</button><button class="btn small danger apart" data-a="del">Delete</button></div>`);
    row.querySelectorAll('button').forEach(b => b.onclick = async () => {
      if (b.dataset.a === 'use') return useProfile(p.id);
      if (b.dataset.a === 'edit') return editProfile(p);
      if (!(await confirmBox('Delete playlist', `Delete "${p.name}" from Seal IPTV, with its favorites, watched marks and resume points? Your provider account isn't affected.`, 'Delete', true))) return;
      try {
        state.profiles = await call('profiles:delete', p.id);
        const init = await call('app:init');
        state.settings = init.settings; state.summary = init.catalog;
        renderProfiles(); updateCounts(); render();
        toast(`Deleted "${p.name}".`);
      } catch (e) { fail(e); }
    });
    list.appendChild(row);
  }
  pl.querySelector('#stAdd').onclick = () => editProfile(null);

  /* ---- sync ---- */
  add('sync', h('<div class="panel" id="syncPanel"></div>'));
  drawSyncPanel();

  /* ---- VPN ---- */
  const v = s.vpn;
  const vp = h(`<div class="panel"><h2>VPN</h2>
    <p class="muted small">Keep your IPTV provider from seeing your real IP. With this on, Seal IPTV only loads the playlist, posters and streams while your VPN is confirmed. If the VPN is off or stops working, nothing plays and you're told why.</p>
    <label class="check"><input type="checkbox" id="vReq" ${v.required ? 'checked' : ''}> Only play when my VPN is on</label>
    <div id="vOpts" style="margin-top:10px">
      <label>Your VPN</label>
      <div class="seg" id="vProv"><button data-v="proton" class="${v.provider === 'proton' ? 'active' : ''}">ProtonVPN</button><button data-v="other" class="${v.provider === 'other' ? 'active' : ''}">Another VPN</button></div>
      <p class="muted small" id="vProvNote"></p>
      <div class="two-col">
        <div><label for="vAdapter">VPN network adapter</label><select id="vAdapter"></select></div>
        <div id="vIspBox"><label for="vIsp">The VPN's network name contains (optional)</label><input type="text" id="vIsp" value="${esc(v.ispMatch)}" placeholder="e.g. Mullvad" spellcheck="false"></div>
      </div>
      <div id="vHomeBox"><label>Your home IP (blocked if it shows up)</label>
        <div class="row gap"><input type="text" id="vHome" value="${esc(v.homeIp)}" placeholder="not set" spellcheck="false" style="max-width:220px"><button class="btn small" id="vHomeNow">Use my current IP</button></div>
        <p class="faint small">Turn the VPN off, click "Use my current IP", then turn the VPN back on.</p></div>
      <div class="vpn-box" id="vBox"></div>
      <div class="row gap"><button class="btn" id="vCheck">Check now</button><button class="btn ghost" id="vProton">Open ProtonVPN</button></div>
    </div></div>`);
  add('vpn', vp);
  const vOpts = vp.querySelector('#vOpts');
  const syncVpnUi = () => {
    const cur = state.settings.vpn;
    vOpts.style.opacity = cur.required ? '1' : '.55';
    vp.querySelectorAll('#vProv button').forEach(b => b.classList.toggle('active', b.dataset.v === cur.provider));
    show(vp.querySelector('#vIspBox'), cur.provider === 'other');
    show(vp.querySelector('#vHomeBox'), cur.provider === 'other');
    show(vp.querySelector('#vProton'), cur.provider === 'proton');
    vp.querySelector('#vProvNote').textContent = cur.provider === 'proton'
      ? 'Seal IPTV checks that the ProtonVPN adapter is up and asks Proton to confirm your traffic comes from a Proton server.'
      : 'Seal IPTV checks that the VPN adapter is up. For a stronger check, set your home IP and/or the VPN\'s network name (as ipinfo.io shows it).';
  };
  const fillAdapters = async () => {
    const sel = vp.querySelector('#vAdapter');
    const list = await call('vpn:adapters').catch(() => []);
    const cur = state.settings.vpn.adapter;
    const names = list.map(a => a.name);
    if (cur && !names.includes(cur)) list.push({ name: cur, address: 'not connected now' });
    sel.innerHTML = `<option value="">Automatic (${TV ? 'Android\'s VPN connection' : state.settings.vpn.provider === 'proton' ? 'finds "ProtonVPN"' : 'finds the VPN by name'})</option>` +
      list.map(a => `<option value="${esc(a.name)}">${esc(a.name)}${a.address ? ' — ' + esc(a.address) : ''}${a.vpnLike ? ' (VPN)' : ''}</option>`).join('');
    sel.value = cur;
  };
  vp.querySelector('#vReq').onchange = async e => {
    await saveSettings({ vpn: { required: e.target.checked } }, e.target.checked ? 'Seal IPTV now plays only while your VPN is on.' : 'The VPN check is off.');
    syncVpnUi();
    const st = await call('vpn:check').catch(() => null);
    if (st) onVpnStatus(st);
  };
  vp.querySelectorAll('#vProv button').forEach(b => b.onclick = async () => { await saveSettings({ vpn: { provider: b.dataset.v } }); syncVpnUi(); fillAdapters(); onVpnStatus(await call('vpn:check')); });
  vp.querySelector('#vAdapter').onchange = async e => { await saveSettings({ vpn: { adapter: e.target.value } }); onVpnStatus(await call('vpn:check')); };
  vp.querySelector('#vIsp').onchange = async e => { await saveSettings({ vpn: { ispMatch: e.target.value } }); onVpnStatus(await call('vpn:check')); };
  vp.querySelector('#vHome').onchange = async e => { await saveSettings({ vpn: { homeIp: e.target.value } }); onVpnStatus(await call('vpn:check')); };
  vp.querySelector('#vHomeNow').onclick = async () => {
    try {
      const r = await call('vpn:publicIp');
      vp.querySelector('#vHome').value = r.ip;
      await saveSettings({ vpn: { homeIp: r.ip } }, `Home IP set to ${r.ip}${r.isp ? ' (' + r.isp + ')' : ''}.`);
      onVpnStatus(await call('vpn:check'));
    } catch (e) { fail(e); }
  };
  vp.querySelector('#vCheck').onclick = async () => { try { onVpnStatus(await call('vpn:check')); updateVpnBox(); } catch (e) { fail(e); } };
  vp.querySelector('#vProton').onclick = () => call('vpn:openProton').then(() => toast('Opening ProtonVPN…')).catch(fail);
  syncVpnUi(); fillAdapters(); updateVpnBox();

  /* ---- playback ---- */
  const pb = s.playback, net = s.network, sv = s.screensaver || {};
  const pp = h(`<div class="panel"><h2>Playback</h2>
    <label class="check"><input type="checkbox" id="pAuto" ${pb.autoWatched ? 'checked' : ''}> Mark movies and episodes as watched when I reach
      <select id="pPct" style="width:auto;margin-left:4px">${[80, 85, 90, 95].map(n => `<option value="${n}" ${pb.watchedPercent === n ? 'selected' : ''}>${n}%</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="pNext" ${pb.autoNext ? 'checked' : ''}> Play the next episode automatically</label>
    <label class="check"><input type="checkbox" id="pSaver" ${sv.on !== false ? 'checked' : ''}> Screensaver: the Seal IPTV logo moves around the screen after
      <select id="pSaverMin" style="width:auto;margin:0 4px">${[2, 5, 10, 15, 30, 60].map(n => `<option value="${n}" ${(sv.minutes || 5) === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select> with nothing playing</label>
    <div class="two-col">
      <div><label for="pResume">When I open something I've started</label><select id="pResume">
        <option value="ask" ${pb.resume === 'ask' ? 'selected' : ''}>Ask whether to resume</option>
        <option value="always" ${pb.resume === 'always' ? 'selected' : ''}>Always resume</option>
        <option value="never" ${pb.resume === 'never' ? 'selected' : ''}>Always start from the beginning</option></select></div>
      <div><label for="pUa">Identify as (User-Agent)</label><select id="pUa">
        <option value="seal" ${net.userAgent === 'seal' ? 'selected' : ''}>Seal IPTV</option>
        <option value="vlc" ${net.userAgent === 'vlc' ? 'selected' : ''}>VLC (if the provider refuses other players)</option>
        <option value="custom" ${net.userAgent === 'custom' ? 'selected' : ''}>Custom…</option></select>
        <input type="text" id="pUaCustom" class="${net.userAgent === 'custom' ? '' : 'hidden'}" style="margin-top:6px" value="${esc(net.customUserAgent)}" placeholder="User-Agent" spellcheck="false"></div>
    </div>
    <div class="${TV ? 'tv-hide' : ''}"><label for="pExt">Other player for "Open in VLC"</label>
    <div class="row gap"><input type="text" id="pExt" value="${esc(pb.externalPlayer)}" placeholder="Finds VLC by itself" spellcheck="false"><button class="btn small" id="pExtPick">Choose…</button></div>
    <p class="faint small" id="pExtNote"></p></div>
    <p class="faint small">${TV ? 'Fire TV plays HEVC, AC-3 / E-AC-3 sound, MKV and TS itself. For anything else, use "Open in another app" (for example VLC for Fire TV); the VPN rule applies there too.' : 'Some movies use sound (AC-3, DTS) or formats the built-in player can\'t play. Use "Open in VLC" for those; the VPN rule applies there too.'}</p>
    <h3 style="margin-top:16px">Audio sync</h3>
    <p class="muted small">Bluetooth headphones and speakers often play the sound a little late. Seal IPTV can hold the picture back by the same amount. Each audio device keeps its own value; ${TV ? 'in the player press ☰ Menu → Audio sync.' : 'in the player use ⏱ Sync or the [ and ] keys.'}</p>
    <div class="vpn-box" id="avNow">Checking the sound output…</div>
    <div class="row gap"><button class="btn" id="avTest">Sync test…</button></div>
    <div id="avSaved" style="margin-top:8px"></div>
  </div>`);
  add('playback', pp);
  pp.querySelector('#pAuto').onchange = e => saveSettings({ playback: { autoWatched: e.target.checked } });
  pp.querySelector('#pPct').onchange = e => saveSettings({ playback: { watchedPercent: Number(e.target.value) } });
  pp.querySelector('#pNext').onchange = e => saveSettings({ playback: { autoNext: e.target.checked } });
  pp.querySelector('#pSaver').onchange = e => saveSettings({ screensaver: { on: e.target.checked } });
  pp.querySelector('#pSaverMin').onchange = e => saveSettings({ screensaver: { minutes: Number(e.target.value) } });
  pp.querySelector('#pResume').onchange = e => saveSettings({ playback: { resume: e.target.value } });
  pp.querySelector('#pUa').onchange = e => { show(pp.querySelector('#pUaCustom'), e.target.value === 'custom'); saveSettings({ network: { userAgent: e.target.value } }); };
  pp.querySelector('#pUaCustom').onchange = e => saveSettings({ network: { customUserAgent: e.target.value } });
  const extNote = () => call('play:findVlc').then(p => { pp.querySelector('#pExtNote').textContent = p ? `Uses ${p}` : 'VLC wasn\'t found on this PC.'; }).catch(() => {});
  pp.querySelector('#pExt').onchange = async e => { await saveSettings({ playback: { externalPlayer: e.target.value } }); extNote(); };
  const drawAv = async () => {
    await AvSync.refreshDevice();
    const ms = AvSync.get(), dev = AvSync.device();
    const box = pp.querySelector('#avNow');
    if (!box) return;
    box.className = 'vpn-box' + (ms ? ' ok' : '');
    box.innerHTML = `<b>${esc(dev || 'This PC\'s sound output')}</b>: ${ms ? `${ms > 0 ? '+' : ''}${ms} ms` : 'no delay'}<div class="muted small">${esc(AvSync.describe(ms))}</div>`;
    const saved = Object.entries((state.settings.playback.avSync || {}).devices || {}).filter(([n, v]) => v && n !== dev);
    const list = pp.querySelector('#avSaved');
    list.innerHTML = saved.length ? '<div class="small muted">Also saved:</div>' + saved.map(([n, v]) => `<div class="row gap small" style="margin-top:4px"><span>${esc(n)}: ${v > 0 ? '+' : ''}${v} ms</span><button class="btn small ghost" data-n="${esc(n)}">Forget</button></div>`).join('') : '';
    list.querySelectorAll('button').forEach(b => b.onclick = async () => { await saveSettings({ playback: { avSync: { device: b.dataset.n, forget: true } } }); drawAv(); });
  };
  pp.querySelector('#avTest').onclick = async () => { await AvSync.test(); drawAv(); };
  drawAv();
  pp.querySelector('#pExtPick').onclick = async () => {
    const f = await call('dialog:exe').catch(() => null);
    if (f) { pp.querySelector('#pExt').value = f; await saveSettings({ playback: { externalPlayer: f } }); extNote(); }
  };
  if (!TV) extNote();

  /* ---- parental controls ---- */
  const par = state.parental;
  const pc = h(`<div class="panel"><h2>Parental controls</h2>
    <p class="muted small">Locked categories need a PIN to open, and nothing from them shows up in "All", search, Home or Favorites until the PIN is entered.</p>
    <div class="row gap"><b>${par.hasPin ? '🔒 A PIN is set' : 'No PIN yet'}</b><span class="spacer"></span>
      <button class="btn${par.hasPin ? '' : ' primary'}" id="parSet">${par.hasPin ? 'Change PIN…' : 'Set a PIN…'}</button>${par.hasPin ? '<button class="btn danger apart" id="parRemove">Remove PIN</button>' : ''}</div>
    <label class="check"><input type="checkbox" id="parAdult" ${par.autoAdult !== false ? 'checked' : ''}> Lock every category with "Adult", "XXX" or "18+" in its name</label>
    <label class="check"><input type="checkbox" id="parSettings" ${par.hasPin && par.lockSettings ? 'checked' : ''} ${par.hasPin ? '' : 'disabled'}> Ask for the PIN to open Settings${par.hasPin ? '' : ' <span class="faint">(set a PIN first)</span>'}</label>
    <label for="parMins">After the PIN, keep locked categories (and Settings) open</label>
    <select id="parMins" style="max-width:320px">${[[0, 'Until I close Seal IPTV'], [15, 'For 15 minutes'], [60, 'For 1 hour'], [240, 'For 4 hours']].map(([n, t]) => `<option value="${n}" ${(par.unlockMinutes || 0) === n ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <p class="faint small">To lock other categories, right-click one in Live TV, Movies or Series, or use the list under Categories below. Changing these settings needs the PIN.</p>
    ${par.hasPin && par.unlocked ? '<button class="btn" id="parLock">Lock now</button>' : ''}</div>`);
  add('parental', pc);
  const parRefresh = async () => { state.parental = await call('parental:status'); updateLockBtn(); render(); };
  pc.querySelector('#parSet').onclick = async () => { if (await setPinDialog()) render(); };
  const rm = pc.querySelector('#parRemove');
  if (rm) rm.onclick = async () => {
    const r = await dialog({ title: 'Remove the PIN', okText: 'Remove PIN', danger: true, html: '<p>Without a PIN, locked categories can\'t be opened (you\'d be asked to set a new PIN). Enter the current PIN:</p><input type="password" id="pinOld" class="pin-input" inputmode="numeric" maxlength="8"><p id="pinErr" class="error center"></p>',
      onOk: async () => { try { state.parental = await call('parental:removePin', $('#pinOld').value); return true; } catch (e) { $('#pinErr').textContent = e.message; return false; } } });
    if (r) { toast('PIN removed.'); parRefresh(); }
  };
  pc.querySelector('#parAdult').onchange = async e => {
    const want = e.target.checked;
    try { const r = await withPin(() => call('parental:options', { autoAdult: want })); if (r === undefined) e.target.checked = !want; else { state.parental = r; toast(want ? 'Adult categories are locked.' : 'Adult categories are no longer locked automatically.'); } }
    catch (err) { e.target.checked = !want; fail(err); }
  };
  pc.querySelector('#parSettings').onchange = async e => {
    const want = e.target.checked;
    try { const r = await withPin(() => call('parental:options', { lockSettings: want })); if (r === undefined) e.target.checked = !want; else { state.parental = r; toast(want ? 'Settings now needs the parental PIN. It stays open until you lock or close Seal IPTV.' : 'Settings opens without the PIN again.'); } }
    catch (err) { e.target.checked = !want; fail(err); }
  };
  pc.querySelector('#parMins').onchange = async e => {
    try { const r = await withPin(() => call('parental:options', { unlockMinutes: Number(e.target.value) })); if (r) state.parental = r; else render(); }
    catch (err) { fail(err); }
  };
  const lk = pc.querySelector('#parLock');
  if (lk) lk.onclick = async () => { state.parental = await call('parental:lock'); afterLock(); toast('Locked.'); render(); };

  /* ---- categories: hide, lock, languages ---- */
  if (profile()) {
    state.catTab = state.catTab || 'live';
    const cp = h(`<div class="panel" id="catPanel"><h2>Categories</h2>
      <label class="check"><input type="checkbox" id="cForeign" ${s.content && s.content.hideNonEnglish ? 'checked' : ''}> Hide channels, movies and series that aren't in English</label>
      <p class="faint small">Seal IPTV goes by what providers write: language tags and names in category names ("FR | Films", "ARABIC MOVIES", "Latino"), tags in front of titles ("DE - …") and titles in another script. Something it gets wrong can be shown with "Show anyway".</p>
      <div class="row gap" style="margin-top:10px"><div class="seg" id="cTabs"><button data-s="live">Live TV</button><button data-s="movies">Movies</button><button data-s="series">Series</button></div>
        <input type="search" id="cFilter" placeholder="Find a category" style="max-width:260px"></div>
      <div class="cat-table" id="cTable"><div class="empty">Loading…</div></div></div>`);
    add('categories', cp);
    cp.querySelector('#cForeign').onchange = async e => { await saveSettings({ content: { hideNonEnglish: e.target.checked } }, e.target.checked ? 'Categories and titles in other languages are hidden.' : 'Everything is shown again.'); drawCats(); };
    cp.querySelectorAll('#cTabs button').forEach(b => b.onclick = () => { state.catTab = b.dataset.s; drawCats(); });
    cp.querySelector('#cFilter').oninput = () => drawCats(true);
    let catCache = null;
    const drawCats = async (keep) => {
      const section = state.catTab;
      cp.querySelectorAll('#cTabs button').forEach(b => b.classList.toggle('active', b.dataset.s === section));
      if (!keep || !catCache || catCache.section !== section) {
        try { catCache = { section, list: (await call('catalog:cats', section, { all: true })).cats }; } catch (e) { return fail(e); }
      }
      const q = cp.querySelector('#cFilter').value.trim().toLowerCase();
      const rows = catCache.list.filter(c => !q || c.name.toLowerCase().includes(q));
      const t = cp.querySelector('#cTable');
      t.innerHTML = '<div class="cat-row head"><span>Category</span><span>Titles</span><span>Hide</span><span>PIN lock</span><span>Other language</span></div>';
      if (!rows.length) t.appendChild(h('<div class="empty">No categories.</div>'));
      for (const c of rows) {
        const row = h(`<div class="cat-row"><span class="nm" title="${esc(c.name)}">${esc(c.name)}${c.adult ? '<span class="tag">Adult</span>' : ''}</span>
          <span class="muted">${c.count.toLocaleString()}</span>
          <label class="check"><input type="checkbox" data-k="hide" ${c.hide ? 'checked' : ''}> Hide</label>
          <label class="check"><input type="checkbox" data-k="lock" ${c.locked ? 'checked' : ''}> 🔒</label>
          <span>${c.foreign ? `<label class="check" title="Looks ${esc(c.lang)} (${esc(c.langWhy)})"><input type="checkbox" data-k="show" ${c.show ? 'checked' : ''}> Show anyway</label><span class="faint small">${esc(c.lang)}</span>` : '<span class="faint small">—</span>'}</span></div>`);
        row.querySelectorAll('input').forEach(inp => inp.onchange = async () => {
          const k = inp.dataset.k, on = inp.checked;
          const autoAdult = state.parental.autoAdult !== false;
          const patch = k === 'lock' ? { lock: on ? (c.adult && autoAdult ? null : true) : (c.adult && autoAdult ? false : null) } : { [k]: on };
          if (k === 'lock' && on && !state.parental.hasPin && !(await setPinDialog())) { inp.checked = !on; return; }
          if (await setCatFlag(state.catTab, c, patch)) { catCache = null; drawCats(); }
          else inp.checked = !on;
        });
        t.appendChild(row);
      }
    };
    drawCats();
  }

  /* ---- posters the provider doesn't have (artwork.js) ---- */
  const art = s.artwork || { lookup: true, tmdbKey: '' };
  const ap = h(`<div class="panel"><h2>Posters &amp; trending</h2>
    <label class="check"><input type="checkbox" id="aOn" ${art.lookup ? 'checked' : ''}> Fill in missing posters: series from TVmaze, movies and series from TMDB</label>
    <p class="muted small">Only the title and year are sent to look a poster up, never your provider or login. Nothing is looked up while the VPN check is blocking.</p>
    <label for="aKey">TMDB API key (needed for movies)</label>
    <div class="row gap"><input type="password" id="aKey" value="${esc(art.tmdbKey || '')}" placeholder="Paste your free TMDB key" spellcheck="false" autocomplete="off" style="max-width:420px"><button class="btn" id="aTest">Test key</button><button class="btn ghost" id="aAgain">Look up again</button></div>
    <p class="faint small">Free: sign up at themoviedb.org, then Settings → API. The "API Key" or the "API Read Access Token" works. ${TV ? 'Easiest to paste on a PC: it syncs to this TV.' : 'It syncs to your other devices, so you only paste it once.'}</p>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="aTrend" ${art.trending !== false ? 'checked' : ''}> Trending movies and series on Home</label>
    <p class="muted small">What's popular on Netflix, Disney+, Apple TV, Hulu, Peacock, Paramount+, Prime Video and HBO Max, when your playlist has it: from Netflix's own Top 10 and TVmaze, and from TMDB when a key is set (it adds movies from the other services). These are the same lists for everyone: nothing about you or your provider is sent.</p>
    <p class="faint small">This product uses the TMDB API but is not endorsed or certified by TMDB. Series posters and streaming schedules from TVmaze (tvmaze.com). Netflix Top 10 from top10.netflix.com.</p></div>`);
  add('posters', ap);
  ap.querySelector('#aTrend').onchange = e => saveSettings({ artwork: { trending: e.target.checked } }, e.target.checked ? 'Trending movies and series will be on Home.' : 'No trending on Home.');
  ap.querySelector('#aOn').onchange = e => saveSettings({ artwork: { lookup: e.target.checked } }, e.target.checked ? 'Missing posters will be filled in.' : 'Posters are only taken from your provider.');
  ap.querySelector('#aKey').onchange = e => saveSettings({ artwork: { tmdbKey: e.target.value } }, e.target.value.trim() ? 'TMDB key saved.' : 'TMDB key removed.');
  ap.querySelector('#aTest').onclick = async () => {
    const key = ap.querySelector('#aKey').value;
    try { await call('art:testKey', key); await saveSettings({ artwork: { tmdbKey: key } }); toast('The TMDB key works.'); }
    catch (e) { fail(e); }
  };
  ap.querySelector('#aAgain').onclick = async () => {
    try { await call('art:clear'); toast('Posters will be looked up again.'); } catch (e) { fail(e); }
  };

  /* ---- playlist updates + library ---- */
  const lp = h(`<div class="panel"><h2>Playlist updates and history</h2>
    <label for="cRefresh">Reload the playlist from the provider</label>
    <select id="cRefresh" style="max-width:320px">${[[6, 'When it\'s older than 6 hours'], [12, 'When it\'s older than 12 hours'], [24, 'Once a day'], [72, 'Every 3 days'], [168, 'Once a week'], [0, 'Only when I click Reload']].map(([n, t]) => `<option value="${n}" ${s.catalog.refreshHours === n ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <div class="row gap" style="margin-top:14px"><button class="btn danger" id="cClear" ${profile() ? '' : 'disabled'}>Clear watched marks and resume points…</button></div>
    <p class="faint small">Only for the playlist in use. Favorites are kept.</p></div>`);
  add('library', lp);
  lp.querySelector('#cRefresh').onchange = e => saveSettings({ catalog: { refreshHours: Number(e.target.value) } });
  lp.querySelector('#cClear').onclick = async () => {
    if (!(await confirmBox('Clear history', `Forget every watched mark and resume point for "${profile().name}"?`, 'Clear', true))) return;
    try { await call('lib:clearHistory'); toast('Watch history cleared.'); } catch (e) { fail(e); }
  };

  /* ---- about ---- */
  add('about', h(`<div class="panel"><h2>About</h2>
    <div class="row gap"><img src="logo.svg" alt="" style="width:48px;height:48px"><div><b>Seal IPTV${TV ? ' for Fire TV' : ''} ${esc(state.version)}</b><div class="muted small">A player for the IPTV service you subscribe to. Seal IPTV doesn't provide any channels or content.</div></div></div>
    ${aboutPlaylist()}
    <div class="row gap" style="margin-top:14px"><button class="btn" id="uCheck">Check for updates</button><span class="small muted" id="uBox"></span></div>
    <label class="check"><input type="checkbox" id="uAuto" ${s.updates && s.updates.check ? 'checked' : ''}> Look for a new version when Seal IPTV starts</label>
    <p class="faint small selectable" style="margin-top:10px">Your settings and library: ${esc(state.dataDir)}</p></div>`));
  $('#uCheck').onclick = () => Upd.check(true);
  $('#uAuto').onchange = e => saveSettings({ updates: { check: e.target.checked } });
  Upd.drawBox();
  settingsSections(wrap, page);
}

/* Settings in sections: the list on the left, one section on the right (as on Google TV / Apple TV).
   On a TV, moving through the list shows each section; OK (or →) goes into it, Back comes out. */
const SETTINGS_SECTIONS = [
  ['playlists', '📋', 'Playlists', () => (profile() || {}).name || 'None yet'],
  ['sync', '🔄', 'Sync', () => state.sync && state.sync.connected ? 'On' : 'Off'],
  ['vpn', '🛡️', 'VPN', () => state.settings.vpn.required ? 'Only plays with the VPN on' : 'Off'],
  ['playback', '▶️', 'Playback', () => 'Watched, resume, screensaver, audio sync'],
  ['parental', '🔒', 'Parental controls', () => !state.parental.hasPin ? 'No PIN' : state.parental.lockSettings ? 'PIN set · Settings locked' : 'PIN set'],
  ['categories', '🗂️', 'Categories', () => 'Hide, lock, languages'],
  ['posters', '🖼️', 'Posters & trending', () => ((state.settings.artwork || {}).lookup ? 'Filling in missing posters' : 'From the provider only') + ((state.settings.artwork || {}).trending !== false ? ' · trending on' : '')],
  ['library', '🕘', 'Updates & history', () => 'Playlist reloads, watch history'],
  ['about', 'ℹ️', 'About', () => 'Version ' + state.version]
];
function settingsSections(wrap, page) {
  const nav = wrap.querySelector('#setNav');
  const panels = [...page.children];
  const secs = SETTINGS_SECTIONS.filter(([k]) => panels.some(p => p.dataset.sec === k));
  if (!secs.some(([k]) => k === state.setSec)) state.setSec = 'playlists';
  const showSec = k => {
    if (state.setSec !== k) page.scrollTop = 0;
    state.setSec = k;
    for (const p of panels) p.classList.toggle('hidden', p.dataset.sec !== k);
    nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.sec === k));
  };
  for (const [k, ico, name, sub] of secs) {
    let note = '';
    try { note = sub(); } catch { /* not known yet */ }
    const b = h(`<button class="set-item" data-sec="${k}"><span class="ico">${ico}</span><span class="txt"><b>${esc(name)}</b><span class="faint small">${esc(note)}</span></span></button>`);
    b.onclick = () => {
      showSec(k);
      if (TV) { const first = [...page.querySelector(`[data-sec="${k}"]`).querySelectorAll(FOCUSABLE_IN_VIEW)].find(x => x.offsetParent); if (first) first.focus(); }
    };
    if (TV) b.onfocus = () => showSec(k);
    nav.appendChild(b);
  }
  showSec(state.setSec);
}

/** Settings → About: what the playlist in use holds, and the account (they were on Home) */
function aboutPlaylist() {
  const sum = state.summary;
  if (!profile() || !sum || !sum.fetchedAt) return '';
  const c = sum.counts || {}, acc = sum.account;
  return `<div class="about-stats">
    <div><span class="muted small">📺 Live channels</span><b>${(c.live || 0).toLocaleString()}</b></div>
    <div><span class="muted small">🎬 Movies</span><b>${(c.movies || 0).toLocaleString()}</b></div>
    <div><span class="muted small">🎞️ Series</span><b>${(c.series || 0).toLocaleString()}</b></div>
    ${acc ? `<div><span class="muted small">👤 Account</span><b>${acc.expires ? 'Until ' + esc(fmtDate(acc.expires)) : 'No end date'}</b>${acc.maxConnections ? `<span class="faint small">${acc.maxConnections} connection${acc.maxConnections === 1 ? '' : 's'}</span>` : ''}</div>` : ''}
  </div><p class="faint small">${esc(profile().name)} · updated ${esc(fmtDate(sum.fetchedAt))} ${esc(fmtClock(sum.fetchedAt))}</p>`;
}

function updateVpnBox() {
  const box = $('#vBox');
  if (!box) return;
  const s = state.vpn || {};
  box.className = 'vpn-box' + (!s.required ? '' : s.ok ? ' ok' : ' bad');
  box.innerHTML = !s.required
    ? '<b>The VPN check is off.</b><div class="muted small">Seal IPTV plays with or without a VPN.</div>'
    : `<b>${s.ok ? '🛡️ ' : '⚠️ '}${esc(s.title)}</b><div class="muted small">${esc(s.detail || '')}</div>${s.ip ? `<div class="faint small">Public IP ${esc(s.ip)}${s.isp ? ' · ' + esc(s.isp) : ''}${s.adapter ? ' · adapter ' + esc(s.adapter) : ''}</div>` : ''}`;
}

/* =================================================================
 * 11b. SYNC PANEL (Settings → Sync; seal-iptv-server on your website)
 * ================================================================= */
let syncForm = { mode: 'connect', server: '', username: '', deviceName: '' };

function drawSyncPanel() {
  const box = $('#syncPanel');
  if (!box) return;
  if (box.contains(document.activeElement) && /INPUT/.test(document.activeElement.tagName)) return;   // don't redraw while typing
  const s = state.sync || {};
  if (s.connected && s.needs !== 'signin') {
    box.innerHTML = `<h2>Sync</h2>
      <p class="muted small">Playlists, favorites, watched marks, resume points, hidden and locked categories, the parental PIN and settings stay the same on every Seal IPTV connected to your sync server.</p>
      <div class="vpn-box ${s.lastError ? 'bad' : 'ok'}"><b class="${s.lastError ? '' : 'sync-ok'}">${s.lastError ? '⚠️ ' + esc(s.lastError) : '✓ In sync'}</b>
        <div class="muted small">${esc(s.server)} · ${esc(s.username)} · this PC: ${esc(s.deviceName)}</div>
        <div class="faint small">${s.lastSync ? 'Last synced ' + esc(fmtDate(s.lastSync)) + ' ' + esc(fmtClock(s.lastSync)) : 'Not synced yet'} · ${(s.items || 0).toLocaleString()} records${s.waiting ? ` · ${s.waiting} waiting to send` : ''}</div>
        ${s.needs === 'passphrase' ? '<div class="small" style="margin-top:6px">The vault passphrase was changed on another PC. Disconnect, then connect again with the new passphrase.</div>' : ''}</div>
      <div class="row gap"><button class="btn primary" id="syNow">⟳ Sync now</button><button class="btn" id="syDevs">Devices…</button><span class="spacer"></span><button class="btn ghost" id="syOff">Disconnect</button><button class="btn danger apart" id="syDel">Delete vault…</button></div>`;
    box.querySelector('#syNow').onclick = async () => { try { state.sync = await call('sync:now'); drawSyncPanel(); toast('Synced.'); } catch (e) { state.sync = await call('sync:status'); drawSyncPanel(); fail(e); } };
    box.querySelector('#syDevs').onclick = syncDevices;
    box.querySelector('#syOff').onclick = async () => {
      if (!(await confirmBox('Disconnect', 'Stop syncing this PC? Everything stays on this PC and in the vault; you can connect again later.', 'Disconnect', true))) return;
      await call('sync:disconnect'); state.sync = await call('sync:status'); drawSyncPanel(); toast('This PC no longer syncs.');
    };
    box.querySelector('#syDel').onclick = async () => {
      const r = await dialog({ title: 'Delete the vault', okText: 'Delete vault', danger: true,
        html: '<p>This deletes everything stored on the sync server and signs out every PC. Each PC keeps its own copy of everything.</p><label for="dvPass">Vault passphrase</label><input type="password" id="dvPass"><p id="dvErr" class="error"></p>',
        onOk: async () => { try { await call('sync:destroy', $('#dvPass').value); return true; } catch (e) { $('#dvErr').textContent = e.message; return false; } } });
      if (r) { state.sync = await call('sync:status'); drawSyncPanel(); toast('Vault deleted.'); }
    };
    return;
  }
  const f = syncForm;
  if (s.connected && s.needs === 'signin') { f.server = f.server || s.server; f.username = f.username || s.username; f.mode = 'connect'; }
  const create = f.mode === 'create';
  box.innerHTML = `<h2>Sync</h2>
    <p class="muted small">Keep every Seal IPTV the same — playlists, favorites, watched marks, resume points, category choices, the parental PIN and settings. It needs the <b>Seal IPTV Sync Server</b> on your website (the seal-iptv-server folder; see its README). Everything is encrypted on this PC first: the server can't read any of it.</p>
    ${s.needs === 'signin' ? '<div class="vpn-box bad"><b>This PC was signed out.</b><div class="muted small">Sign in again with the vault passphrase.</div></div>' : ''}
    <div class="seg" id="syMode"><button data-m="connect" class="${create ? '' : 'active'}">Connect to my vault</button><button data-m="create" class="${create ? 'active' : ''}">Create a new vault</button></div>
    <div class="two-col">
      <div><label for="syServer">Sync server address</label><input type="url" id="syServer" value="${esc(f.server)}" placeholder="https://example.com/iptv-sync/" spellcheck="false"></div>
      <div><label for="syDevice">This ${TV ? 'TV' : 'PC'}'s name</label><input type="text" id="syDevice" value="${esc(f.deviceName || state.hostname)}"></div>
      <div><label for="syUser">Username</label><input type="text" id="syUser" value="${esc(f.username)}" spellcheck="false" autocomplete="off"></div>
      <div><label for="syPass">Vault passphrase</label><input type="password" id="syPass" autocomplete="new-password" placeholder="at least 10 characters"></div>
      ${create ? `<div><label for="syPass2">Vault passphrase again</label><input type="password" id="syPass2" autocomplete="new-password"></div>
      <div><label for="syCode">Setup code (in config.php on the server)</label><input type="text" id="syCode" spellcheck="false" autocomplete="off"></div>` : ''}
    </div>
    ${create ? '<p class="faint small">Write the passphrase down. Nobody can recover it — not even from the server.</p>' : ''}
    <div class="row gap" style="margin-top:10px"><button class="btn primary" id="syGo">${create ? 'Create vault and sync' : 'Connect and sync'}</button><button class="btn ghost" id="syCheck">Check the server</button><span class="small muted" id="syMsg"></span></div>
    <p id="syErr" class="error"></p>`;
  const keep = () => { f.server = $('#syServer').value.trim(); f.username = $('#syUser').value.trim(); f.deviceName = $('#syDevice').value.trim(); };
  box.querySelectorAll('#syMode button').forEach(b => b.onclick = () => { keep(); f.mode = b.dataset.m; drawSyncPanel(); });
  box.querySelector('#syCheck').onclick = async () => {
    keep(); $('#syErr').textContent = ''; $('#syMsg').textContent = 'Checking…';
    try {
      const p = await call('sync:probe', f.server);
      $('#syMsg').textContent = p.vault ? '✓ Found it. A vault exists: connect to it.' : p.setupOpen ? '✓ Found it. No vault yet: create one.' : '✓ Found it, but no vault yet and no setup code in config.php.';
      if (!p.vault && f.mode !== 'create' && p.setupOpen) { f.mode = 'create'; drawSyncPanel(); $('#syMsg').textContent = '✓ Found it. No vault yet: create one.'; }
    } catch (e) { $('#syMsg').textContent = ''; $('#syErr').textContent = e.message; }
  };
  box.querySelector('#syGo').onclick = async () => {
    keep(); $('#syErr').textContent = '';
    const pass = $('#syPass').value;
    if (create && pass !== $('#syPass2').value) { $('#syErr').textContent = 'The two passphrases are different.'; return; }
    busy(create ? 'Creating the vault…' : 'Connecting…');
    try {
      const r = await call('sync:connect', { server: f.server, username: f.username, passphrase: pass, create, setupCode: create ? $('#syCode').value.trim() : '', deviceName: f.deviceName || state.hostname });
      state.sync = r;
      busy(false);
      toast(`${create ? 'Vault created' : 'Connected'}: ${r.items.toLocaleString()} records in sync.${r.joined && r.joined.length ? ` "${r.joined.join('", "')}" was already on this PC and is now one playlist.` : ''}`);
      await refreshAll(['profile']);
    } catch (e) { busy(false); $('#syErr').textContent = e.message; }
  };
}

async function syncDevices() {
  let list;
  try { list = await call('sync:devices'); } catch (e) { return fail(e); }
  await dialog({
    title: 'Devices', okText: 'Close', hideCancel: true,
    html: `<p class="muted small">Every Seal IPTV signed in to this vault. Sign out one you no longer use (it can sign in again with the passphrase).</p><div id="devList">${list.map(d => `<div class="dev-row"><div style="flex:1"><b>${esc(d.name)}</b>${d.current ? ' <span class="tag on">this PC</span>' : ''}<div class="faint small">Last seen ${esc(fmtDate(d.lastSeen * 1000))} ${esc(fmtClock(d.lastSeen * 1000))}</div></div>${d.current ? '' : `<button class="btn small danger" data-id="${esc(d.id)}">Sign out</button>`}</div>`).join('')}</div>`,
    onOpen: () => $$('#devList button').forEach(b => b.onclick = async () => { try { await call('sync:revoke', b.dataset.id); b.closest('.dev-row').remove(); toast('Signed out.'); } catch (e) { fail(e); } })
  });
}

/* =================================================================
 * 12. PLAYLIST DIALOG
 * ================================================================= */
async function editProfile(p) {
  const isNew = !p;
  p = p || { type: 'xtream', name: '', server: '', username: '', m3uUrl: '', m3uFile: '', liveFormat: 'auto' };
  let type = p.type;
  let file = p.m3uFile || '';
  const r = await dialog({
    title: isNew ? 'Add a playlist' : 'Edit playlist', okText: isNew ? 'Add' : 'Save', wide: true,
    html: `<div class="seg" id="pfType"><button data-t="xtream">Xtream Codes login</button><button data-t="m3u">M3U playlist</button></div>
      <p class="muted small" id="pfHint"></p>
      <label for="pfName">Name</label><input type="text" id="pfName" value="${esc(p.name)}" placeholder="e.g. My IPTV">
      <div id="pfX">
        <label for="pfServer">Server address</label><input type="url" id="pfServer" value="${esc(p.server || '')}" placeholder="http://provider.example.com:8080" spellcheck="false">
        <div class="two-col">
          <div><label for="pfUser">Username</label><input type="text" id="pfUser" value="${esc(p.username || '')}" spellcheck="false" autocomplete="off"></div>
          <div><label for="pfPass">Password</label><input type="password" id="pfPass" placeholder="${isNew ? '' : '(unchanged)'}" autocomplete="new-password"></div>
        </div>
        <label for="pfFmt">Live TV streams as</label>
        <select id="pfFmt" style="max-width:320px"><option value="auto">Automatic</option><option value="m3u8">HLS (.m3u8)</option><option value="ts">MPEG-TS (.ts)</option></select>
      </div>
      <div id="pfM">
        <label for="pfUrl">Playlist link</label><input type="url" id="pfUrl" value="${esc(p.m3uUrl || '')}" placeholder="https://… .m3u or .m3u8" spellcheck="false">
        <div class="row gap ${TV ? 'tv-hide' : ''}" style="margin-top:8px"><span class="muted small">or</span><button class="btn small" id="pfFile">Choose a file…</button><span class="small" id="pfFileName">${esc(file)}</span></div>
      </div>
      <label for="pfGuideMode">TV guide</label>
      <select id="pfGuideMode" style="max-width:420px"><option value="">Automatic</option><option value="url">From a guide address (XMLTV)</option><option value="off">Off</option></select>
      <input type="url" id="pfGuide" value="${esc(p.guide && p.guide !== 'off' ? p.guide : '')}" placeholder="http://… a guide's .xml or xmltv.php address" spellcheck="false" style="margin-top:8px">
      <p class="muted small" id="pfGuideHint"></p>
      <p id="pfErr" class="error"></p>`,
    onOpen: () => {
      const setType = t => {
        type = t;
        $$('#pfType button').forEach(b => b.classList.toggle('active', b.dataset.t === t));
        show($('#pfX'), t === 'xtream'); show($('#pfM'), t === 'm3u');
        $('#pfHint').textContent = t === 'xtream' ? 'The server, username and password from your provider (often called "Xtream Codes API" or "Login with Xtream").' : 'A link to an .m3u / .m3u8 playlist, or a playlist file on this PC.';
        guideHint();
      };
      const guideHint = () => {
        const m = $('#pfGuideMode').value;
        show($('#pfGuide'), m === 'url');
        $('#pfGuideHint').textContent = m === 'off' ? 'No guide: Live TV and the TV Guide show only the channels.'
          : m === 'url' ? 'An XMLTV guide (.xml). Seal IPTV downloads it every few hours and matches it to the channels by their guide id (tvg-id).'
          : type === 'xtream' ? 'Your provider\'s own guide, downloaded every few hours.' : 'This playlist has no guide of its own — choose "From a guide address" to add one.';
      };
      $('#pfGuideMode').value = p.guide === 'off' ? 'off' : p.guide ? 'url' : '';
      $('#pfGuideMode').onchange = guideHint;
      $$('#pfType button').forEach(b => b.onclick = () => setType(b.dataset.t));
      setType(type);
      $('#pfFmt').value = p.liveFormat || 'auto';
      $('#pfFile').onclick = async () => { const f = await call('dialog:m3uFile').catch(() => null); if (f) { file = f; $('#pfFileName').textContent = f; $('#pfUrl').value = ''; } };
      // an Xtream "get.php" link pasted as M3U: use the login instead (gets movies and series details too)
      $('#pfUrl').onchange = async () => {
        const x = await call('profiles:fromLink', $('#pfUrl').value).catch(() => null);
        if (x) {
          setType('xtream');
          $('#pfServer').value = x.server; $('#pfUser').value = x.username; $('#pfPass').value = x.password;
          $('#pfHint').textContent = 'That link is an Xtream Codes playlist, so Seal IPTV will use the login inside it. This also gets movie and series details.';
        }
      };
    },
    onOk: async () => {
      const gm = $('#pfGuideMode').value;
      if (gm === 'url' && !$('#pfGuide').value.trim()) { $('#pfErr').textContent = 'Enter the TV guide\'s address, or choose Automatic.'; return false; }
      const form = { id: p.id, type, name: $('#pfName').value.trim(), liveFormat: $('#pfFmt').value, guide: gm === 'url' ? $('#pfGuide').value.trim() : gm };
      if (type === 'xtream') Object.assign(form, { server: $('#pfServer').value.trim(), username: $('#pfUser').value.trim(), password: $('#pfPass').value });
      else Object.assign(form, { m3uUrl: $('#pfUrl').value.trim(), m3uFile: $('#pfUrl').value.trim() ? '' : file });
      $('#pfErr').textContent = type === 'xtream' ? 'Signing in…' : 'Checking the playlist…';
      try {
        const t = await call('profiles:test', form);
        const saved = await call('profiles:save', form);
        return { saved, test: t };
      } catch (e) {
        $('#pfErr').textContent = e.code === 'VPN' ? `${e.vpn.title}. ${e.vpn.detail}` : e.message;
        return false;
      }
    }
  });
  if (!r) return;
  const init = await call('app:init');
  state.profiles = init.profiles;
  state.settings = init.settings;
  if (isNew) {
    await useProfile(r.saved.id);
    toast(`Added "${r.saved.name}".`);
    await reload();
  } else {
    renderProfiles(); render();
    toast(`Saved "${r.saved.name}".`);
    // a new playlist link (or another server / login) for the playlist in use: load it now —
    // its streams' addresses have changed; favorites, watched and my categories move with them (catalog.js)
    const moved = p.type !== r.saved.type || (p.m3uUrl || '') !== (r.saved.m3uUrl || '') || (p.m3uFile || '') !== (r.saved.m3uFile || '') || (p.server || '') !== (r.saved.server || '') || (p.username || '') !== (r.saved.username || '');
    if (moved && state.settings.activeProfile === r.saved.id) await reload();
  }
}

/* =================================================================
 * 13. RELOADING THE PLAYLIST
 * ================================================================= */
let busyText = t => { $('#busyText').textContent = t; };
async function reload({ quiet = false } = {}) {
  if (state.refreshing || !profile()) return;
  state.refreshing = true;
  const btn = $('#refreshBtn');
  btn.disabled = true;
  if (quiet) { $('#refreshInfo').textContent = 'Updating the playlist…'; busyText = t => { $('#refreshInfo').textContent = t; }; }
  else { busy('Loading the playlist…'); busyText = t => { $('#busyText').textContent = t; }; }
  try {
    state.summary = await call('catalog:refresh');
    const c = state.summary.counts;
    const kept = state.summary.carried ? ` Your favorites, watched marks and categories were kept for ${state.summary.carried.toLocaleString()} title${state.summary.carried === 1 ? '' : 's'} with new links.` : '';
    toast(`Playlist loaded: ${c.live.toLocaleString()} channels, ${c.movies.toLocaleString()} movies, ${c.series.toLocaleString()} series.${kept}`);
    if (!['settings', 'movie', 'show'].includes(state.view)) render();
  } catch (e) {
    fail(e);
  } finally {
    state.refreshing = false;
    btn.disabled = false;
    busy(false);
    updateCounts();
  }
}

/** Open in VLC (same VPN rule). */
async function openExternal(req) {
  try { await call('play:external', req); toast(TV ? 'Choose the app to play it with…' : 'Opening in VLC…'); }
  catch (e) { fail(e); }
}

/* =================================================================
 * 14. UPDATES
 *    Windows: updater.js downloads the new app package; a restart runs it.
 *    Fire TV: the new pages download and the app reloads, or (when the
 *    Android part changed) Android's installer asks to install the APK.
 *    update:check -> { current, latest, available, kind, ready, notes, page, size, installer }
 *      kind 'app' | 'web': installed here; 'apk': Android installs it;
 *      'installer': the PC needs the new installer (page)
 * ================================================================= */
const Upd = {
  info: null, busy: false, later: false,
  async check(manual) {
    if (this.busy) return;
    if (manual) this.box('Checking…');
    try { this.info = await call('update:check'); }
    catch (e) { this.box(''); if (manual) fail(e); return; }
    if (this.info.available) { if (manual) this.later = false; this.bar(); }
    else if (manual) toast(`Seal IPTV ${state.version} is the newest version.`);
    this.drawBox();
  },
  box(text) { const b = $('#uBox'); if (b) b.textContent = text; },
  drawBox() {
    const i = this.info;
    if (!i) return this.box('');
    if (i.ready) return this.box(i.kind === 'apk' ? `Version ${i.latest} is downloaded: choose Install when Android asks.` : `Version ${i.latest} is ready: restart Seal IPTV to use it.`);
    this.box(i.available ? `Version ${i.latest} is available.` : `You have the newest version (${i.current}).`);
  },
  progress(p) {
    if (!this.busy || !p || !p.total) return;
    const t = $('#updBar .txt');
    if (t) t.textContent = `Downloading Seal IPTV ${this.info.latest}… ${Math.round((p.got / p.total) * 100)} %`;
  },
  bar() {
    const i = this.info;
    if (!i || !i.available || this.later) return;
    let bar = $('#updBar');
    if (!bar) { bar = h('<div id="updBar" class="upd-bar"></div>'); $('#topbar').after(bar); }
    const size = i.size ? ` (${(i.size / 1048576).toFixed(1)} MB)` : '';
    const what = i.ready ? `Seal IPTV ${i.latest} is ready.`
      : i.kind === 'installer' ? `Seal IPTV ${i.latest} is out. This one needs the new installer.`
      : `Seal IPTV ${i.latest} is available${size}.`;
    const label = i.ready ? (i.kind === 'apk' ? 'Install' : 'Restart now') : i.kind === 'installer' ? 'Get the installer' : 'Update';
    bar.innerHTML = `<span class="ico">⬆️</span><span class="txt">${esc(what)}</span><span class="spacer"></span>
      <button class="btn primary" id="updGo">${label}</button>${i.notes ? '<button class="btn ghost" id="updNotes">What\'s new</button>' : ''}<button class="btn ghost" id="updLater">Later</button>`;
    $('#updGo').onclick = () => this.go();
    if ($('#updNotes')) $('#updNotes').onclick = () => dialog({ title: `What's new in ${i.latest}`, html: `<p class="selectable" style="white-space:pre-wrap;max-height:50vh;overflow:auto">${esc(i.notes)}</p>`, okText: 'Close', hideCancel: true });
    $('#updLater').onclick = () => { this.later = true; bar.remove(); };
  },
  async go() {
    const i = this.info;
    if (this.busy) return;
    if (i.kind === 'installer') { call('update:openPage', i.installer || i.page).catch(fail); return; }
    if (i.ready && i.kind !== 'apk') { await call('update:restart').catch(fail); return; }
    this.busy = true;
    const btn = $('#updGo');
    if (btn) btn.disabled = true;
    if (!i.ready) $('#updBar .txt').textContent = `Downloading Seal IPTV ${i.latest}…`;
    try {
      const r = await call('update:install');
      i.ready = true;
      if (r && r.permission) toast('Allow Seal IPTV to install apps (turn it on), press Back, then choose Install again.');
      else if (i.kind === 'apk') toast('Android will ask you to install the update: choose Install.');
    } catch (e) { fail(e); }
    finally {
      this.busy = false;
      this.bar();
      this.drawBox();
    }
  }
};

/* =================================================================
 * 15. SCREENSAVER — the logo bouncing around the screen when nothing
 *     has played and nobody has touched anything for a while
 *     (Settings → Playback; per device). Any key, click or mouse move
 *     ends it; that key isn't used for anything else. Fire TV: tvnav.js
 *     asks sealWake() first for OK / Back / ☰ Menu.
 * ================================================================= */
const Saver = (() => {
  const SPEED = 70;   // px per second
  let last = Date.now(), el = null, raf = 0, mx = -1, my = -1;
  const minutes = () => { const s = state.settings && state.settings.screensaver; return !s || s.on === false ? 0 : Number(s.minutes) || 5; };
  // a video that's playing (paused counts as nothing playing; Fire TV: the player is Android's, open = playing)
  const playing = () => typeof Player !== 'undefined' && Player.isOpen() && (TV || !$('#video').paused);

  function begin() {
    el = h('<div id="saver"><img src="logo.svg" alt=""></div>');
    document.body.appendChild(el);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const img = el.firstElementChild;
    const size = 180;
    let x = Math.random() * Math.max(0, innerWidth - size), y = Math.random() * Math.max(0, innerHeight - size);
    let dx = Math.random() < 0.5 ? -1 : 1, dy = Math.random() < 0.5 ? -1 : 1, t0 = 0;
    const step = t => {
      const dt = t0 ? Math.min(0.1, (t - t0) / 1000) : 0;
      t0 = t;
      const maxX = Math.max(0, innerWidth - size), maxY = Math.max(0, innerHeight - size);
      x += dx * SPEED * dt; y += dy * SPEED * dt;
      if (x <= 0) { x = 0; dx = 1; } else if (x >= maxX) { x = maxX; dx = -1; }
      if (y <= 0) { y = 0; dy = 1; } else if (y >= maxY) { y = maxY; dy = -1; }
      img.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  /** someone's here: true when the screensaver was showing (and is gone now) */
  function wake() {
    last = Date.now();
    if (!el) return false;
    cancelAnimationFrame(raf);
    el.remove();
    el = null;
    if (TV && window.tvFocusFirst) window.tvFocusFirst();
    return true;
  }
  window.sealWake = wake;

  setInterval(() => {
    if (playing()) last = Date.now();
    const m = minutes();
    if (!el && m && Date.now() - last > m * 60000) begin();
  }, 5000);
  // the key / click that ends it does nothing else
  const swallow = e => { if (wake()) { e.preventDefault(); e.stopImmediatePropagation(); } };
  for (const ev of ['keydown', 'mousedown', 'wheel', 'touchstart']) window.addEventListener(ev, swallow, { capture: true, passive: false });
  // Chrome sends mouse moves when the page changes under a still mouse: only a real move counts
  window.addEventListener('mousemove', e => {
    const first = mx < 0;
    if (!first && Math.abs(e.screenX - mx) + Math.abs(e.screenY - my) < 6) return;
    mx = e.screenX; my = e.screenY;
    if (!first || !el) wake();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  return { wake, showing: () => !!el, start: begin };
})();

// two frames first, so the start-up screen is on show before the playlist is read
requestAnimationFrame(() => requestAnimationFrame(() => start().finally(endSplash).catch(e => { document.body.innerHTML = `<p style="padding:30px;color:#ff6464">Seal IPTV couldn't start: ${esc(e.message)}</p>`; })));
