/* =====================================================================
 * Seal IPTV for Fire TV — tvnav.js   (the remote)
 * ---------------------------------------------------------------------
 *   ← ↑ → ↓   move to the nearest thing in that direction
 *   OK        press it (also for cards / rows that aren't buttons; a Live TV channel: watch it);
 *             on a form field: type into it (Android calls window.__tvOk()) — Android's own
 *             text box + keyboard opens, and what you type is put in the field (__tvText)
 *   Back      close the dialog / menu, go back, else leave the app
 *             (Android asks window.__tvBack(); false = nothing to go back to)
 *   ☰ Menu    the right-click menu of what's selected (categories: hide / lock; a poster:
 *             add to one of my categories)
 *   Any key while the screensaver is up only ends it (app.js sealWake()).
 * Text boxes keep ← → for the cursor; ↑ ↓ leave them. The parental PIN is typed on a number
 * pad next to its boxes (or the remote's 0–9), not the keyboard.
 *   Going into the sidebar (or Settings' list of sections) from the page lands on the one
 *   in use; OK on a choice (a <select>) slides its choices in from the right.
 * ===================================================================== */
'use strict';
(() => {
  const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]):not([type=hidden]), select:not([disabled]), a[href], summary';
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const hiddenUp = el => !!el.closest('.hidden');
  const NOT_TEXT = /^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/;
  /** a form field you type into: any text-like input, a textarea, or editable text */
  const editable = el => !!el && ((el.tagName === 'INPUT' && !NOT_TEXT.test(el.type) && !el.readOnly && !el.disabled) || (el.tagName === 'TEXTAREA' && !el.readOnly && !el.disabled) || el.isContentEditable);
  let editing = null;   // the field Android's text box is typing into
  let before = null;    // its text before (the search box changes while typing: Cancel puts this back)
  function labelOf(el) {
    const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
    return ((l && l.textContent) || el.getAttribute('aria-label') || el.placeholder || el.title || 'Type here').trim().slice(0, 80);
  }
  function keyboard(el) {
    if (el !== document.activeElement) el.focus();
    const N = window.SealNative;
    if (N && N.editText) {
      editing = el;
      before = el.isContentEditable ? el.textContent : el.value;
      const type = el.tagName === 'INPUT' ? el.type : 'text';
      N.editText(JSON.stringify({ value: before, type, label: labelOf(el), placeholder: el.placeholder || '', multiline: el.tagName === 'TEXTAREA', live: el.id === 'search' }));
    } else if (N && N.showKeyboard) N.showKeyboard();
  }
  /* Moving onto a field doesn't open the keyboard (Google TV opens it as soon as a field has the
     focus): typing goes through Android's text box after OK (keyboard() above), so the page's own
     field asks for no keyboard while it has the focus. */
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (!editable(el) || !(window.SealNative && window.SealNative.editText) || el.getAttribute('inputmode') === 'none') return;
    el.dataset.tvInputmode = el.getAttribute('inputmode') || '';
    el.setAttribute('inputmode', 'none');
    el.addEventListener('focusout', () => {
      if (el.dataset.tvInputmode) el.setAttribute('inputmode', el.dataset.tvInputmode); else el.removeAttribute('inputmode');
      delete el.dataset.tvInputmode;
    }, { once: true });
  }, true);

  /* Android's text box closed: null = cancelled, else the text (the app sees it as typing) */
  /* the search box while Android's text box is open: results follow the typing */
  window.__tvTyping = text => {
    const el = editing;
    if (!el || !el.isConnected || el.id !== 'search') return;
    setValue(el, text);
  };
  function setValue(el, text) {
    if (el.isContentEditable) el.textContent = text;
    else Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  window.__tvText = text => {
    const el = editing;
    editing = null;
    if (!el || !el.isConnected) return;
    el.focus({ preventScroll: true });
    if (text === null) { if (el.id === 'search' && el.value !== before) setValue(el, before); return; }
    if (el.isContentEditable) el.textContent = text;
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /* voice search: the 🎤 next to the search box, or the remote's search key (MainActivity) */
  const canVoice = () => { const N = window.SealNative; return !!(N && N.voiceSearch && N.voiceAvailable && N.voiceAvailable()); };
  function voice() { if (canVoice()) window.SealNative.voiceSearch('Search channels, movies and series'); }
  window.__tvVoice = text => {
    const box = document.querySelector('#search');
    if (!box || text == null || !String(text).trim()) return;
    box.focus({ preventScroll: true });
    setValue(box, String(text).trim());
  };
  window.__tvSearchKey = () => {
    if (window.sealWake && window.sealWake()) return;
    const box = document.querySelector('#search');
    if (canVoice()) voice(); else if (box && visible(box)) { box.focus(); keyboard(box); }
  };
  setTimeout(() => {
    const b = document.querySelector('#voiceBtn');
    if (b && canVoice()) { b.classList.remove('hidden'); b.onclick = voice; }
  }, 0);

  /* The parental PIN: a number pad next to the PIN boxes instead of the keyboard (the remote's own
     0–9 keys type too). ✓ goes on to the next box, or presses the dialog's OK. */
  let pinAt = null;   // the PIN box the pad types into
  const pinBoxes = () => [...document.querySelectorAll('#dlgBody .pin-input')];
  function pinTo(f) {
    pinAt = f;
    const boxes = pinBoxes(), last = boxes.indexOf(f) === boxes.length - 1;
    boxes.forEach(b => b.classList.toggle('pin-at', b === f));
    const okKey = document.querySelector('#dlgBody .pin-pad [data-k="ok"]');
    if (okKey) okKey.textContent = last ? '✓ OK' : 'Next';
  }
  function pinPad() {
    const body = document.querySelector('#dlgBody');
    let pad = body.querySelector('.pin-pad');
    if (pad) return pad;
    const wrap = document.createElement('div'); wrap.className = 'pin-wrap';
    const fields = document.createElement('div'); fields.className = 'pin-fields';
    fields.append(...body.childNodes);
    pad = document.createElement('div'); pad.className = 'pin-pad';
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.k = k; b.textContent = k === 'del' ? '⌫' : k;
      b.onclick = () => pinKey(k);
      b.onfocus = () => { pad._last = b; };
      pad.appendChild(b);
    }
    wrap.append(fields, pad);
    body.appendChild(wrap);
    pinBoxes().forEach(f => { f.readOnly = true; f.tabIndex = -1; });
    return pad;
  }
  function pinKey(k) {
    const f = pinAt;
    if (!f || !f.isConnected) return;
    const boxes = pinBoxes(), i = boxes.indexOf(f);
    if (k === 'ok') { if (boxes[i + 1]) pinTo(boxes[i + 1]); else document.querySelector('#dlgOk').click(); return; }
    if (k === 'del') { if (f.value) setValue(f, f.value.slice(0, -1)); else if (i > 0) pinTo(boxes[i - 1]); return; }
    // a wrong PIN is selected (app.js): the next digit starts again
    const all = f.value && f.selectionStart === 0 && f.selectionEnd === f.value.length;
    const v = all ? '' : f.value;
    if (v.length < (f.maxLength > 0 ? f.maxLength : 8)) setValue(f, v + k);
  }
  // a PIN box gets the focus (the dialog opening, or a wrong PIN): the pad takes it
  document.addEventListener('focusin', e => {
    const f = e.target;
    if (!f.classList || !f.classList.contains('pin-input') || !f.closest('#dlgBody')) return;
    const pad = pinPad();
    pinTo(f);
    setTimeout(() => { const b = pad._last && pad._last.isConnected ? pad._last : pad.firstChild; b.focus({ preventScroll: true }); }, 0);
  }, true);

  /** OK on the remote: what's selected is pressed — a form field opens the keyboard */
  function ok(a) {
    if (!a || a === document.body) return false;
    if (editable(a)) { keyboard(a); return true; }
    if (a.type === 'range') return true;
    if (a.tagName === 'SELECT') { pick(a); return true; }
    if (typeof a.tvOk === 'function') { a.tvOk(); return true; }   // its own action for OK (a Live TV channel: watch it)
    a.click();
    if (a.closest('#sidebar') && a.classList.contains('nav')) window.tvFocusFirst(true);   // a menu item: on to its page
    return true;
  }

  /** A choice's options, slid in from the right: ↑ ↓ and OK, Back to leave it as it was */
  function pick(sel) {
    closePick();
    const back = document.createElement('div'); back.className = 'tv-pick-back'; back.id = 'tvPickBack';
    const box = document.createElement('div'); box.className = 'tv-pick'; box.id = 'tvPick';
    const h3 = document.createElement('h3'); h3.textContent = labelOf(sel); box.appendChild(h3);
    const list = document.createElement('div'); list.className = 'opts'; box.appendChild(list);
    let cur = null;
    [...sel.options].forEach(o => {
      if (o.disabled || o.hidden) return;
      const b = document.createElement('button');
      b.className = o.selected ? 'on' : '';
      b.innerHTML = '<span class="tick"></span><span></span>';
      b.firstChild.textContent = o.selected ? '✓' : '';
      b.lastChild.textContent = o.textContent;
      b.onclick = () => {
        closePick();
        sel.focus({ preventScroll: true });
        if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      if (o.selected) cur = b;
      list.appendChild(b);
    });
    box._for = sel;
    back.onclick = () => { closePick(); sel.focus({ preventScroll: true }); };
    document.body.append(back, box);
    focusEl(cur || list.firstChild);
  }
  function closePick() { const b = document.querySelector('#tvPick'); if (!b) return null; document.querySelector('#tvPickBack').remove(); b.remove(); return b._for; }
  window.__tvOk = () => (window.sealWake && window.sealWake()) || ok(document.activeElement);

  /** Where focus may go: the open dialog / menu / player overlay, else the page. */
  function scope() {
    const pk = document.querySelector('#tvPick');
    if (pk) return pk;
    const menu = document.querySelector('#ctxMenu:not(.hidden)');
    if (menu) return menu;
    const dlg = document.querySelector('#dlgModal:not(.hidden)');
    if (dlg) return dlg;
    return document.body;
  }

  function candidates(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(el => !hiddenUp(el) && visible(el) && !el.closest('#player'));
  }

  function move(dir) {
    const root = scope();
    const cur = document.activeElement && root.contains(document.activeElement) && document.activeElement !== document.body ? document.activeElement : null;
    let list = candidates(root);
    // ← in a Settings row (the switch is at its right end): what's left of it in the row, else the list of sections
    const row = cur && dir === 'left' && cur.closest('.panel > label.check');
    if (row) {
      const x = cur.getBoundingClientRect().left;
      list = list.filter(el => row.contains(el) && el !== cur && el.getBoundingClientRect().right <= x + 4);
      const sec = document.querySelector('.set-nav .set-item.active');
      if (!list.length && sec) { focusEl(sec); return true; }
    }
    if (!cur) { if (list[0]) focusEl(list[0]); return true; }
    // ↓ from a row that says where down goes (a series' buttons: the season in use)
    const hop = dir === 'down' && cur.closest('[data-tv-down]');
    if (hop) { const t = document.querySelector(hop.dataset.tvDown); if (t && visible(t)) { focusEl(t); return true; } }
    // an episode: → to its ✓ (watched) button, ← from there back to the episode
    const ep = cur.closest('.episode');
    if (ep && dir === 'right' && cur === ep) { const b = ep.querySelector('.seen-btn'); if (b) { focusEl(b); return true; } }
    if (ep && dir === 'left' && cur !== ep) { focusEl(ep); return true; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    const inSide = !!cur.closest('#sidebar'), inTop = !!cur.closest('#topbar');
    // → out of the sidebar (open, it covers the page's left edge): back where the remote was on the page,
    // else the page's first thing
    if (inSide && dir === 'right') {
      const view = document.querySelector('#view');
      const back = lastInPage && lastInPage.isConnected && view.contains(lastInPage) && visible(lastInPage) && !hiddenUp(lastInPage) ? lastInPage : null;
      const first = back || candidates(view)[0];
      if (first) { focusEl(first); return true; }
    }
    for (const el of list) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      // ↑ ↓ stay where they are: on the page (the sidebar runs the whole height), or in the sidebar
      // (it covers the page's left edge when open: what's under it isn't "below")
      if ((dir === 'up' || dir === 'down') && inSide !== !!el.closest('#sidebar')) continue;
      const b = el.getBoundingClientRect();
      if ((dir === 'left' || dir === 'right') && !inTop && el.closest('#topbar') && !(b.top < a.bottom && b.bottom > a.top)) continue;
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let main, side;
      if (dir === 'right') { if (b.left < a.right - 4) continue; main = b.left - a.right; side = Math.abs(by - ay); }
      else if (dir === 'left') { if (b.right > a.left + 4) continue; main = a.left - b.right; side = Math.abs(by - ay); }
      else if (dir === 'down') { if (b.top < a.bottom - 4) continue; main = b.top - a.bottom; side = Math.abs(bx - ax); }
      else { if (b.bottom > a.top + 4) continue; main = a.top - b.bottom; side = Math.abs(bx - ax); }
      // overlap on the other axis counts as "in line"
      const inLine = dir === 'left' || dir === 'right' ? (b.top < a.bottom && b.bottom > a.top) : (b.left < a.right && b.right > a.left);
      const score = Math.max(0, main) + side * (inLine ? 0.3 : 2.2);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      const grp = best.closest('#sidebar, [data-tv-group]');
      if (grp && !grp.contains(cur)) { const act = grp.querySelector('.nav.active, .set-item.active, .season.active'); if (act && visible(act)) best = act; }
      focusEl(best);
      return true;
    }
    return false;
  }

  // where the remote was on the page last (→ from the sidebar goes back there)
  let lastInPage = null;
  document.addEventListener('focusin', e => { const v = document.querySelector('#view'); if (v && v.contains(e.target)) lastInPage = e.target; }, true);

  function focusEl(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // a card in a sideways shelf: keep a little of the next one visible
    const shelf = el.closest('.shelf-row');
    if (shelf) { const r = el.getBoundingClientRect(), s = shelf.getBoundingClientRect(); if (r.right > s.right - 60) shelf.scrollLeft += 140; if (r.left < s.left + 60) shelf.scrollLeft -= 140; }
  }

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented) return;
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    const a = document.activeElement;
    const typing = editable(a);
    // the remote's 0–9 (and a keyboard's Backspace) while the PIN pad is up
    if (pinAt && pinAt.isConnected && !document.querySelector('#dlgModal').classList.contains('hidden') && (/^[0-9]$/.test(e.key) || e.key === 'Backspace')) {
      e.preventDefault();
      pinKey(e.key === 'Backspace' ? 'del' : e.key);
      return;
    }
    if (dir) {
      if (typing && (dir === 'left' || dir === 'right')) {
        let at = null, len = 0;
        try { at = dir === 'left' ? a.selectionStart : a.selectionEnd; len = (a.value || '').length; } catch { at = null; }
        if (at === null || (dir === 'left' ? at > 0 : at < len)) return;   // the cursor moves in the text
      }
      if (a && a.type === 'range' && (dir === 'left' || dir === 'right')) return;
      if (move(dir)) e.preventDefault();
      return;
    }
    // Enter (a keyboard's Done / Go, or a USB keyboard): in a form field the app handles it
    // (search, OK in a dialog …); anywhere else it presses what's selected, like OK
    if (e.key === 'Enter' && a && a !== document.body && !typing) {
      e.preventDefault();
      ok(a);
    }
  });
  // touch / mouse on a form field (or a field focused by a click): open the keyboard too
  document.addEventListener('click', e => { if (editable(e.target)) keyboard(e.target); });

  /* Back — Android calls this; returns false when there's nothing left to go back to */
  window.__tvBack = () => {
    if (window.sealWake && window.sealWake()) return true;   // the screensaver was up: this press only ends it
    const sel = closePick();
    if (sel) { sel.focus({ preventScroll: true }); return true; }
    const menu = document.querySelector('#ctxMenu:not(.hidden)');
    if (menu) { menu.classList.add('hidden'); return true; }
    const dlg = document.querySelector('#dlgModal:not(.hidden)');
    if (dlg) { document.querySelector('#dlgCancel').classList.contains('hidden') ? document.querySelector('#dlgOk').click() : document.querySelector('#dlgCancel').click(); return true; }
    const a = document.activeElement;
    if (a && a.id === 'search' && a.value) { a.value = ''; a.oninput && a.oninput(); return true; }
    // in a Settings section: back to the list of sections
    const secItem = a && a.closest('.settings') && document.querySelector('.set-nav .set-item.active');
    if (secItem) { focusEl(secItem); return true; }
    if (typeof state !== 'undefined') {
      if (state.history.length) { back(); return true; }
      if (state.view !== 'home') { go('home', null, { push: false }); return true; }
    }
    return false;
  };

  /* ☰ Menu — the selected thing's right-click menu */
  window.__tvMenu = () => {
    if (window.sealWake && window.sealWake()) return true;   // the screensaver was up: this press only ends it
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    const r = a.getBoundingClientRect();
    a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.bottom }));
    const first = document.querySelector('#ctxMenu:not(.hidden) button');
    if (first) first.focus();
    return true;
  };

  /* after a page is drawn: put the focus somewhere sensible */
  window.tvFocusFirst = (force, tries = 0) => {
    setTimeout(() => {
      const a = document.activeElement;
      if (scope() !== document.body) return;   // a dialog / menu is open: it has the focus
      if (!force && a && a !== document.body && a.isConnected && visible(a) && !hiddenUp(a)) return;
      if (force && a && a !== document.body && !a.closest('#sidebar')) return;   // already on the page
      const view = document.querySelector('#view');
      const inView = candidates(view)[0];
      if (!inView && force && tries < 10) return window.tvFocusFirst(true, tries + 1);   // the page is still loading
      const first = inView || document.querySelector('.nav.active') || candidates(document.body)[0];
      if (first) focusEl(first);
    }, tries ? 150 : 120);
  };
  new MutationObserver(() => { if (!document.activeElement || document.activeElement === document.body) window.tvFocusFirst(); })
    .observe(document.body, { childList: true, subtree: true });
})();
