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
function dialog({ title, html, okText = 'OK', cancelText = 'Cancel', hideCancel = false, onOk, extraText = null, wide = false, onOpen }) {
  return new Promise(resolve => {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    $('#dlgModal .modal-card').classList.toggle('wide', wide);
    const ok = $('#dlgOk'), cancel = $('#dlgCancel'), extra = $('#dlgExtra');
    ok.textContent = okText;
    cancel.textContent = cancelText;
    show(cancel, !hideCancel);
    extra.textContent = extraText || '';
    show(extra, !!extraText);
    show($('#dlgModal'), true);
    const done = v => { show($('#dlgModal'), false); ok.onclick = cancel.onclick = extra.onclick = $('#dlgX').onclick = null; document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); ok.click(); }
    };
    document.addEventListener('keydown', key, true);
    ok.onclick = async () => {
      ok.disabled = true;
      try { const v = onOk ? await onOk() : true; if (v !== false) done(v); } finally { ok.disabled = false; }
    };
    cancel.onclick = $('#dlgX').onclick = () => done(null);
    extra.onclick = () => done('extra');
    if (onOpen) onOpen();
    const first = $('#dlgBody').querySelector('input:not([type=checkbox]):not([type=radio]),select');
    setTimeout(() => (first || ok).focus(), 30);
  });
}
const confirmBox = (title, text, okText = 'OK') => dialog({ title, html: `<p>${esc(text)}</p>`, okText });

const initials = name => String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/** A movie's / series' title for looking up a poster the provider doesn't have (Art below). */
const artAttrs = art => (art && (art.kind === 'movie' || art.kind === 'series') && art.name ? ` data-ak="${art.kind}" data-an="${esc(art.name)}" data-ay="${Number(art.year) || ''}"` : '');
/** <img> that falls back to initials (see the error listener below); art: { kind, name, year } */
const pic = (src, name, cls = 'pi', art = null) => (src ? `<img class="${cls}" loading="lazy" src="${esc(src)}" data-i="${esc(initials(name))}"${artAttrs(art)} alt="">` : `<span class="initials"${artAttrs(art)}>${esc(initials(name))}</span>`);
document.addEventListener('error', e => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
  if (t.tagName === 'IMG' && t.dataset.i !== undefined) t.replaceWith(h(`<span class="initials"${artAttrs(t.dataset.ak && { kind: t.dataset.ak, name: t.dataset.an, year: t.dataset.ay })}>${esc(t.dataset.i)}</span>`));
}, true);
/* A kept picture (artwork.js) comes as a data: address of ~50 KB. A long grid never lets go of its
   cards, so it's shown as a blob: instead (a few bytes in the page), let go of once it's drawn: the
   picture then takes no more memory than one from the web. */
