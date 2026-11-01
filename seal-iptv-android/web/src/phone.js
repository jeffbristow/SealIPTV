/* =====================================================================
 * Seal IPTV for Android phones — phone.js   (instead of tvnav.js)
 * ---------------------------------------------------------------------
 * The touch parts around the shared pages (app.js), with phone.css:
 *   tab bar      Home · Live TV · Guide · Movies · Series · More; More =
 *                the sidebar as a sheet (the rest of the pages, my
 *                categories, the playlist, VPN, Lock)
 *   top bar      ‹ (back) on pages opened from another page; the VPN pill
 *   categories   a "Category: …" button above Live TV / Movies / Series;
 *                the list opens as a sheet, with a filter box
 *   Settings     the list of sections; a section opens over it (‹ Settings)
 *   Back         (Android's back gesture; MainActivity asks __tvBack):
 *                sheet / menu / dialog / settings section, then the page
 *                before, then Home; false on Home = leave the app
 *   keyboard     the tab bar steps aside while a text box has it
 * Press and hold = the right-click menu (Android's WebView sends it as a
 * contextmenu event), shown as a sheet by phone.css.
 * ===================================================================== */
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const root = document.documentElement;
  const TABS = [['home', '🏠', 'Home'], ['live', '📺', 'Live TV'], ['guide', '🗓️', 'Guide'], ['movies', '🎬', 'Movies'], ['series', '🎞️', 'Series'], ['more', '☰', 'More']];
  const TAB_OF = { movie: 'movies', show: 'series' };
  const ROOTS = new Set(['home', 'live', 'guide', 'movies', 'series']);
  const sheet = (cls, on) => root.classList.toggle(cls, on);
  const st = () => (typeof state !== 'undefined' ? state : null);

  /* ---- the tab bar + the More sheet ---- */
  const tabs = document.createElement('div');   // (not a <nav>: styles.css stacks those)
  tabs.id = 'phTabs';
  for (const [v, ico, name] of TABS) {
    const b = document.createElement('button');
    b.className = 'ph-tab';
    b.dataset.tab = v;
    b.innerHTML = `<span class="ico">${ico}</span><span>${name}</span>`;
    b.onclick = () => {
      if (v === 'more') return sheet('ph-more', !root.classList.contains('ph-more'));
      sheet('ph-more', false);
      const s = st();
      // the tab you're on again: back to its start (scrolled up, no search)
      const nav = document.querySelector(`#nav .nav[data-view="${v}"]`);
      if (nav) nav.click();
      if (s) { s.history.length = 0; onPage(); }   // a tab is a fresh start: Back goes to Home, then leaves
      if (s && s.view === v) { const sc = $('#view').querySelector('.scroll, .home, .channels, .detail, .settings'); if (sc) sc.scrollTop = 0; }
    };
    tabs.appendChild(b);
  }
  $('#app').appendChild(tabs);
  const backdrop = document.createElement('div');
  backdrop.id = 'phBack';
  backdrop.onclick = () => { sheet('ph-more', false); sheet('ph-cats', false); };
  document.body.appendChild(backdrop);
  // a page chosen in the More sheet closes it
  $('#sidebar').addEventListener('click', e => { if (e.target.closest('.nav')) { sheet('ph-more', false); const s = st(); if (s) s.history.length = 0; onPage(); } });

  /* ---- the top bar: ‹ back, the VPN pill next to the title ---- */
  const up = document.createElement('button');
  up.id = 'phUp';
  up.className = 'hidden';
  up.textContent = '‹';
  up.setAttribute('aria-label', 'Back');
  up.onclick = () => window.__tvBack();
  $('#topbar').insertBefore(up, $('#topbar').firstChild);
  $('#topbar').insertBefore($('#vpnPill'), $('#refreshBtn'));
  const brk = document.createElement('span');   // the search box (+ sort) on a row of their own
  brk.className = 'ph-break';
  $('#topbar').appendChild(brk);

  /* ---- after every page drawn ---- */
  let setOpen = '';   // the Settings section open (kept when Settings is drawn again, e.g. after adding a playlist)
  function onPage() {
    const s = st();
    if (!s) return;
    const tab = TAB_OF[s.view] || s.view;
    tabs.querySelectorAll('.ph-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab || (b.dataset.tab === 'more' && !ROOTS.has(tab) && !root.classList.contains('ph-more'))));
    up.classList.toggle('hidden', !$('#view .settings-wrap.ph-open') && (ROOTS.has(s.view) || !s.history.length));
    if (s.view !== 'settings') setOpen = '';
    const view = $('#view');
    const cats = view.querySelector(':scope > .cats');
    if (cats && !view.querySelector('.ph-catbar')) catBar(view, cats);
    const wrap = view.querySelector('.settings-wrap');
    if (wrap && !wrap.dataset.ph) settingsPage(wrap);
  }
  new MutationObserver(() => queueMicrotask(onPage)).observe($('#view'), { childList: true });
  new MutationObserver(() => queueMicrotask(onPage)).observe($('#viewTitle'), { childList: true, characterData: true, subtree: true });

  /* ---- categories: a button, and the list as a sheet ---- */
  function catBar(view, cats) {
    const bar = document.createElement('button');
    bar.className = 'ph-catbar';
    bar.innerHTML = '<span class="lbl">Category</span><span class="val">All</span><span class="chev">▾</span>';
    view.insertBefore(bar, view.firstChild);
    const label = () => {
      const a = cats.querySelector('.cat.active .name');
      bar.querySelector('.val').textContent = a ? a.textContent : 'All';
    };
    bar.onclick = () => {
      sheet('ph-cats', true);
      const a = cats.querySelector('.cat.active');
      if (a) a.scrollIntoView({ block: 'center' });
    };
    // catList() fills the list (again): put the sheet's head back, update the button
    const head = () => {
      if (!cats.querySelector('.ph-cats-head') && cats.querySelector('.cat')) {
        const h = document.createElement('div');
        h.className = 'ph-cats-head';
        h.innerHTML = '<b>Categories</b><input type="search" placeholder="Find a category" spellcheck="false" autocomplete="off">';
        const f = h.querySelector('input');
        f.oninput = () => {
          const q = f.value.trim().toLowerCase();
          cats.querySelectorAll('.cat').forEach(c => { c.style.display = !q || c.textContent.toLowerCase().includes(q) ? '' : 'none'; });
        };
        cats.insertBefore(h, cats.firstChild);
      }
      label();
    };
    new MutationObserver(head).observe(cats, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    cats.addEventListener('click', e => { if (e.target.closest('.cat')) setTimeout(() => sheet('ph-cats', false), 60); });
    head();
  }

  /* ---- Settings: the sections' list, a section over it ---- */
  function settingsPage(wrap) {
    wrap.dataset.ph = '1';
    const page = wrap.querySelector('.settings');
    // a section open: its name is the title, ‹ goes back to the list
    wrap.querySelectorAll('.set-item').forEach(b => b.addEventListener('click', () => {
      setOpen = b.dataset.sec;
      wrap.classList.add('ph-open');
      if (page) page.scrollTop = 0;
      $('#viewTitle').textContent = b.querySelector('.txt b').textContent;
    }));
    if (setOpen) { const b = wrap.querySelector(`.set-item[data-sec="${setOpen}"]`); if (b) b.click(); }
  }
  function closeSection(wrap) { wrap.classList.remove('ph-open'); setOpen = ''; $('#viewTitle').textContent = 'Settings'; }

  /* ---- the keyboard: the tab bar steps aside ---- */
  const typing = el => el && ((el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable);
  document.addEventListener('focusin', e => sheet('ph-typing', typing(e.target)));
  document.addEventListener('focusout', () => setTimeout(() => sheet('ph-typing', typing(document.activeElement)), 50));
  // Enter on the phone keyboard in the search box: done typing (the results are there already)
  $('#search').addEventListener('keydown', e => { if (e.key === 'Enter') $('#search').blur(); });

  /* ---- voice search: the 🎤 next to the search box (when Android has speech recognition) ---- */
  const N = window.SealNative;
  const canVoice = () => !!(N && N.voiceSearch && N.voiceAvailable && N.voiceAvailable());
  window.__tvVoice = text => {
    const box = $('#search');
    if (!box || text == null || !String(text).trim()) return;
    box.value = String(text).trim();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setTimeout(() => { const b = $('#voiceBtn'); if (b && canVoice()) { b.classList.remove('hidden'); b.onclick = () => N.voiceSearch('Search channels, movies and series'); } }, 0);

  /* ---- Back ---- */
  window.__tvBack = () => {
    if (root.classList.contains('ph-cats')) { sheet('ph-cats', false); return true; }
    if (root.classList.contains('ph-more')) { sheet('ph-more', false); return true; }
    const menu = $('#ctxMenu:not(.hidden)');
    if (menu) { menu.classList.add('hidden'); return true; }
    const dlg = $('#dlgModal:not(.hidden)');
    if (dlg) { $('#dlgCancel').classList.contains('hidden') ? $('#dlgOk').click() : $('#dlgCancel').click(); return true; }
    const a = document.activeElement;
    if (a && typing(a)) { a.blur(); if (a.id !== 'search' || !a.value) return true; }
    const wrap = $('#view .settings-wrap.ph-open');
    if (wrap) { closeSection(wrap); return true; }
    const s = st();
    if (s) {
      if (s.q && ['live', 'movies', 'series', 'search', 'guide'].includes(s.view)) { const box = $('#search'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); return true; }
      if (s.history.length) { back(); return true; }
      if (s.view !== 'home') { go('home', null, { push: false }); return true; }
    }
    return false;
  };
  window.__tvMenu = () => false;
})();
