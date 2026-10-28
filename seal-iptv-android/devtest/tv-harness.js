/* =====================================================================
 * Seal IPTV for Fire TV — devtest/tv-harness.js
 * ---------------------------------------------------------------------
 * Runs the TV app's web part (app/src/main/assets/www) in an Electron
 * window with a pretend Android side (tv-preload.js), presses remote
 * keys, saves screenshots and checks the results — including a sync
 * vault made by the TV that the Windows sync code then reads.
 *   ..\seal-iptv\node_modules\.bin\electron devtest\tv-harness.js <out folder>
 *   (needs: fake provider on :8790, PHP sync server on :8798 — tv-run.js starts both)
 * ===================================================================== */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const out = path.resolve(process.argv[2] || 'tv-shots');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true, show: true, backgroundColor: '#121418',
    webPreferences: { preload: path.join(__dirname, 'tv-preload.js'), contextIsolation: false, nodeIntegration: false, sandbox: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') console.log('console:', e.message); });
  await win.loadFile(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'index.html'));
  const js = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(180); } };
  const focused = () => js("(() => { const a = document.activeElement; return a ? (a.innerText || a.value || a.id || a.tagName).trim().replace(/\\s+/g, ' ').slice(0, 60) : '' })()");
  try {
    await sleep(1500);
    await shot('t1-welcome');
    log('welcome, focus on', await focused());

    // a playlist, as if typed in Settings
    log('add playlist', await js(`window.api.invoke('profiles:save', { type: 'xtream', name: 'Demo provider', server: 'http://127.0.0.1:8790', username: 'demo', password: 'demo' }).then(r => r.ok)`));
    await js("start().then(() => reload())");
    await sleep(5000);
    await shot('t2-home');
    log('home', await js("JSON.stringify({ counts: state.summary.counts, focus: document.activeElement && document.activeElement.innerText.slice(0, 30) })"));

    // remote: to Live TV in the sidebar, into the channel list, OK = play
    await js("document.querySelector('.nav[data-view=home]').focus()");
    await key('Down');
    log('↓ in the sidebar ->', await focused());
    await key('Enter');
    await sleep(1500);
    await key('Right'); await key('Right');
    log('→ → ->', await focused());
    await key('Down', 2);
    log('↓ ↓ ->', await focused());
    await sleep(800);
    await shot('t3-live-remote');
    await key('Enter');
    await sleep(2500);
    log('OK on a channel -> Android player asked to play', await js("JSON.stringify(window.__played && { url: window.__played.url.replace(/demo\\/demo/, '***'), ua: window.__played.ua, live: window.__played.live, title: window.__played.title, canZap: window.__played.canZap, device: window.__played.device })"));
    // Android says: ↑ pressed (zap), then Back (closed)
    await js("window.__nativeEvent('player', JSON.stringify({ type: 'zap', dir: 1, pos: 5000, dur: 0 }))");
    await sleep(1500);
    log('zap ↓ -> next channel', await js("window.__played.title"));
    log('… the channel list is sent once, then kept', await js("JSON.stringify({ index: window.__played.index, sentAgain: 'channels' in window.__played })"));
    // the channel guide: opened -> the whole category; rows in view -> what's on; a row chosen, a number, the one before
    const ev = o => js(`window.__nativeEvent('player', ${JSON.stringify(JSON.stringify(o))})`);
    const lastCmd = cmd => js(`JSON.stringify((window.__cmds || []).filter(c => c.cmd === '${cmd}').slice(-1)[0] || null)`);
    await ev({ type: 'guide', pos: 6000, dur: 0 });
    await sleep(1200);
    log('guide opened -> the whole category', await js("(() => { const c = (window.__cmds || []).filter(c => c.cmd === 'channels').slice(-1)[0]; return JSON.stringify(c && { count: c.channels.length, index: c.index, first: c.channels[0] }); })()"));
    const ids = await js("JSON.stringify((window.__cmds || []).filter(c => c.cmd === 'channels').slice(-1)[0].channels.slice(0, 3).map(c => c.id))");
    await ev({ type: 'epgNeed', ids: JSON.parse(ids) });
    await sleep(1800);
    log('rows in view -> what\'s on', await lastCmd('epg'));
    await ev({ type: 'tune', index: 4 });
    await sleep(1500);
    log('a channel chosen in the guide', await js("window.__played.title"));
    await ev({ type: 'number', num: '1' });
    await sleep(1500);
    log('number 1 typed', await js("window.__played.title"));
    await ev({ type: 'last' });
    await sleep(1500);
    log('0: the channel before', await js("window.__played.title"));
    await ev({ type: 'number', num: '999' });
    await sleep(800);
    log('a number that isn\'t there', await lastCmd('osd'));
    await js("window.__nativeEvent('player', JSON.stringify({ type: 'closed', pos: 9000, dur: 0 }))");
    await sleep(500);

    // a movie: OK -> play; Android reports 92 % -> watched
    await js("go('movie', '2001')");
    await sleep(1800);
    await shot('t4-movie');
    log('movie page, focus on', await focused());
    await js("document.querySelector('#mActions .btn.primary').focus()");
    await key('Enter');
    await sleep(1500);
    await js("window.__nativeEvent('player', JSON.stringify({ type: 'progress', pos: 549000, dur: 596000 }))");
    await sleep(800);
    await js("window.__nativeEvent('player', JSON.stringify({ type: 'closed', pos: 551000, dur: 596000 }))");
    await sleep(1500);
    log('after 92 % in the Android player', await js("call('catalog:item', 'movies', '2001').then(i => JSON.stringify({ watched: i.watched }))"));

    // menu key on a category: hide / lock menu
    await js("go('live')");
    await sleep(1500);
    await js("document.querySelectorAll('#cats .cat')[3].focus()");
    await js('window.__tvMenu()');
    await sleep(600);
    await shot('t5-menu-key');
    log('☰ on a category ->', await js("[...document.querySelectorAll('#ctxMenu:not(.hidden) button')].map(b => b.textContent).join(' | ')"));
    log('Back closes the menu', await js('window.__tvBack()'));

    // audio sync from the Android player's menu -> saved for that device
    await js("go('home')");
    await sleep(800);
    await js("Player.play({ kind: 'movie', id: '2000', name: 'Short', ext: 'mp4' }, { start: 0 })");
    await sleep(1200);
    await js("window.__nativeEvent('player', JSON.stringify({ type: 'avsync', ms: 180, pos: 1000, dur: 10000 }))");
    await sleep(900);
    log('audio sync saved', await js("JSON.stringify(state.settings.playback.avSync)"));
    await js("window.__nativeEvent('player', JSON.stringify({ type: 'closed', pos: 2000, dur: 10000 }))");

    // sync: the TV creates the vault (Web Crypto + the shims), Windows code reads it afterwards
    await js("go('settings')");
    await sleep(1200);
    // every form field: OK opens Android's text box; what's typed there lands in the field
    await js("window.__kb = []; SealNative.editText = j => { const o = JSON.parse(j); window.__kb.push(o); setTimeout(() => window.__tvText(o.type === 'password' ? 'typed secret' : 'typed ' + o.label), 50); }; 0");
    for (const id of ['syServer', 'syDevice', 'syUser', 'syPass']) { await js(`document.getElementById('${id}').focus()`); await js('window.__tvOk()'); await sleep(250); }
    log('OK on the Settings form fields -> Android text box -> typed into the field', await js("JSON.stringify({ asked: window.__kb.map(o => o.type + ' \"' + o.label + '\"'), values: ['syServer', 'syDevice', 'syUser', 'syPass'].map(id => document.getElementById(id).value) })"));
    await js("window.__kb = []; SealNative.editText = j => { window.__kb.push(JSON.parse(j)); setTimeout(() => window.__tvText(null), 50); }; 0");
    await js("document.getElementById('syServer').focus()");
    await js('window.__tvOk()'); await sleep(250);
    log('Cancel in the text box -> field unchanged, focus stays', await js("JSON.stringify({ value: document.getElementById('syServer').value, focus: document.activeElement.id })"));
    // search box: typed text runs the search (input event)
    await js("go('home')"); await sleep(800);
    await js("SealNative.editText = j => setTimeout(() => window.__tvText('Sport'), 50); document.getElementById('search').focus(); 0");
    log('search box focused', await focused());
    await js('window.__tvOk()'); await sleep(1500);
    log('search typed on the TV ->', await js("JSON.stringify({ value: document.getElementById('search').value, view: state.view })"));
    await js("document.getElementById('search').value = ''; go('settings')"); await sleep(1000);
    await shot('t6a-settings-form');
    const r = await js(`window.api.invoke('sync:connect', { server: 'http://127.0.0.1:8798/', username: 'jeff', passphrase: 'my long vault passphrase', create: true, setupCode: 'TV-SETUP-1', deviceName: 'Living room Fire TV' }).then(r => JSON.stringify(r.ok ? { items: r.data.items, waiting: r.data.waiting } : r))`);
    log('TV created the sync vault', r);
    await sleep(1000);
    await js("refreshAll(['profile'])");
    await sleep(1200);
    await js("document.querySelector('#syncPanel').scrollIntoView()");
    await shot('t6-settings-sync');

    // VPN guard: required + no VPN -> Android told to block posters
    await js("saveSettings({ vpn: { required: true, provider: 'other', adapter: 'No Such VPN' } }).then(() => call('vpn:check')).then(onVpnStatus)");
    await sleep(2500);
    log('VPN off -> poster guard', await js('JSON.stringify(window.__guard)'));
    await js("saveSettings({ vpn: { required: false } }).then(() => call('vpn:check')).then(onVpnStatus)");
    await sleep(800);

    // every page fits the screen: nothing wider than the window
    const wide = {};
    for (const v of ['home', 'live', 'movies', 'series', 'favorites', 'settings']) {
      await js(`go('${v}')`);
      await sleep(1000);
      wide[v] = await js("(() => { const W = document.documentElement.clientWidth; const over = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > W + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.hidden, .shelf-row, #player')).length; return { width: W, scrollWidth: document.documentElement.scrollWidth, sticksOut: over }; })()");
    }
    log('pages fit the screen', wide);

    // posters the provider doesn't have: the ones on screen are looked up (art:find, faked here)
    await js(`window.__art = []; const realInvoke = window.api.invoke; window.__realInvoke = realInvoke;
      window.api.invoke = (ch, ...a) => {
        if (ch === 'art:find') { window.__art.push(...a[0]); return Promise.resolve({ ok: true, data: a[0].map((q, i) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#2a6"/><text x="20" y="150" font-size="22" fill="#fff">found</text></svg>')) }); }
        if (ch === 'update:check') return Promise.resolve({ ok: true, data: { current: '1.1.0', latest: '1.2.0', available: true, kind: 'web', ready: false, notes: 'Posters for everything.', size: 380000 } });
        if (ch === 'update:install') { window.__installed = true; return Promise.resolve({ ok: true, data: { version: '1.2.0', reload: true } }); }
        return realInvoke(ch, ...a);
      }; 0`);
    await js("state.q = ''; document.getElementById('search').value = ''; go('series')");
    await sleep(2500);
    await shot('t7-series-posters');
    log('series without covers -> looked up', await js("JSON.stringify({ asked: window.__art.map(q => q.kind + ':' + q.name + (q.year ? ' ' + q.year : '')), found: document.querySelectorAll('#view img[src^=\"data:image/svg\"]').length, initialsLeft: document.querySelectorAll('#view .initials').length })"));
    await js("window.__art = []; go('movies')");
    await sleep(2500);
    log('movies with broken poster links -> looked up', await js("JSON.stringify({ asked: window.__art.length, kinds: [...new Set(window.__art.map(q => q.kind))], found: document.querySelectorAll('#view img[src^=\"data:image/svg\"]').length })"));

    // update bar: found -> Update -> installed (the app reloads from the new pages)
    await js("Upd.later = false; Upd.check(true)");
    await sleep(800);
    await shot('t8-update-bar');
    log('update bar', await js("JSON.stringify({ text: document.querySelector('#updBar .txt').textContent, buttons: [...document.querySelectorAll('#updBar button')].map(b => b.textContent) })"));
    await js("document.querySelector('#updGo').focus()");
    await js('window.__tvOk()');
    await sleep(800);
    log('Update pressed', await js("JSON.stringify({ installed: !!window.__installed, bar: document.querySelector('#updBar .txt').textContent })"));
    await js("window.api.invoke = window.__realInvoke; document.querySelector('#updBar') && document.querySelector('#updBar').remove(); Upd.info = null; 0");
    log('real update check on an APK without the update bridge', await js("call('update:check').then(() => 'no error?', e => e.message)"));

    // my own category: made on the TV, a movie put in it with the remote (☰ Menu), synced
    await js("call('lists:save', null, { name: 'Kids', icon: '🧸' }).then(id => { window.__kid = id; return loadLists(); }).then(() => go('movies'))");
    await sleep(1500);
    await js("document.querySelector('#grid .card').focus()");
    await js('window.__tvMenu()');
    await sleep(300);
    log('☰ Menu on a poster', await js("[...document.querySelectorAll('#ctxMenu button')].map(b => b.textContent).join(' | ')"));
    await js('window.__tvOk()');
    await sleep(600);
    await shot('t9-pick-category');
    await js("document.querySelector('.list-pick input').focus()");
    await js('window.__tvOk()');
    await js("document.querySelector('#dlgOk').focus()");
    await js('window.__tvOk()');
    await sleep(600);
    await js("go('list', __kid)");
    await sleep(800);
    await shot('t10-my-category');
    log('Kids on the TV', await js("JSON.stringify({ nav: [...document.querySelectorAll('#myNav .nav')].map(b => b.textContent), cards: [...document.querySelectorAll('#view .card .title')].map(t => t.textContent) })"));
    log('synced', await js("call('sync:now').then(s => JSON.stringify({ waiting: s && s.waiting }), e => e.message)"));

    // Back puts the focus back on the poster that was opened
    await js("state.history = []; go('movies', null, { push: false })");
    await sleep(1500);
    await js("document.querySelectorAll('#view .card')[4].focus()");
    const opened = await focused();
    await key('Enter');
    await sleep(1500);
    log('Back after opening a movie ->', await js('String(window.__tvBack())'));
    await sleep(1800);
    log('focus back on the same poster', { opened, now: await focused(), view: await js('state.view') });

    // ← from the page into the sidebar: the whole menu opens over the page, on the item in use
    log('sidebar while on the page', await js("JSON.stringify({ width: document.querySelector('#sidebar').offsetWidth })"));
    for (let i = 0; i < 8 && !(await js("String(!!document.activeElement.closest('#sidebar'))")).includes('true'); i++) await key('Left');
    await sleep(400);
    await shot('t12-sidebar-open');
    log('← into the sidebar', await js("JSON.stringify({ width: document.querySelector('#sidebar').offsetWidth, focus: document.activeElement.innerText.trim().replace(/\\s+/g, ' ') })"));
    await key('Right');
    await sleep(400);
    log('→ back to the page', await js("JSON.stringify({ width: document.querySelector('#sidebar').offsetWidth, inSidebar: !!document.activeElement.closest('#sidebar') })"));

    // Settings in sections: ↓ through the list shows each one, → goes in, Back comes out
    await js("state.setSec = 'playlists'; go('settings')");
    await sleep(1200);
    await js("document.querySelector('.set-nav .set-item').focus()");
    await key('Down', 3);
    log('↓ ↓ ↓ in the sections', await js("JSON.stringify({ section: state.setSec, shown: [...document.querySelectorAll('.settings > [data-sec]')].filter(p => !p.classList.contains('hidden')).map(p => p.dataset.sec) })"));
    await key('Right');
    await sleep(300);
    await shot('t13-settings-playback');
    log('→ into Playback', await focused());
    await js("document.querySelector('#pResume').focus()");
    await key('Enter');
    await sleep(400);
    await shot('t14-choice-panel');
    log('OK on a choice -> panel', await js("JSON.stringify({ title: document.querySelector('#tvPick h3').textContent, options: [...document.querySelectorAll('#tvPick button')].map(b => b.innerText.replace(/\\s+/g, ' ').trim()), focus: document.activeElement.innerText.trim() })"));
    await key('Down');
    await key('Enter');
    await sleep(600);
    log('↓ OK -> chosen and saved', await js("JSON.stringify({ panel: !!document.querySelector('#tvPick'), select: document.querySelector('#pResume').value, saved: state.settings.playback.resume, focus: document.activeElement.id })"));
    await key('Enter');
    await sleep(300);
    log('Back in the panel -> closed, nothing changed', await js("JSON.stringify({ handled: window.__tvBack(), panel: !!document.querySelector('#tvPick'), saved: state.settings.playback.resume, focus: document.activeElement.id })"));
    await js("document.querySelector('#pNext').focus()");
    await key('Left');
    log('← from a row -> the section in use', await focused());
    await js("document.querySelector('#pNext').focus()");
    log('Back in a section -> its list', await js("JSON.stringify({ handled: window.__tvBack(), focus: document.activeElement.innerText.trim().replace(/\\s+/g, ' '), view: state.view })"));

    // screensaver: any remote key only ends it
    await js('Saver.start()');
    await sleep(1200);
    await shot('t11-screensaver');
    log('screensaver up', await js('String(Saver.showing())'));
    await key('Down');
    log('Down while up ->', await js('JSON.stringify({ showing: Saver.showing(), view: state.view })'));
    await js('Saver.start()');
    log('OK while up -> handled', await js('window.__tvOk()'));
    await js('Saver.start()');
    log('Back while up ->', await js('JSON.stringify({ handled: window.__tvBack(), view: state.view, showing: Saver.showing() })'));

    // Back on Home with nothing to go back to -> Android may leave
    await js("state.history = []; go('home', null, { push: false })");
    await sleep(500);
    log('Back on Home ->', await js('window.__tvBack()'));
  } catch (e) {
    console.log('HARNESS ERROR', e.message);
  }
  app.quit();
});
