/* =====================================================================
 * Seal IPTV for Ubuntu Touch — devtest/ut-harness.js
 * ---------------------------------------------------------------------
 * The Ubuntu Touch app on this PC: backend/backend.py (Python, its own data in a
 * temp folder) + its page (ut.html) in a phone-sized Electron window — the
 * real bridge (utnative.js -> HTTP -> Python), no phone needed. Adds the fake
 * provider's playlist (devtest/fake-xtream.js on :8790), reloads it, takes
 * screenshots and prints the page's memory.
 *   ..\seal-iptv\node_modules\.bin\electron devtest\ut-harness.js <out folder>
 * ===================================================================== */
const { app, BrowserWindow } = require('electron');
console.log('harness starts');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const out = path.resolve(process.argv[2] || 'ut-shots');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v));

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealut-'));
  const py = spawn(process.env.PYTHON || 'C:/Python314/python.exe', ['-u', path.join(__dirname, '..', 'backend', 'backend.py')], { env: { ...process.env, XDG_DATA_HOME: path.join(tmp, 'data'), XDG_CACHE_HOME: path.join(tmp, 'cache') } });
  py.stderr.on('data', d => process.stdout.write('[py] ' + d));
  const url = await new Promise(res => py.stdout.on('data', d => { const m = String(d).match(/http:\/\/\S+/); if (m) res(m[0]); }));
  log('backend at', url);
  const win = new BrowserWindow({ width: 360, height: 760, useContentSize: true, show: true, backgroundColor: '#121418', webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning' || String(e.message).startsWith('[seal]')) console.log('console:', e.message); });
  win.loadURL(url);
  await new Promise(r => win.webContents.once('dom-ready', r));
  log('page', 'dom ready');
  const js0 = code => win.webContents.executeJavaScript(code, true);
  await sleep(1500);
  log('side request', await js0("fetch(SEAL_UT_SIDE + '/n/request', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8790/player_api.php?username=demo&password=demo' }) }).then(r => r.text()).then(t => t.slice(0, 160)).catch(e => 'ERR ' + e.message)"));
  log('native request', await js0("new Promise(res => { const id = 'x1'; const old = window.__nativeDone; window.__nativeDone = i => { if (i === id) { window.__nativeDone = old; res(SealNative.take(id).slice(0, 160)); } else old(i); }; SealNative.request(id, JSON.stringify({ url: 'http://127.0.0.1:8790/player_api.php?username=demo&password=demo' })); })"));
  const js = code => win.webContents.executeJavaScript(code, true);
  const shot = async name => { await sleep(400); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const mem = () => js('Math.round(performance.memory.usedJSHeapSize / 1048576)');
  try {
    await sleep(2500);
    await shot('ut1-welcome');
    log('add playlist', await js(`window.api.invoke('profiles:save', { type: 'xtream', name: 'Demo provider', server: 'http://127.0.0.1:8790', username: 'demo', password: 'demo' }).then(r => r.ok)`));
    win.webContents.reload();
    await sleep(3000);
    log('heap MB after start', await mem());
    const t = Date.now();
    log('reload', await js(`reload().then(() => JSON.stringify(state.summary && state.summary.counts))`));
    log('reload took ms', Date.now() - t);
    for (let i = 0; i < 6; i++) { await sleep(2500); log('heap MB', await mem()); }
    await shot('ut2-home');
  } catch (e) { log('HARNESS ERROR', e.stack); }
  py.kill();
  app.quit();
});
