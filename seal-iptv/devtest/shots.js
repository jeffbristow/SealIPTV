/* =====================================================================
 * Seal IPTV — devtest/shots.js
 * ---------------------------------------------------------------------
 *   node devtest/shots.js <output folder>
 * Starts the fake provider, opens Seal IPTV with a throwaway data folder
 * (your own settings are never used), clicks through the app, plays
 * streams and saves screenshots + a playback log in <output folder>.
 * Needs internet (the fake provider's streams are public test videos).
 * ===================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'sealiptv-shots'));
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-data-'));
const PORT = 8790;
const S = process.env.SHOT_SERVER || `http://127.0.0.1:${PORT}`;   // e.g. http://<this PC's LAN IP>:8790 (not loopback)

fs.writeFileSync(path.join(data, 'seal-iptv.json'), JSON.stringify({
  settings: { activeProfile: 'demo', playback: { resume: 'always', autoWatched: true, watchedPercent: 90, autoNext: true, externalPlayer: '' } },
  profiles: [
    { id: 'demo', type: 'xtream', name: 'Demo provider', server: S, username: 'demo', password: 'plain:demo', liveFormat: 'auto' },
    { id: 'demots', type: 'xtream', name: 'Demo (MPEG-TS)', server: S, username: 'demo', password: 'plain:demo', liveFormat: 'ts' }
  ]
}));

const shot = name => path.join(out, name + '.png');
const state = `JSON.stringify({ t: Math.round($('#video').currentTime), w: $('#video').videoWidth, paused: $('#video').paused, open: Player.isOpen(), msg: $('#pMsg').classList.contains('hidden') ? '' : $('#pMsg').innerText.slice(0, 160) })`;
const steps = [
  { js: 'reload()', wait: 5000, file: shot('01-home') },
  { js: "go('live')", wait: 1500 },
  { js: "document.querySelector('.channel').click()", wait: 2000, file: shot('02-live') },
  { js: 'playChannel(0)', wait: 9000, file: shot('03-player-live-hls'), log: 'live HLS', logJs: state },
  { js: 'Player.close()', wait: 500 },
  { js: "go('movies')", wait: 1800, file: shot('04-movies') },
  { js: "go('movie', '2000')", wait: 1500 },
  { js: "document.querySelector('#mActions .btn.primary').click()", wait: 15000, log: 'movie mp4 (10 s) after it ended', logJs: state },
  { js: "go('movie', '2000')", wait: 1500, file: shot('05-movie-watched') },
  { js: "go('movie', '2001')", wait: 1200 },
  { js: "document.querySelector('#mActions .btn.primary').click()", wait: 7000 },
  { js: "$('#video').currentTime = 300", wait: 4000, log: 'movie HLS after seeking to 5:00', logJs: state },
  { js: 'Player.close()', wait: 1200, file: shot('06-movie-resume') },
  { js: "go('show', '3000')", wait: 2000, file: shot('07-series') },
  { js: "document.querySelector('.episode').click()", wait: 14000, file: shot('08-next-episode'), log: 'episode after it ended', logJs: `JSON.stringify({ next: !$('#pNext').classList.contains('hidden'), text: $('#pNext').innerText.replace(/\\s+/g, ' ').trim() })` },
  { js: "document.querySelector('#pnStop') && document.querySelector('#pnStop').click()", wait: 1500 },
  { js: "go('show', '3000')", wait: 1500, file: shot('09-series-after') },
  { js: "go('home')", wait: 1800, file: shot('10-home-continue') },
  { js: "go('movie', '2003')", wait: 1500 },
  { js: "[...document.querySelectorAll('#mActions button')].find(b => /Watchlist/.test(b.textContent)).click()", wait: 800, file: shot('10b-movie-watchlist') },
  { js: "go('watchlist')", wait: 1200, file: shot('10c-watchlist') },
  { js: "go('sports')", wait: 2500, file: shot('10d-sports'), log: 'Sports page', logJs: `JSON.stringify([...document.querySelectorAll('#view .event-card .title')].map(t => t.textContent))` },
  { js: "go('ppv')", wait: 2000, file: shot('10e-ppv') },
  { js: "go('home')", wait: 2500, file: shot('10f-home-rows'), log: 'Home rows', logJs: `JSON.stringify([...document.querySelectorAll('#view .shelf-head h2')].map(t => t.textContent))` },
  { js: "useProfile('demots').then(() => reload())", wait: 5000 },
  { js: "go('live')", wait: 1500 },
  { js: 'playChannel(1)', wait: 14000, file: shot('11-player-live-ts'), log: 'live MPEG-TS', logJs: state },
  { js: 'Player.close()', wait: 500 },
  { js: "go('settings')", wait: 1500, file: shot('12-settings') },
  { js: "saveSettings({ vpn: { required: true, provider: 'other', adapter: 'No Such VPN' } }).then(() => call('vpn:check')).then(onVpnStatus)", wait: 2500, file: shot('13-settings-vpn-off') },
  { js: "go('live')", wait: 1500 },
  { js: 'playChannel(0)', wait: 2000, file: shot('14-vpn-blocked'), log: 'VPN off: player open?', logJs: 'JSON.stringify({ open: Player.isOpen(), dialog: $("#dlgTitle").textContent, imgsBlocked: [...document.querySelectorAll(".channel img")].length })' }
];
// `node devtest/shots.js <folder> sync`: only the audio sync checks
const canvasState = `JSON.stringify({ delay: AvSync.get(), device: AvSync.device(), canvas: !$('#pCanvas').classList.contains('hidden'), videoHidden: $('#video').classList.contains('behind'), t: Math.round($('#video').currentTime), paused: $('#video').paused,
  lit: (() => { const c = $('#pCanvas'); try { const d = c.getContext('2d').getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return Math.round(s / (d.length / 4)); } catch (e) { return 'error: ' + e.message; } })() })`;
const syncSteps = [
  { js: 'reload()', wait: 5000 },
  { js: "go('live')", wait: 1500 },
  { js: 'playChannel(0)', wait: 8000, log: 'before', logJs: canvasState },
  { js: 'AvSync.set(200)', wait: 3000, file: shot('s1-picture-delay'), log: 'picture waits 200 ms', logJs: canvasState },
  { js: "$('#pSyncBtn').click()", wait: 800, file: shot('s2-sync-panel') },
  { js: 'AvSync.set(-150)', wait: 2500, log: 'sound waits 150 ms', logJs: canvasState },
  { js: 'AvSync.set(0); Player.close()', wait: 800 },
  { js: 'AvSync.test(); 0', wait: 2600, file: shot('s3-sync-test'), log: 'test open', logJs: `JSON.stringify({ title: $('#dlgTitle').textContent, dotLeft: $('#syDot').style.left })` },
  { js: "$('#syPlus').click(); $('#syPlus').click(); $('#syMeasure').click()", wait: 1500, file: shot('s4-measure'), log: 'after +20 and Measure', logJs: `JSON.stringify({ value: AvSync.get(), note: $('#syMeasureNote').innerText, saved: state.settings.playback.avSync })` },
  { js: "$('#dlgOk').click(); go('settings')", wait: 1500, js2: '', file: shot('s5-settings') },
  { js: "document.querySelector('#avNow').scrollIntoView()", wait: 600, file: shot('s6-settings-sync') }
];
// `node devtest/shots.js <folder> http` (with SHOT_SERVER + FAKE_PROXY=1): streams over plain http from a non-local address
const httpSteps = [
  { js: 'reload()', wait: 5000, log: 'catalog', logJs: 'JSON.stringify(state.summary && state.summary.counts)' },
  { js: "go('live')", wait: 1500 },
  { js: 'playChannel(0)', wait: 9000, file: shot('h1-live-hls'), log: 'live HLS over http', logJs: state },
  { js: 'Player.close()', wait: 500 },
  { js: "Player.play({ kind: 'movie', id: '2000', name: 'MP4 movie', ext: 'mp4' }, { start: 0 })", wait: 6000, log: 'movie MP4 over http', logJs: state },
  { js: 'Player.close()', wait: 500 },
  { js: "Player.play({ kind: 'movie', id: '2001', name: 'HLS movie', ext: 'm3u8' }, { start: 0 })", wait: 8000, log: 'movie HLS over http', logJs: state },
  { js: 'Player.close()', wait: 500 },
  { js: "useProfile('demots').then(() => reload())", wait: 5000 },
  { js: "go('live')", wait: 1500 },
  { js: 'playChannel(1)', wait: 12000, file: shot('h2-live-ts'), log: 'live TS over http', logJs: state },
  { js: 'Player.close()', wait: 500 },
  { log: 'poster', logJs: "(() => { const i = document.querySelector('.channel img'); return i ? JSON.stringify({ src: i.currentSrc, ok: i.complete && i.naturalWidth > 0 }) : 'no img (fell back to initials)'; })()" }
];
// `node devtest/shots.js <folder> fail`: the error screen with its details (channel 7 is "offline")
const failSteps = [
  { js: 'reload()', wait: 4000 },
  { js: "go('live')", wait: 1200 },
  { js: 'playChannel(6)', wait: 9000 },
  { js: "document.querySelector('.p-details').open = true", wait: 500, file: shot('f1-error-details'), log: 'details', logJs: "document.querySelector('.p-details pre').textContent" }
];
// `node devtest/shots.js <folder> search`: search ranking + the search box keeping focus
const searchSteps = [
  { js: 'reload()', wait: 4000 },
  { js: "go('movies'); const b = $('#search'); b.focus(); b.value = 'the'; b.oninput()", wait: 1500, file: shot('q1-movies-the'),
    log: 'movies "the"', logJs: "JSON.stringify({ focus: document.activeElement === $('#search'), sort: $('#sortSel').selectedOptions[0].textContent, first: [...document.querySelectorAll('.card .title')].slice(0, 6).map(t => t.textContent) })" }
];
// `node devtest/shots.js <folder> guide`: the TV Guide page, the playlist's TV guide choice, a series page
const guideSteps = [
  { js: 'reload()', wait: 4000 },
  { js: "go('guide')", wait: 2500, file: shot('g1-guide'),
    log: 'TV Guide', logJs: "JSON.stringify({ cat: state.guide.cat, rows: document.querySelectorAll('.g-row').length, filled: [...document.querySelectorAll('.g-row')].filter(r => r._list).length, info: $('#gInfo').innerText.replace(/\\s+/g, ' ').slice(0, 100) })" },
  { js: "document.querySelectorAll('.g-row')[3].querySelectorAll('.g-p')[1].focus()", wait: 500, file: shot('g2-guide-programme'),
    log: 'a programme chosen', logJs: "$('#gInfo').innerText.replace(/\\s+/g, ' ').slice(0, 140)" },
  { js: "(window.__ed = editProfile(state.profiles[0]), 0)", wait: 800, file: shot('g3-playlist-guide'),
    log: 'playlist editor', logJs: "JSON.stringify({ mode: $('#pfGuideMode').value, hint: $('#pfGuideHint').textContent, field: !$('#pfGuide').classList.contains('hidden') })" },
  { js: "$('#pfGuideMode').value = 'url'; $('#pfGuideMode').onchange()", wait: 300, file: shot('g4-playlist-guide-url'),
    log: 'guide address chosen', logJs: "JSON.stringify({ hint: $('#pfGuideHint').textContent, field: !$('#pfGuide').classList.contains('hidden') })" },
  { js: "$('#dlgCancel').click(); call('catalog:list', { section: 'series', offset: 0, limit: 1 }).then(r => go('show', r.items[0].id))", wait: 2000, file: shot('g5-series') }
];
// `node devtest/shots.js <folder> smooth`: frame timing with no delay (the <video>) vs +200 ms (the canvas)
// Counts how often the picture changes over 4 s: gaps between new frames, their spread, long stalls.
const measure = `new Promise(done => {
  const v = $('#video'), useCanvas = AvSync.get() > 0, t0 = performance.now(), p0 = AvSync.stats().pushed;
  const gaps = []; let prev = 0;
  const vfc = now => { if (!useCanvas) { if (prev) gaps.push(now - prev); prev = now; } if (performance.now() - t0 < 4000) v.requestVideoFrameCallback(vfc); };
  v.requestVideoFrameCallback(vfc);
  setTimeout(() => {
    const st = AvSync.stats();
    if (useCanvas) { const p = st.paints.filter(t => t >= t0); for (let i = 1; i < p.length; i++) gaps.push(p[i] - p[i - 1]); }
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length, sd = Math.sqrt(gaps.reduce((a, b) => a + (b - avg) ** 2, 0) / gaps.length);
    done(JSON.stringify({ engine: AvSync.engine(), delay: AvSync.get(), shown: gaps.length + 1, fromPipeline: st.pushed - p0, queued: st.queued, avgGapMs: +avg.toFixed(1), spreadMs: +sd.toFixed(1), stalls: gaps.filter(x => x > avg * 1.8).length, longestMs: Math.round(Math.max(...gaps)) }));
  }, 4000);
})`;
const smoothSteps = [
  { js: 'reload()', wait: 4000 },
  { js: "Player.play({ kind: 'movie', id: '2001', name: 'HLS movie', ext: 'm3u8' }, { start: 60 })", wait: 7000 },
  { js: '0', wait: 100, log: 'no delay', logJs: measure },
  { js: 'AvSync.set(200)', wait: 2000, log: '+200 ms', logJs: measure },
  { js: 'AvSync.set(400)', wait: 2000, log: '+400 ms', logJs: measure },
  { js: 'AvSync.set(0); window.MediaStreamTrackProcessor = undefined; AvSync.set(200)', wait: 2000, log: '+200 ms backup', logJs: measure },
  { js: 'AvSync.set(0)', wait: 300 }
];
// `node devtest/shots.js <folder> parental`: PIN locks, hidden categories, other languages
const catsNow = "JSON.stringify({ cats: [...document.querySelectorAll('#cats .cat')].map(b => b.innerText.replace(/\s+/g, ' ').trim()), channels: document.querySelectorAll('#chList .channel').length, dialog: $('#dlgModal').classList.contains('hidden') ? '' : $('#dlgTitle').textContent })";
const parentalSteps = [
  { js: 'reload()', wait: 4000 },
  { js: "go('live')", wait: 1500, file: shot('p1-live-locked'), log: 'live, locked', logJs: catsNow },
  { js: "[...document.querySelectorAll('#cats .cat')].find(b => b.innerText.includes('Adult')).click()", wait: 800, file: shot('p2-set-pin-first'), log: 'click Adult (no PIN yet)', logJs: catsNow },
  { js: "$('#dlgCancel').click(); call('parental:setPin', '2468').then(() => call('parental:lock')).then(s => { state.parental = s; updateLockBtn(); render(); })", wait: 1200 },
  { js: "[...document.querySelectorAll('#cats .cat')].find(b => b.innerText.includes('Adult')).click()", wait: 800, file: shot('p3-pin-prompt') },
  { js: "$('#pinIn').value = '1111'; $('#dlgOk').click()", wait: 800, log: 'wrong PIN', logJs: "$('#pinErr').textContent" },
  { js: "$('#pinIn').value = '2468'; $('#dlgOk').click()", wait: 1800, file: shot('p4-unlocked'), log: 'right PIN', logJs: catsNow },
  { js: "const b = [...document.querySelectorAll('#cats .cat')].find(b => b.innerText.includes('Sports')); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }))", wait: 600, file: shot('p5-category-menu') },
  { js: "[...document.querySelectorAll('#ctxMenu button')].find(b => b.innerText.includes('Lock with')).click()", wait: 1200 },
  { js: "$('#lockBtn').click()", wait: 1500, file: shot('p5b-after-lock'), log: 'Sports locked too, PIN locked again', logJs: catsNow },
  { js: "go('settings')", wait: 1200 },
  { js: "document.querySelector('#catPanel').previousElementSibling.scrollIntoView()", wait: 800, file: shot('p6-settings-parental') },
  { js: "document.querySelector('#cForeign').click()", wait: 1500 },
  { js: "document.querySelector('#catPanel').scrollIntoView()", wait: 800, file: shot('p7-settings-categories'), log: 'categories table', logJs: "[...document.querySelectorAll('#cTable .cat-row:not(.head)')].map(r => r.innerText.replace(/\s+/g, ' ').trim()).join(' | ')" },
  { js: "go('live')", wait: 1500, log: 'live, non-English hidden', logJs: catsNow },
  { js: "go('movies')", wait: 1500, file: shot('p8-movies-foreign-hidden'), log: 'movie categories', logJs: "JSON.stringify([...document.querySelectorAll('#cats .cat')].map(b => b.innerText.replace(/\s+/g, ' ').trim()))" }
];
const stepsFile = path.join(data, 'steps.json');
fs.writeFileSync(stepsFile, JSON.stringify(process.argv[3] === 'sync' ? syncSteps : process.argv[3] === 'http' ? httpSteps : process.argv[3] === 'fail' ? failSteps : process.argv[3] === 'search' ? searchSteps : process.argv[3] === 'guide' ? guideSteps : process.argv[3] === 'smooth' ? smoothSteps : process.argv[3] === 'parental' ? parentalSteps : steps));

const server = spawn(process.execPath, [path.join(__dirname, 'fake-xtream.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
const served = [];
server.stdout.on('data', d => served.push(...String(d).trim().split('\n')));
setTimeout(() => {
  const electron = require(path.join(root, 'node_modules', 'electron'));
  const app = spawn(electron, [root], { env: { ...process.env, SEAL_IPTV_DATA: data, SEAL_IPTV_SHOTS: stepsFile }, stdio: 'inherit' });
  app.on('exit', code => {
    server.kill();
    fs.writeFileSync(path.join(out, 'server-log.txt'), served.join('\n'));
    console.log(`\nApp exited (${code}). Screenshots in ${out}`);
    fs.rmSync(data, { recursive: true, force: true });
  });
}, 800);
