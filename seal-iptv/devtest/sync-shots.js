/* =====================================================================
 * Seal IPTV — devtest/sync-shots.js
 * ---------------------------------------------------------------------
 *   node devtest/sync-shots.js <output folder>
 * Two Seal IPTV windows (PC A, PC B — throwaway data folders) and the
 * real seal-iptv-server (php -S) + the fake provider. A creates the
 * vault through Settings → Sync; then A and B run AT THE SAME TIME:
 * B connects, hides a category and adds a favorite, and A must show
 * both by itself (no restart). Needs PHP with pdo_sqlite (PHP=…).
 * ===================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'sealiptv-sync-shots'));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-syncui-'));
const PHP = process.env.PHP || 'php';
const SYNC_PORT = 8796, TV_PORT = 8790;
const SYNC = `http://127.0.0.1:${SYNC_PORT}/`;

// the sync server, from seal-iptv-server/
const web = path.join(tmp, 'web');
fs.mkdirSync(web);
const srcDir = path.join(root, '..', 'seal-iptv-server');
for (const f of fs.readdirSync(srcDir)) fs.copyFileSync(path.join(srcDir, f), path.join(web, f));
fs.writeFileSync(path.join(web, 'config.php'), `<?php if (!defined('SEALIPTV')) { http_response_code(404); exit; }\nreturn ['setup_code' => 'MY-SETUP-CODE-42', 'data_dir' => ${JSON.stringify(path.join(tmp, 'vault'))}];\n`);

// two PCs with the same playlist, set up separately (different ids)
const pcData = (name, pid) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'seal-iptv.json'), JSON.stringify({ settings: { activeProfile: pid }, profiles: [{ id: pid, type: 'xtream', name: 'Demo provider', server: `http://127.0.0.1:${TV_PORT}`, username: 'demo', password: 'plain:demo', liveFormat: 'auto' }] }));
  return dir;
};
const dirA = pcData('A', 'pc-a-demo'), dirB = pcData('B', 'pc-b-demo');

const shot = n => path.join(out, n + '.png');
const fill = (create, device) => `(() => { go('settings');
  setTimeout(() => {
    ${create ? "document.querySelector('#syMode button[data-m=create]').click();" : ''}
    setTimeout(() => {
      $('#syServer').value = ${JSON.stringify(SYNC)}; $('#syUser').value = 'jeff'; $('#syDevice').value = ${JSON.stringify(device)};
      $('#syPass').value = 'my long vault passphrase';
      ${create ? "$('#syPass2').value = 'my long vault passphrase'; $('#syCode').value = 'MY-SETUP-CODE-42';" : ''}
      $('#syGo').click();
    }, 300);
  }, 600); return 0; })()`;
const favs = "Promise.all([call('lib:favorites', 'live'), call('catalog:cats', 'live'), call('sync:status')]).then(([f, c, s]) => JSON.stringify({ favorites: f.map(x => x.name), categories: c.cats.map(x => x.name), sync: { items: s.items, waiting: s.waiting, lastError: s.lastError } }))";

const stepsA1 = [
  { js: 'reload()', wait: 4000 },
  { js: fill(true, 'PC A'), wait: 9000, file: shot('y1-A-vault-created'), log: 'A after creating the vault', logJs: "JSON.stringify(state.sync)" },
  { js: "call('lib:favorite', 'live:1000', true, { name: 'Seal News 24' })", wait: 3000, log: 'A favorites', logJs: favs }
];
const stepsB = [
  { js: 'reload()', wait: 4000 },
  { js: fill(false, 'PC B'), wait: 9000, file: shot('y2-B-connected'), log: 'B after connecting', logJs: favs },
  { js: "call('cats:flag', 'live', '6', { hide: true }).then(() => call('lib:favorite', 'live:1004', true, { name: 'Sport One' }))", wait: 4000, log: 'B after hiding "Documentary" + favorite', logJs: favs }
];
const stepsA2 = [
  { js: "go('home')", wait: 26000, file: shot('y3-A-got-B-changes'), log: 'A, ~25 s later (no restart)', logJs: favs },
  { js: "go('live')", wait: 1500, file: shot('y4-A-live-categories'), log: 'A live categories on screen', logJs: "JSON.stringify([...document.querySelectorAll('#cats .cat .name')].map(n => n.textContent))" },
  { js: "go('settings')", wait: 1500, file: shot('y5-A-sync-panel') }
];

function runApp(dir, steps, label) {
  const f = path.join(tmp, label + '-steps.json');
  fs.writeFileSync(f, JSON.stringify(steps));
  const electron = require(path.join(root, 'node_modules', 'electron'));
  return new Promise(res => {
    const p = spawn(electron, [root], { env: { ...process.env, SEAL_IPTV_DATA: dir, SEAL_IPTV_SHOTS: f }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => String(d).split('\n').filter(l => l.trim() && !l.startsWith('saved')).forEach(l => console.log(`[${label}] ${l}`)));
    p.stderr.on('data', () => {});
    p.on('exit', res);
  });
}

(async () => {
  const php = spawn(PHP, ['-S', `127.0.0.1:${SYNC_PORT}`, '-t', web], { stdio: 'ignore' });
  const tv = spawn(process.execPath, [path.join(__dirname, 'fake-xtream.js'), String(TV_PORT)], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  try {
    await runApp(dirA, stepsA1, 'A');                                         // A creates the vault
    await Promise.all([runApp(dirA, stepsA2, 'A'), new Promise(r => setTimeout(r, 1500)).then(() => runApp(dirB, stepsB, 'B'))]);   // together
  } finally {
    php.kill(); tv.kill();
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } }, 500);
    console.log('Screenshots in ' + out);
  }
})();
