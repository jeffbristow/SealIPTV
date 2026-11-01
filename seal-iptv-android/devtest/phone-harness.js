/* =====================================================================
 * Seal IPTV for Android phones — devtest/phone-harness.js
 * ---------------------------------------------------------------------
 * The phone pages (assets/www/mobile.html) in a phone-sized Electron
 * window (412 x 915, a Pixel 6a's size in CSS pixels) with the pretend
 * Android side (tv-preload.js); taps through the pages and saves a
 * screenshot of each.   TV_HARNESS=<this file> node devtest/tv-run.js <out>
 * (PHONE_LANDSCAPE=1: sideways, 915 x 412)
 * ===================================================================== */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const out = path.resolve(process.argv[2] || 'phone-shots');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));
const wide = !!process.env.PHONE_LANDSCAPE;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: wide ? 915 : 412, height: wide ? 412 : 915, useContentSize: true, show: true, backgroundColor: '#121418',
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, 'tv-preload.js'), contextIsolation: false, nodeIntegration: false, sandbox: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') console.log('console:', e.message); });
  await win.loadFile(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'mobile.html'));
  const js = code => win.webContents.executeJavaScript(code, true);
  const pre = wide ? 'L-' : '';
  const shot = async name => { await sleep(500); fs.writeFileSync(path.join(out, pre + name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const tap = async (sel, wait = 900) => { const ok = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`); if (!ok) log('NOT FOUND', sel); await sleep(wait); return ok; };
  const wideCheck = () => js("(() => { const W = document.documentElement.clientWidth; const over = [...document.querySelectorAll('#view *, #topbar *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('.hidden, .shelf-row, .seasons, .ev-filters, .guide, .cats'); }).slice(0, 5).map(e => e.tagName + '.' + e.className); return { W, scroll: document.documentElement.scrollWidth, over }; })()");
  try {
    await sleep(1500);
    await shot('p01-welcome');
    log('add playlist', await js(`window.api.invoke('profiles:save', { type: 'xtream', name: 'Demo provider', server: 'http://127.0.0.1:8790', username: 'demo', password: 'demo' }).then(r => r.ok)`));
    await js("start().then(() => reload())");
    await sleep(5000);
    await shot('p02-home');
    log('home', await wideCheck());
    await tap('.ph-tab[data-tab="live"]');
    await shot('p03-live');
    log('live', await wideCheck());
    await tap('.ph-catbar');
    await shot('p04-live-cats');
    await tap('#view .cats .cat:nth-of-type(3)');
    await shot('p05-live-cat-picked');
    await tap('.ph-tab[data-tab="movies"]', 1500);
    await shot('p06-movies');
    log('movies', await wideCheck());
    await tap('#grid .card', 1800);
    await shot('p07-movie');
    log('movie', await wideCheck());
    await tap('.ph-tab[data-tab="series"]', 1500);
    await tap('#grid .card', 2000);
    await shot('p08-show');
    log('show', await wideCheck());
    await tap('.ph-tab[data-tab="guide"]', 2500);
    await shot('p09-guide');
    await tap('.ph-tab[data-tab="more"]', 500);
    await shot('p10-more');
    await tap('#nav .nav[data-view="settings"]', 1200);
    await shot('p11-settings');
    await tap('.set-item[data-sec="vpn"]', 800);
    await shot('p12-settings-vpn');
    log('settings vpn', await wideCheck());
    log('back -> list', await js('window.__tvBack()'));
    await tap('.set-item[data-sec="playback"]', 800);
    await shot('p13-settings-playback');
    await js('window.__tvBack()');
    await tap('.ph-tab[data-tab="home"]', 1200);
    // a card's press-and-hold menu
    await js("(() => { const c = document.querySelector('.home .card'); if (c) { const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 })); } })()");
    await sleep(900);
    await shot('p14-menu');
    await js('window.__tvBack()');
    await js("document.querySelector('#search').focus(); document.querySelector('#search').value = 'the'; document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true }))");
    await sleep(1800);
    await shot('p15-search');
    await js("document.querySelector('#search').blur()");
    // a dialog: edit the playlist
    await js("(editProfile(state.profiles[0]), 0)");
    await sleep(800);
    await shot('p16-dialog');
    await js('window.__tvBack()');
    log('back chain', await js("(async () => { const r = []; for (let i = 0; i < 6; i++) { r.push(state.view + ':' + window.__tvBack()); await new Promise(z => setTimeout(z, 300)); } return r.join(' '); })()"));
  } catch (e) { log('HARNESS ERROR', e.stack); }
  app.quit();
});
