/* Starts the fake provider + the PHP sync server, runs tv-harness.js, then checks with the
   WINDOWS sync code that the vault the TV made can be read (same crypto on both).
   node devtest/tv-run.js <out folder>     (PHP with pdo_sqlite: php on PATH or PHP=…) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'sealtv-shots'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealtv-run-'));
const win = path.join(__dirname, '..', '..', 'seal-iptv');
const web = path.join(tmp, 'web');
fs.mkdirSync(web);
const srv = path.join(__dirname, '..', '..', 'seal-iptv-server');
for (const f of fs.readdirSync(srv)) fs.copyFileSync(path.join(srv, f), path.join(web, f));
fs.writeFileSync(path.join(web, 'config.php'), `<?php if (!defined('SEALIPTV')) { http_response_code(404); exit; }\nreturn ['setup_code' => 'TV-SETUP-1', 'data_dir' => ${JSON.stringify(path.join(tmp, 'vault'))}];\n`);

(async () => {
  const php = spawn(process.env.PHP || 'php', ['-S', '127.0.0.1:8798', '-t', web], { stdio: 'ignore' });
  const tv = spawn(process.execPath, [path.join(win, 'devtest', 'fake-xtream.js'), '8790'], { stdio: 'ignore', env: { ...process.env, FAKE_NOART: '1' } });
  await new Promise(r => setTimeout(r, 1200));
  try {
    const electron = require(path.join(win, 'node_modules', 'electron'));
    await new Promise(res => {
      const p = spawn(electron, [path.join(__dirname, 'tv-harness.js'), out], { env: { ...process.env, TV_DATA: path.join(tmp, 'tvdata') }, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', d => process.stdout.write(d));
      p.on('exit', res);
    });
    // a Windows PC joins the vault the TV made
    const { Store } = require(path.join(win, 'src', 'main', 'store'));
    const { Library } = require(path.join(win, 'src', 'main', 'library'));
    const { SyncService } = require(path.join(win, 'src', 'main', 'sync'));
    const dir = path.join(tmp, 'pc');
    const store = new Store(dir, null), library = new Library(dir);
    const sync = new SyncService({ dataDir: dir, store, library, appVersion: 'test' });
    const r = await sync.connect({ server: 'http://127.0.0.1:8798/', username: 'jeff', passphrase: 'my long vault passphrase', deviceName: 'PC' });
    const p = store.listProfiles()[0];
    console.log('Windows read the TV\'s vault', JSON.stringify({ items: r.items, playlist: p && p.name, login: p && store.getProfile(p.id).password === 'demo', watched: p && library.flags(p.id, ['movie:2001'])['movie:2001'].watched, avSync: store.getSettings().playback.avSync }));
  } catch (e) { console.log('RUN ERROR', e.message); }
  finally { php.kill(); tv.kill(); setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } }, 400); }
})();
