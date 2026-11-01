/* =====================================================================
 * Seal IPTV for Ubuntu Touch — utnative.js   (before core.js)
 * ---------------------------------------------------------------------
 * window.SealNative for the shared pages, as NativeBridge.java is on
 * Android — here the app's own backend (backend/backend.py) on 127.0.0.1:
 *   quick calls (files, passwords, network state)  synchronous POST /n/<method>
 *   request(id, json)  POST /n/request, then window.__nativeDone(id) / take(id)
 *   events             GET /n/events (long poll) -> window.__nativeEvent(name, json)
 * Requests, events and pictures go to the backend's second port (SEAL_UT_SIDE): Chromium
 * opens at most 6 connections to one port, and the synchronous calls must never wait
 * behind slow ones.
 * Calls the backend doesn't have (voice search, updates from GitHub …) are left
 * out, so the pages' own "is it there?" checks hide those features.
 * ===================================================================== */
'use strict';
(() => {
  window.SEAL_UT = true;
  // the browser's own fetch: core.js puts its own in place of window.fetch (for the shared code,
  // which goes through SealNative.request) — using that one here would call itself without end
  const fetch = window.fetch.bind(window);
  const call = (m, args) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/n/' + m, false);   // synchronous, like the Java bridge
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify(args));
    if (x.status !== 200) throw new Error(`${m}: the app's backend answered ${x.status}`);
    const r = JSON.parse(x.responseText);
    if (r.error) throw new Error(r.error);
    return r.r;
  };
  const N = {};
  for (const m of ['readFile', 'writeFile', 'renameFile', 'deleteFile', 'exists', 'fileSize', 'fileChunk', 'appendFile', 'blobChunk', 'blobDrop',
    'encrypt', 'decrypt', 'interfaces', 'vpnActive', 'deviceName', 'appVersion', 'audioOutput', 'setGuard',
    'phoneStart', 'phoneReply', 'phoneStop', 'launchApp', 'openExternal', 'play', 'playerCommand',
    'imageRoute', 'webReady', 'webVersion', 'exitApp', 'showKeyboard', 'streamUrl']) N[m] = (...a) => call(m, a);

  const SIDE = window.SEAL_UT_SIDE = call('sideOrigin', []);
  const answers = new Map();
  N.request = (id, json) => {
    fetch(SIDE + '/n/request', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: json })
      .then(r => r.text())
      .catch(e => JSON.stringify({ ok: false, error: e.message }))
      .then(t => { answers.set(id, t); if (window.__nativeDone) window.__nativeDone(id); });
  };
  N.take = id => { const a = answers.get(id); answers.delete(id); return a == null ? '{"ok":false,"error":"no answer"}' : a; };
  window.SealNative = N;

  // events from the backend (and from Main.qml's player through it)
  (async () => {
    for (;;) {
      try {
        const list = await (await fetch(SIDE + '/n/events', { credentials: 'include' })).json();
        for (const e of list) if (window.__nativeEvent) window.__nativeEvent(e.name, e.data);
      } catch { await new Promise(z => setTimeout(z, 1000)); }
    }
  })();
})();
