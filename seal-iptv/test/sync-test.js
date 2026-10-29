/* Seal IPTV self-test: sync between two PCs through the real PHP server (seal-iptv-server/).
   Needs PHP 8 with pdo_sqlite: `php` on the PATH, or PHP=<path to php.exe>. Skipped without it. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { Store } = require('../src/main/store');
const { Library } = require('../src/main/library');
const { Parental } = require('../src/main/parental');
const { SyncService } = require('../src/main/sync');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const rejects = async (p, re, msg) => { try { await p; } catch (e) { assert.ok(re.test(e.message), msg + ' — got: ' + e.message); passed++; console.log('  ✓ ' + msg); return e; } assert.fail(msg + ' — did not throw'); };

const PHP = process.env.PHP || 'php';
const probe = spawnSync(PHP, ['-r', 'echo in_array("sqlite", PDO::getAvailableDrivers()) ? "yes" : "no";'], { encoding: 'utf8' });
if (probe.error || !/yes\s*$/.test(probe.stdout)) {
  console.log('  - sync test skipped: no PHP with pdo_sqlite (set PHP=<path to php.exe>)');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-sync-'));
const web = path.join(root, 'web'), vaultDir = path.join(root, 'vault');
fs.mkdirSync(web);
for (const f of fs.readdirSync(path.join(__dirname, '..', '..', 'seal-iptv-server'))) fs.copyFileSync(path.join(__dirname, '..', '..', 'seal-iptv-server', f), path.join(web, f));
fs.writeFileSync(path.join(web, 'config.php'), `<?php if (!defined('SEALIPTV')) { http_response_code(404); exit; }\nreturn ['setup_code' => 'TEST-CODE-123', 'data_dir' => ${JSON.stringify(vaultDir)}, 'require_https' => true];\n`);
const PORT = 8000 + Math.floor(Math.random() * 900);
const server = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', web], { stdio: 'ignore' });
const URL_ = `http://127.0.0.1:${PORT}/`;

function pc(name) {
  const dir = path.join(root, name);
  const store = new Store(dir, null);
  const library = new Library(dir);
  const sync = new SyncService({ dataDir: dir, store, library, appVersion: 'test' });
  return { dir, store, library, sync, parental: new Parental(store) };
}
const PASS = 'correct horse battery staple';

(async () => {
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(URL_ + 'api.php?action=ping'); break; } catch { await new Promise(r => setTimeout(r, 150)); } }

    /* ---- PC A: some data, then create the vault ---- */
    const A = pc('A');
    const pA = A.store.saveProfile({ type: 'xtream', server: 'tv.example.com:8080', username: 'sam', password: 'provider-secret', name: 'Home TV' });
    A.library.setFavorite(pA.id, 'live:101', true, { name: 'Seal News 24' });
    A.library.setWatched(pA.id, 'episode:9001', true, { name: 'Harbor Patrol S01E01', seriesId: '3000' });
    A.library.setProgress(pA.id, 'movie:2001', 600, 5400, { name: 'Harbor Lights' });
    A.library.setCatFlag(pA.id, 'movies:7', { hide: true });
    A.store.setSettings({ playback: { watchedPercent: 85 }, content: { hideNonEnglish: true }, vpn: { required: true, adapter: 'ProtonVPN', homeIp: '1.2.3.4' } });
    A.parental.setPin('2468');

    const ping = await A.sync.probe(URL_);
    ok(!ping.vault && ping.setupOpen, 'the server answers: no vault yet, setup open');
    await rejects(A.sync.connect({ server: URL_, username: 'sam', passphrase: PASS, create: true, setupCode: 'WRONG' }), /setup code is not correct/, 'a wrong setup code is refused');
    const sa = await A.sync.connect({ server: URL_, username: 'sam', passphrase: PASS, create: true, setupCode: 'TEST-CODE-123', deviceName: 'PC A' });
    ok(sa.connected && sa.waiting === 0 && sa.items >= 9, `vault created; everything sent (${sa.items} records)`);

    /* ---- what the server holds ---- */
    const raw = fs.readFileSync(path.join(vaultDir, 'vault.sqlite')).toString('latin1') + (fs.existsSync(path.join(vaultDir, 'vault.sqlite-wal')) ? fs.readFileSync(path.join(vaultDir, 'vault.sqlite-wal')).toString('latin1') : '');
    ok(!/provider-secret|tv\.example\.com|Seal News|Harbor|2001|9001|Home TV/.test(raw), 'the server\'s database holds nothing readable (no logins, names or ids)');
    ok(/(fav|seen|pos|cat|profile|settings):[0-9a-f]{64}/.test(raw), 'item names are scrambled');

    /* ---- PC B: the same playlist set up by hand, plus its own favorite ---- */
    const B = pc('B');
    const pB = B.store.saveProfile({ type: 'xtream', server: 'tv.example.com:8080', username: 'sam', password: 'provider-secret', name: 'TV' });
    B.library.setFavorite(pB.id, 'live:202', true, { name: 'Sport One' });
    B.store.setSettings({ vpn: { adapter: 'Wi-Fi' } });
    await rejects(B.sync.connect({ server: URL_, username: 'sam', passphrase: 'wrong passphrase!' }), /Wrong username or passphrase/, 'a wrong passphrase is refused');
    const sb = await B.sync.connect({ server: URL_, username: 'sam', passphrase: PASS, deviceName: 'PC B' });
    ok(sb.joined.length === 1 && B.store.listProfiles().length === 1 && B.store.listProfiles()[0].id === pA.id, 'the same playlist on both PCs becomes one');
    ok(B.store.getProfile(pA.id).password === 'provider-secret', 'the provider login came across (inside the encryption)');
    ok(B.library.favorites(pA.id, 'live').map(f => f.id).sort().join() === '101,202', 'favorites from both PCs are kept');
    ok(B.library.flags(pA.id, ['episode:9001'])['episode:9001'].watched && B.library.getProgress(pA.id, 'movie:2001').pos === 600, 'watched marks and resume points came across');
    ok(B.library.catFlags(pA.id)['movies:7'].hide === true, 'the hidden category came across');
    const bs = B.store.getSettings();
    ok(bs.playback.watchedPercent === 85 && bs.content.hideNonEnglish && bs.vpn.required, 'settings came across');
    ok(bs.vpn.adapter === 'Wi-Fi' && !bs.vpn.homeIp, '… but not this PC\'s VPN adapter / home IP');
    ok(B.parental.hasPin() && (B.parental.unlock('2468'), B.parental.isUnlocked()), 'the parental PIN works on PC B too');
    ok(!B.parental.isUnlocked() || new Parental(B.store).isUnlocked() === false, 'entering it on one PC doesn\'t open the others');

    await A.sync.sync();
    ok(A.library.favorites(pA.id, 'live').some(f => f.id === '202'), 'PC A gets PC B\'s favorite');

    /* ---- changes flow both ways ---- */
    B.library.setFavorite(pA.id, 'live:101', false);
    B.library.setWatched(pA.id, 'episode:9002', true, { name: 'S01E02' });
    B.library.setCatFlag(pA.id, 'live:3', { lock: true });
    B.store.setSettings({ playback: { autoNext: false } });
    await B.sync.sync(); await A.sync.sync();
    ok(!A.library.favorites(pA.id, 'live').some(f => f.id === '101'), 'a removed favorite is removed on the other PC');
    ok(A.library.flags(pA.id, ['episode:9002'])['episode:9002'].watched, 'marked watched on B -> watched on A');
    ok(A.library.catFlags(pA.id)['live:3'].lock === true && A.store.getSettings().playback.autoNext === false, 'a locked category and a setting from B');

    A.library.setProgress(pA.id, 'movie:2001', 1800, 5400, {});
    await A.sync.sync(); await B.sync.sync();
    ok(B.library.getProgress(pA.id, 'movie:2001').pos === 1800, 'stop on A at 30:00 -> B resumes at 30:00');

    /* ---- both change the same thing: the newer change wins ---- */
    A.library.setFavorite(pA.id, 'movie:55', true, { name: 'X' });
    await new Promise(r => setTimeout(r, 5));
    B.library.setFavorite(pA.id, 'movie:55', true, { name: 'X' });
    await new Promise(r => setTimeout(r, 5));
    B.library.setFavorite(pA.id, 'movie:55', false);     // B's is newer
    await A.sync.sync(); await B.sync.sync(); await A.sync.sync();
    ok(!A.library.favorites(pA.id, 'movie').some(f => f.id === '55') && !B.library.favorites(pA.id, 'movie').some(f => f.id === '55'), 'conflict: the newer change (B: removed) wins on both');
    A.store.setSettings({ playback: { watchedPercent: 95 } });
    await new Promise(r => setTimeout(r, 5));
    B.store.setSettings({ playback: { watchedPercent: 80 } });
    await B.sync.sync(); await A.sync.sync(); await B.sync.sync();
    ok(A.store.getSettings().playback.watchedPercent === 80 && B.store.getSettings().playback.watchedPercent === 80, 'conflict on a setting: the newer one wins on both');

    /* ---- my own categories (Kids …) ---- */
    const kids = A.library.saveList(pA.id, null, { name: 'Kids', icon: '🧸' });
    A.library.setListed(pA.id, kids, 'series:77', true, { name: 'Bluey' });
    A.library.setListed(pA.id, kids, 'live:101', true, { name: 'Cartoons' });
    await A.sync.sync(); await B.sync.sync();
    ok(B.library.lists(pA.id).some(l => l.id === kids && l.name === 'Kids' && l.count === 2), 'a category made on A, with what\'s in it, appears on B');
    B.library.setListed(pA.id, kids, 'live:101', false);
    B.library.saveList(pA.id, kids, { name: 'Kids & family', icon: '🧸' });
    await B.sync.sync(); await A.sync.sync();
    ok(A.library.listItems(pA.id, kids).map(i => i.key).join() === 'series:77' && A.library.lists(pA.id)[0].name === 'Kids & family', 'taken out and renamed on B -> the same on A');
    // a device that had an older Seal IPTV skipped these records while pulling: it reads the vault once more
    B.library.applyRecord('list', pA.id, kids, null);
    for (const k of Object.keys(B.sync.state.known)) if (/^list(ed)?:/.test(k)) delete B.sync.state.known[k];
    B.sync.state.pullVersion = 1;
    await B.sync.sync();
    ok(B.library.listItems(pA.id, kids).length === 1 && B.sync.state.pullVersion === 3, 'after updating from an older version: the categories are fetched again');
    A.library.removeList(pA.id, kids);
    await A.sync.sync(); await B.sync.sync();
    ok(!B.library.lists(pA.id).length && !Object.keys(B.library._get(pA.id).listed).length, 'a category deleted on A goes on B, with its titles');

    /* ---- the watchlist ---- */
    A.library.setWatchlist(pA.id, 'movie:2001', true, { name: 'Film' });
    await A.sync.sync(); await B.sync.sync();
    ok(B.library.onWatchlist(pA.id, 'movie:2001'), 'a title put on the watchlist on A is on it on B');
    B.library.setWatched(pA.id, 'movie:2001', true, { name: 'Film' });
    await B.sync.sync(); await A.sync.sync();
    ok(!A.library.onWatchlist(pA.id, 'movie:2001'), 'watched on B: off the watchlist on A too');

    /* ---- clear history, delete a playlist ---- */
    A.library.clearHistory(pA.id);
    await A.sync.sync(); await B.sync.sync();
    ok(!B.library.flags(pA.id, ['episode:9001'])['episode:9001'].watched && !B.library.getProgress(pA.id, 'movie:2001'), 'clearing the history on A clears it on B');
    const p2 = A.store.saveProfile({ type: 'm3u', m3uUrl: 'https://lists.example.org/tv.m3u', name: 'Extra list' });
    await A.sync.sync(); await B.sync.sync();
    ok(B.store.listProfiles().some(p => p.id === p2.id), 'a new playlist on A appears on B');
    A.store.deleteProfile(p2.id);
    await A.sync.sync(); await B.sync.sync();
    ok(!B.store.listProfiles().some(p => p.id === p2.id), 'a deleted playlist goes on B too');

    /* ---- devices ---- */
    const devs = await A.sync.devices();
    ok(devs.length === 2 && devs.find(d => d.current).name === 'PC A', 'two devices; this one is marked');
    await A.sync.revoke(devs.find(d => !d.current).id);
    await rejects(B.sync.sync(), /signed out/, 'a signed-out device can\'t sync any more');
    ok(B.sync.status().needs === 'signin', '… and is told to sign in again');

    /* ---- a third PC can still join; delete the vault ---- */
    const C = pc('C');
    await C.sync.connect({ server: URL_, username: 'sam', passphrase: PASS, deviceName: 'PC C' });
    ok(C.store.listProfiles().length === 1 && C.store.getSettings().playback.watchedPercent === 80, 'a new PC gets everything');
    /* ---- "Connect a TV": a device in sync brings another one in, without the passphrase ---- */
    const inv = await C.sync.invite();
    ok(inv.server.startsWith(C.sync.status().server) && /^[0-9a-f]{64}$/.test(inv.authKey) && Buffer.from(inv.vaultKey, 'base64').length === 32 && !inv.fresh, 'a device in sync can invite another (no passphrase needed)');
    const T = pc('T');
    const st = await T.sync.joinWith({ ...inv, deviceName: 'Living room TV' });
    ok(st.connected && T.store.listProfiles().length === 1 && T.store.getProfile(pA.id).password === 'provider-secret', 'the TV joins with what was sent and gets everything');
    const tvDevs = await C.sync.devices();
    ok(tvDevs.length >= 2 && JSON.stringify(tvDevs).includes('Living room TV'), '… as a device of its own');
    T.library.setFavorite(pA.id, 'live:303', true, { name: 'Three' });
    await T.sync.sync();
    await C.sync.sync();
    ok(C.library.favorites(pA.id, 'live').some(f => f.id === '303'), 'and its changes reach the others');
    // a device connected before 1.5.0 doesn't keep the login key: the passphrase once
    delete C.sync.state.authKey;
    await rejects(C.sync.invite(), /passphrase/, 'an older connection asks for the passphrase once');
    const inv2 = await C.sync.invite(PASS);
    ok(inv2.fresh && inv2.authKey === inv.authKey, '… which gives the same login key');
    C.sync.keepAuthKey(inv2.authKey);
    ok(!(await C.sync.invite()).fresh, '… kept for next time');
    await rejects(pc('U').sync.joinWith({ ...inv, authKey: 'a'.repeat(64) }), /./, 'a wrong login key is refused by the server');

    await rejects(A.sync.destroy('wrong passphrase'), /not correct/, 'deleting the vault needs the passphrase');
    await A.sync.destroy(PASS);
    ok(!(await A.sync.probe(URL_)).vault && A.store.listProfiles().length === 1, 'vault deleted; the PC keeps its data');

    [A, B, C].forEach(x => x.library.flush());
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* php still closing */ }
  }
  console.log(`\nSync tests: ${passed} passed`);
})().catch(e => { server.kill(); console.error('FAILED:', e); process.exit(1); });