function artSrc(u) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(u || '');
  if (!m) return u;
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
      if (u && el.isConnected) el.replaceWith(h(`<img class="pi" src="${esc(artSrc(u))}" data-i="${esc(el.textContent)}" alt="">`));
      keep(u);
    });
  }
  /* A picture found on the site (not one already kept: those come as data:): fetched once more
     (from the browser's cache, mostly) and handed to artwork.js to keep, so it isn't asked for again. */
  let keeping = Promise.resolve();
  const tried = new Set();
  function keep(u) {
    if (!u || !/^https:\/\//.test(u) || tried.has(u)) return;
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
  hostname: ''
};
const profile = () => state.profiles.find(p => p.id === state.settings.activeProfile) || null;

async function start() {
  const r = await call('app:init');
  Object.assign(state, { version: r.version, settings: r.settings, profiles: r.profiles, summary: r.catalog, vpn: r.vpn, dataDir: r.dataDir, parental: r.parental, sync: r.sync, hostname: r.hostname });
  window.api.on('sync:applied', types => refreshAll(types).catch(() => {}));
  window.api.on('sync:status', s => { state.sync = s; if (state.view === 'settings') drawSyncPanel(); });
  updateLockBtn();
  window.api.on('vpn:status', onVpnStatus);
  window.api.on('catalog:step', t => { if (state.refreshing) { busyText(t); } });
  wireChrome();
  renderProfiles();
  updateVpn();
  updateCounts();
  go('home', null, { push: false });
  if (profile() && r.stale) autoRefresh();
  window.api.on('update:progress', p => Upd.progress(p));
  if (window.__sealStarted) window.__sealStarted();   // Fire TV: these pages work (UpdateManager)
  if (state.settings.updates && state.settings.updates.check) setTimeout(() => Upd.check(false), 6000);
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
const TITLES = { home: 'Home', live: 'Live TV', movies: 'Movies', series: 'Series', favorites: 'Favorites', collections: 'Collections', collection: 'Collections', settings: 'Settings', search: 'Search', movie: 'Movies', show: 'Series' };

function go(view, arg = null, { push = true } = {}) {
  if (push && (state.view !== view || state.arg !== arg)) state.history.push({ view: state.view, arg: state.arg });
  if (state.history.length > 50) state.history.shift();
  if (view !== state.view) state.favArrange = '';
  state.view = view;
  state.arg = arg;
  render();
}

function back() {
  const prev = state.history.pop();
  if (prev) { state.view = prev.view; state.arg = prev.arg; render(); }
}

/** The sort list's first choice: what "no sort chosen" means right now. */
function sortDefaultLabel() {
  const sec = state.sec[state.view];
  return state.q ? 'Best match' : sec && sec.cat === '*fav' ? 'Favorites order' : 'Playlist order';
}

function render() {
  const v = state.view;
  $$('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === v || (v === 'movie' && b.dataset.view === 'movies') || (v === 'show' && b.dataset.view === 'series') || (v === 'collection' && b.dataset.view === 'collections')));
  $('#viewTitle').textContent = TITLES[v] || '';
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
  ({ home: renderHome, live: renderLive, movies: renderBrowse, series: renderBrowse, favorites: renderFavorites, collections: renderCollections, collection: renderCollection, settings: renderSettings, search: renderSearch, movie: renderMovie, show: renderShow }[v] || renderHome)(view);
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
    t = setTimeout(() => {
      state.q = $('#search').value.trim();
      if (['live', 'movies', 'series'].includes(state.view)) { $('#sortSel').options[0].textContent = sortDefaultLabel(); updateHiddenSearchBtn(); return renderKeepSearch(); }
      if (state.q) { if (state.view === 'search') render(); else go('search'); }
      else if (state.view === 'search') back();
    }, 250);
  };
  $('#sortSel').onchange = () => { state.sec[state.view].sort = $('#sortSel').value; render(); };
  $('#refreshBtn').onclick = () => reload().catch(fail);
  $('#profileSel').onchange = () => useProfile($('#profileSel').value);
  $('#hiddenSearchBtn').onclick = toggleHiddenSearch;
  $('#lockBtn').onclick = async () => { state.parental = await call('parental:lock'); afterLock(); toast('Locked categories are locked again.'); };
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
    renderProfiles(); updateCounts();
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
  const more = async () => {
    if (loading || offset >= total || container._token !== token) return;
    loading = true;
    try {
      const r = await fetchPage(offset);
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
  Object.assign(state, { settings: r.settings, profiles: r.profiles, summary: r.catalog, parental: r.parental, sync: r.sync });
  renderProfiles(); updateCounts(); updateLockBtn(); updateVpn();
  // a playlist that came from another PC: download its channels here
  if (profile() && state.summary && !state.summary.fetchedAt && !state.refreshing) autoRefresh();
  if (!$('#player').classList.contains('hidden') || !$('#dlgModal').classList.contains('hidden')) return;
  if (state.view === 'settings') {
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    return render();
  }
  // resume points alone don't change the lists; everything else (or pages that show them) is drawn again
  const onlyPos = types.length && types.every(t => t === 'pos');
  if (!onlyPos || ['home', 'movie', 'show', 'favorites', 'collection'].includes(state.view)) render();
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
  items.push('-', { label: '⚙️ All categories…', run: () => { state.catTab = section; go('settings'); setTimeout(() => { const p = $('#catPanel'); if (p) p.scrollIntoView(); }, 50); } });
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
  const stats = h('<div class="stats"></div>');
  for (const [k, label, ico] of [['live', 'Live channels', '📺'], ['movies', 'Movies', '🎬'], ['series', 'Series', '🎞️']]) {
    const t = h(`<div class="stat" tabindex="0"><span class="muted small">${ico} ${label}</span><b>${(c[k] || 0).toLocaleString()}</b></div>`);
    t.onclick = () => go(k);
    stats.appendChild(t);
  }
  const acc = sum.account;
  if (acc) {
    stats.appendChild(h(`<div class="stat" style="cursor:default"><span class="muted small">👤 Account</span><b style="font-size:15px;margin-top:4px">${acc.expires ? 'Until ' + esc(fmtDate(acc.expires)) : 'No end date'}</b><span class="small faint">${acc.maxConnections ? `${acc.maxConnections} connection${acc.maxConnections === 1 ? '' : 's'}` : ''}</span></div>`));
  }
  home.appendChild(stats);

  const [cont, favLive, favMovies, favSeries, newMovies, newSeries] = await Promise.all([
    call('lib:continue'), call('lib:favorites', 'live'), call('lib:favorites', 'movie'), call('lib:favorites', 'series'),
    call('catalog:recent', 'movies'), call('catalog:recent', 'series')
  ].map(p => p.catch(() => [])));
  if (!home.isConnected) return;
  if (cont.length) home.appendChild(shelf('Continue watching', cont, continueCard, { wide: true }));
  if (favLive.length) home.appendChild(shelf('Favorite channels', favLive.slice(0, 30), f => channelCard({ id: f.id, name: f.name, logo: f.image, fav: true }), { more: () => { state.sec.live.cat = '*fav'; go('live'); } }));
  if (favMovies.length) home.appendChild(shelf('Favorite movies', favMovies.slice(0, 30), f => posterCard({ kind: 'movie', id: f.id, name: f.name, poster: f.image, fav: true }), { more: () => { state.sec.movies.cat = '*fav'; go('movies'); } }));
  if (favSeries.length) home.appendChild(shelf('Favorite series', favSeries.slice(0, 30), f => posterCard({ kind: 'series', id: f.id, name: f.name, poster: f.image, fav: true }), { more: () => { state.sec.series.cat = '*fav'; go('series'); } }));
  if (newMovies.length) home.appendChild(shelf('Recently added movies', newMovies, posterCard, { more: () => { state.sec.movies.sort = 'added'; state.sec.movies.cat = ''; go('movies'); } }));
  if (newSeries.length) home.appendChild(shelf('Recently added series', newSeries, posterCard, { more: () => { state.sec.series.sort = 'added'; state.sec.series.cat = ''; go('series'); } }));
  if (!cont.length && !favLive.length && !favMovies.length && !favSeries.length) {
    home.appendChild(h('<p class="muted" style="padding:10px 22px">Tip: click ☆ on a channel, movie or series to keep it on this page. Movies and episodes you start show up here so you can pick up where you left off.</p>'));
  }
}

function continueCard(p) {
  const name = p.kind === 'episode' ? (p.seriesName || p.name) : p.name;
  const sub = p.kind === 'episode' ? `${epLabel(p.season, p.episode)} · ${fmtLeft(p.pos, p.dur)}` : fmtLeft(p.pos, p.dur);
  const el = posterCard({ name, poster: p.image, pos: p.pos, dur: p.dur, sub }, { wide: true, onClick: () => resumeFromHome(p) });
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
  view.appendChild(h('<div class="live-info" id="liveInfo"><div class="empty">Choose a channel to see what\'s on.<br><span class="small faint">Double-click or press Enter to watch.</span></div></div>'));
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
  el.onkeydown = e => {
    if (e.key === 'Enter') playChannel(i);
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
  return el;
}

function playChannel(i) {
  const list = state.live.items;
  const it = list[i];
  if (!it) return;
  Player.play({ kind: 'live', id: it.id, name: it.name, image: it.logo, cat: it.catName }, { channels: list, index: i });
}

async function selectChannel(it, el) {
  $$('#chList .channel.active').forEach(x => x.classList.remove('active'));
  el.classList.add('active');
  state.live.sel = it;
  const box = $('#liveInfo');
  const i = state.live.items.indexOf(it);
  box.innerHTML = `<div class="big-logo">${pic(it.logo, it.name)}</div>
    <h2 style="font-size:18px">${esc(it.name)}</h2><p class="muted small">${esc(it.catName || '')}</p>
    <div class="actions"><button class="btn primary" id="liPlay">▶ Watch</button><button class="btn" id="liFav">${it.fav ? '★ Favorite' : '☆ Favorite'}</button><button class="btn ghost" id="liVlc" title="${OTHER_PLAYER}">${TV ? 'Other app' : 'VLC'}</button></div>
    <div id="liEpg"><p class="muted small">Loading what's on…</p></div>`;
  $('#liPlay').onclick = () => playChannel(i);
  $('#liVlc').onclick = () => openExternal({ kind: 'live', id: it.id, title: it.name });
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
  el.onclick = () => Player.play({ kind: 'live', id: it.id, name: it.name, image: it.logo });
  return el;
}

async function toggleFav(it, kind, meta) {
  try {
    it.fav = await call('lib:favorite', `${kind}:${it.id}`, !it.fav, meta);
    toast(it.fav ? `Added "${it.name}" to your favorites.` : `Removed "${it.name}" from your favorites.`);
  } catch (e) { fail(e); }
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
        const b = h(`<button class="btn small">📚 ${esc(c.name)} in order <span class="faint">· ${c.have} of ${c.total}</span></button>`);
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
    <div class="poster">${pic(it.poster || it.image, it.name, 'pi', { kind: it.kind, name: it.name, year: it.year })}
      ${it.fav ? '<span class="badge fav">★</span>' : ''}${it.watched ? '<span class="badge seen">✓ Watched</span>' : ''}${it.fromHidden ? '<span class="badge hid">Hidden category</span>' : ''}
      ${pct ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>
    <div class="title" title="${esc(opts.title || it.name)}">${esc(opts.title || it.name)}</div><div class="sub">${esc(sub)}</div></div>`);
  el.onclick = opts.onClick || (() => go(it.kind === 'series' ? 'show' : 'movie', it.id));
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
  page.innerHTML = `${i.backdrop || poster ? `<div class="backdrop" style="background-image:url('${esc(i.backdrop || poster)}')"></div>` : ''}
    <div class="inner">
      <button class="btn ghost small back" id="mBack">← Back</button>
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
  const draw = () => {
    actions.innerHTML = '';
    const add = (html, fn, cls = 'btn') => { const b = h(`<button class="${cls}">${html}</button>`); b.onclick = fn; actions.appendChild(b); };
    if (m.pos) {
      add(`▶ Resume from ${fmtTime(m.pos)}`, () => Player.play(req, { start: m.pos }), 'btn primary big');
      add('↺ Start over', () => Player.play(req, { start: 0 }), 'btn big');
    } else {
      add('▶ Play', () => Player.play(req), 'btn primary big');
    }
    add(m.fav ? '★ Favorite' : '☆ Favorite', async () => { await toggleFav(m, 'movie', { name, image: poster, cat: m.cat }); draw(); });
    add(m.watched ? '✓ Watched' : '○ Mark as watched', async () => {
      try { m.watched = await call('lib:watched', 'movie:' + m.id, !m.watched, { name, image: poster }); if (m.watched) m.pos = 0; draw(); }
      catch (e) { fail(e); }
    });
    add(OTHER_PLAYER, () => openExternal({ ...req, title: name, start: m.pos || 0 }), 'btn ghost');
    if (i.trailer) add('Trailer', () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(i.trailer)}`), 'btn ghost');
  };
  draw();
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
  page.innerHTML = `${i.backdrop || poster ? `<div class="backdrop" style="background-image:url('${esc(i.backdrop || poster)}')"></div>` : ''}
    <div class="inner">
      <button class="btn ghost small back" id="sBack">← Back</button>
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
      <div class="seasons" id="sSeasons"></div>
      <div id="sEpisodes"></div>
    </div>`;
  $('#sBack').onclick = back;
  if (!queue.length) { $('#sEpisodes').innerHTML = '<p class="muted">The provider lists no episodes for this series.</p>'; }

  // which season to show: the one with the next episode to watch
  const nextUp = () => queue.find(q => q.pos && !q.watched) || queue.find(q => !q.watched) || null;
  let season = (nextUp() || queue[0] || { season: (i.seasons[0] || {}).num }).season;

  const drawActions = () => {
    const a = $('#sActions');
    a.innerHTML = '';
    const add = (html, fn, cls = 'btn') => { const b = h(`<button class="${cls}">${html}</button>`); b.onclick = fn; a.appendChild(b); };
    const nx = nextUp();
    if (nx) add(`▶ ${nx.pos ? 'Resume' : queue.indexOf(nx) === 0 ? 'Play' : 'Continue'} ${epLabel(nx.season, nx.episode)}`, () => Player.play(nx, { queue, start: nx.pos || 0 }), 'btn primary big');
    else if (queue.length) add('↺ Watch again from the start', () => Player.play(queue[0], { queue, start: 0 }), 'btn big');
    add(d.fav ? '★ Favorite' : '☆ Favorite', async () => { await toggleFav(d, 'series', { name, image: poster, cat: d.cat }); drawActions(); });
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
  };

  const drawSeasons = () => {
    const box = $('#sSeasons');
    box.innerHTML = '';
    for (const s of i.seasons) {
      const seen = s.episodes.length && queue.filter(q => q.season === s.num).every(q => q.watched);
      const b = h(`<button class="season${s.num === season ? ' active' : ''}">${esc(s.name || 'Season ' + s.num)}${seen ? ' ✓' : ''}</button>`);
      b.onclick = () => { season = s.num; drawSeasons(); drawSeason(); drawActions(); };
      box.appendChild(b);
    }
  };

  const drawSeason = () => {
    const box = $('#sEpisodes');
    box.innerHTML = '';
    for (const q of queue.filter(x => x.season === season)) {
      const pct = q.dur ? Math.min(100, (q.pos / q.dur) * 100) : 0;
      const el = h(`<div class="episode${q.watched ? ' seen' : ''}" tabindex="0">
        <div class="thumb">${q.image ? `<img class="pi" loading="lazy" src="${esc(q.image)}" data-i="E${q.episode}" alt="">` : `<span>E${q.episode}</span>`}${pct ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>
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
  };
  drawActions(); drawSeasons(); drawSeason();
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
  const el = posterCard({ name: cv.name || c.name, kind: cv.kind, year: cv.year, poster: c.poster, sub: `${c.have} of ${c.total} in your playlist` }, { title: c.name, onClick: () => go('collection', c.id) });
  const ini = el.querySelector('.poster > .initials');
  if (ini) ini.textContent = initials(c.name);
  else el.querySelector('.poster > .pi').dataset.i = initials(c.name);
  // … until the collection's own poster comes back (TMDB, with a key; artwork.js remembers it)
  if (c.art && state.settings.artwork && state.settings.artwork.lookup) {
    call('art:find', [{ kind: 'collection', name: c.art }]).then(([u]) => {
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
    page.appendChild(h('<div class="empty">None of the collections are in your playlist yet.<br><span class="small">Marvel, Star Wars, Star Trek, Harry Potter and more show up here when the playlist has their movies or shows.</span></div>'));
    return;
  }
  page.appendChild(h('<div class="shelf"><p class="muted small col-note">The big franchises, movies and the shows that go with them, in the order they came out or in story order.</p></div>'));
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

async function renderCollection(view, focus) {
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

async function renderSearch(view) {
  const page = h('<div class="home"></div>');
  view.appendChild(page);
  if (!state.q) return;
  const [r, cols] = await Promise.all([call('catalog:search', state.q).catch(e => { fail(e); return null; }), call('collections:list', state.q).catch(() => [])]);
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
  const page = h('<div class="settings"></div>');
  view.appendChild(page);

  /* ---- playlists ---- */
  const pl = h(`<div class="panel"><div class="row"><h2 style="margin:0">Playlists</h2><span class="spacer"></span><button class="btn primary" id="stAdd">＋ Add playlist</button></div>
    <p class="muted small">Your IPTV provider's Xtream Codes login or M3U playlist. Favorites, watched marks and resume points are kept per playlist.</p><div id="stProfiles"></div></div>`);
  page.appendChild(pl);
  const list = pl.querySelector('#stProfiles');
  if (!state.profiles.length) list.innerHTML = '<p class="muted">No playlist yet.</p>';
  for (const p of state.profiles) {
    const where = p.type === 'xtream' ? `Xtream Codes · ${p.server} · ${p.username}` : p.m3uUrl ? `M3U · ${new URL(p.m3uUrl).host}` : `M3U file · ${p.m3uFile}`;
    const row = h(`<div class="profile-row"><div class="txt"><b>${esc(p.name)}</b> ${p.id === s.activeProfile ? '<span class="tag on">In use</span>' : ''}<div class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(where)}</div></div>
      ${p.id !== s.activeProfile ? '<button class="btn small" data-a="use">Use</button>' : ''}<button class="btn small" data-a="edit">Edit</button><button class="btn small danger" data-a="del">Delete</button></div>`);
    row.querySelectorAll('button').forEach(b => b.onclick = async () => {
      if (b.dataset.a === 'use') return useProfile(p.id);
      if (b.dataset.a === 'edit') return editProfile(p);
      if (!(await confirmBox('Delete playlist', `Delete "${p.name}" from Seal IPTV, with its favorites, watched marks and resume points? Your provider account isn't affected.`, 'Delete'))) return;
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
  page.appendChild(h('<div class="panel" id="syncPanel"></div>'));
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
  page.appendChild(vp);
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
  const pb = s.playback, net = s.network;
  const pp = h(`<div class="panel"><h2>Playback</h2>
    <label class="check"><input type="checkbox" id="pAuto" ${pb.autoWatched ? 'checked' : ''}> Mark movies and episodes as watched when I reach
      <select id="pPct" style="width:auto;margin-left:4px">${[80, 85, 90, 95].map(n => `<option value="${n}" ${pb.watchedPercent === n ? 'selected' : ''}>${n}%</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="pNext" ${pb.autoNext ? 'checked' : ''}> Play the next episode automatically</label>
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
  page.appendChild(pp);
  pp.querySelector('#pAuto').onchange = e => saveSettings({ playback: { autoWatched: e.target.checked } });
  pp.querySelector('#pPct').onchange = e => saveSettings({ playback: { watchedPercent: Number(e.target.value) } });
  pp.querySelector('#pNext').onchange = e => saveSettings({ playback: { autoNext: e.target.checked } });
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
      <button class="btn${par.hasPin ? '' : ' primary'}" id="parSet">${par.hasPin ? 'Change PIN…' : 'Set a PIN…'}</button>${par.hasPin ? '<button class="btn danger" id="parRemove">Remove PIN</button>' : ''}</div>
    <label class="check"><input type="checkbox" id="parAdult" ${par.autoAdult !== false ? 'checked' : ''}> Lock every category with "Adult", "XXX" or "18+" in its name</label>
    <label for="parMins">After the PIN, keep locked categories open</label>
    <select id="parMins" style="max-width:320px">${[[0, 'Until I close Seal IPTV'], [15, 'For 15 minutes'], [60, 'For 1 hour'], [240, 'For 4 hours']].map(([n, t]) => `<option value="${n}" ${(par.unlockMinutes || 0) === n ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <p class="faint small">To lock other categories, right-click one in Live TV, Movies or Series, or use the list under Categories below. Changing these settings needs the PIN.</p>
    ${par.hasPin && par.unlocked ? '<button class="btn" id="parLock">Lock now</button>' : ''}</div>`);
  page.appendChild(pc);
  const parRefresh = async () => { state.parental = await call('parental:status'); updateLockBtn(); render(); };
  pc.querySelector('#parSet').onclick = async () => { if (await setPinDialog()) render(); };
  const rm = pc.querySelector('#parRemove');
  if (rm) rm.onclick = async () => {
    const r = await dialog({ title: 'Remove the PIN', okText: 'Remove PIN', html: '<p>Without a PIN, locked categories can\'t be opened (you\'d be asked to set a new PIN). Enter the current PIN:</p><input type="password" id="pinOld" class="pin-input" inputmode="numeric" maxlength="8"><p id="pinErr" class="error center"></p>',
      onOk: async () => { try { state.parental = await call('parental:removePin', $('#pinOld').value); return true; } catch (e) { $('#pinErr').textContent = e.message; return false; } } });
    if (r) { toast('PIN removed.'); parRefresh(); }
  };
  pc.querySelector('#parAdult').onchange = async e => {
    const want = e.target.checked;
    try { const r = await withPin(() => call('parental:options', { autoAdult: want })); if (r === undefined) e.target.checked = !want; else { state.parental = r; toast(want ? 'Adult categories are locked.' : 'Adult categories are no longer locked automatically.'); } }
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
    page.appendChild(cp);
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
  const ap = h(`<div class="panel"><h2>Posters</h2>
    <label class="check"><input type="checkbox" id="aOn" ${art.lookup ? 'checked' : ''}> Fill in missing posters: series from TVmaze, movies and series from TMDB</label>
    <p class="muted small">Only the title and year are sent to look a poster up, never your provider or login. Nothing is looked up while the VPN check is blocking.</p>
    <label for="aKey">TMDB API key (needed for movies)</label>
    <div class="row gap"><input type="password" id="aKey" value="${esc(art.tmdbKey || '')}" placeholder="Paste your free TMDB key" spellcheck="false" autocomplete="off" style="max-width:420px"><button class="btn" id="aTest">Test key</button><button class="btn ghost" id="aAgain">Look up again</button></div>
    <p class="faint small">Free: sign up at themoviedb.org, then Settings → API. The "API Key" or the "API Read Access Token" works. ${TV ? 'Easiest to paste on a PC: it syncs to this TV.' : 'It syncs to your other devices, so you only paste it once.'}</p>
    <p class="faint small">This product uses the TMDB API but is not endorsed or certified by TMDB. Series posters from TVmaze (tvmaze.com).</p></div>`);
  page.appendChild(ap);
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
  page.appendChild(lp);
  lp.querySelector('#cRefresh').onchange = e => saveSettings({ catalog: { refreshHours: Number(e.target.value) } });
  lp.querySelector('#cClear').onclick = async () => {
    if (!(await confirmBox('Clear history', `Forget every watched mark and resume point for "${profile().name}"?`, 'Clear'))) return;
    try { await call('lib:clearHistory'); toast('Watch history cleared.'); } catch (e) { fail(e); }
  };

  /* ---- about ---- */
  page.appendChild(h(`<div class="panel"><h2>About</h2>
    <div class="row gap"><img src="logo.svg" alt="" style="width:48px;height:48px"><div><b>Seal IPTV${TV ? ' for Fire TV' : ''} ${esc(state.version)}</b><div class="muted small">A player for the IPTV service you subscribe to. Seal IPTV doesn't provide any channels or content.</div></div></div>
    <div class="row gap" style="margin-top:14px"><button class="btn" id="uCheck">Check for updates</button><span class="small muted" id="uBox"></span></div>
    <label class="check"><input type="checkbox" id="uAuto" ${s.updates && s.updates.check ? 'checked' : ''}> Look for a new version when Seal IPTV starts</label>
    <p class="faint small selectable" style="margin-top:10px">Your settings and library: ${esc(state.dataDir)}</p></div>`));
  $('#uCheck').onclick = () => Upd.check(true);
  $('#uAuto').onchange = e => saveSettings({ updates: { check: e.target.checked } });
  Upd.drawBox();
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
      <div class="row gap"><button class="btn primary" id="syNow">⟳ Sync now</button><button class="btn" id="syDevs">Devices…</button><span class="spacer"></span><button class="btn ghost" id="syOff">Disconnect</button><button class="btn danger" id="syDel">Delete vault…</button></div>`;
    box.querySelector('#syNow').onclick = async () => { try { state.sync = await call('sync:now'); drawSyncPanel(); toast('Synced.'); } catch (e) { state.sync = await call('sync:status'); drawSyncPanel(); fail(e); } };
    box.querySelector('#syDevs').onclick = syncDevices;
    box.querySelector('#syOff').onclick = async () => {
      if (!(await confirmBox('Disconnect', 'Stop syncing this PC? Everything stays on this PC and in the vault; you can connect again later.', 'Disconnect'))) return;
      await call('sync:disconnect'); state.sync = await call('sync:status'); drawSyncPanel(); toast('This PC no longer syncs.');
    };
    box.querySelector('#syDel').onclick = async () => {
      const r = await dialog({ title: 'Delete the vault', okText: 'Delete vault',
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
      <p id="pfErr" class="error"></p>`,
    onOpen: () => {
      const setType = t => {
        type = t;
        $$('#pfType button').forEach(b => b.classList.toggle('active', b.dataset.t === t));
        show($('#pfX'), t === 'xtream'); show($('#pfM'), t === 'm3u');
        $('#pfHint').textContent = t === 'xtream' ? 'The server, username and password from your provider (often called "Xtream Codes API" or "Login with Xtream").' : 'A link to an .m3u / .m3u8 playlist, or a playlist file on this PC.';
      };
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
      const form = { id: p.id, type, name: $('#pfName').value.trim(), liveFormat: $('#pfFmt').value };
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
    toast(`Playlist loaded: ${c.live.toLocaleString()} channels, ${c.movies.toLocaleString()} movies, ${c.series.toLocaleString()} series.`);
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

start().catch(e => { document.body.innerHTML = `<p style="padding:30px;color:#ff6464">Seal IPTV couldn't start: ${esc(e.message)}</p>`; });
