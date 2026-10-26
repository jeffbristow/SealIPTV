/* =====================================================================
 * Seal IPTV — bootstrap.js   (the app's entry point)
 * ---------------------------------------------------------------------
 * Lets Seal IPTV update itself from a downloaded update package
 * (updater.js) without a new installer. Packages are kept in
 *   %APPDATA%\Seal IPTV\updates\seal-iptv-<version>.asar
 *
 * On every start:
 *   1. the newest package that's NEWER than the installed app runs;
 *      otherwise the installed copy (so a newer installer always wins)
 *   2. packages that will never be used are deleted
 *   3. a package that fails to start (an error, or twice no window:
 *      main.js clears boot.json once the window shows) is recorded as
 *      bad and the installed copy runs instead — a broken update can't
 *      lock you out
 * Running from the source folder (npm start) ignores packages unless
 * SEAL_IPTV_TEST_UPDATES=1.
 * ===================================================================== */
const { app } = require('electron');
const path = require('path');
const { readPackageJson, fs } = require('./asarinfo');
const { cmpVersion } = require('./updater');

// SEAL_IPTV_DATA: another data folder (tests never touch yours) — before the updates folder is read
if (process.env.SEAL_IPTV_DATA) app.setPath('userData', path.resolve(process.env.SEAL_IPTV_DATA));

const installedVersion = require('../../package.json').version;
const updatesDir = path.join(app.getPath('userData'), 'updates');
const badFile = path.join(updatesDir, 'bad-versions.json');
const bootFile = path.join(updatesDir, 'boot.json');
const readBad = () => { try { return JSON.parse(fs.readFileSync(badFile, 'utf8')); } catch { return []; } };

function findUpdate() {
  if (!app.isPackaged && process.env.SEAL_IPTV_TEST_UPDATES !== '1') return null;
  let names = [];
  try { names = fs.readdirSync(updatesDir); } catch { return null; }
  for (const f of names) if (/\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(updatesDir, f)); } catch { /* next start */ } }
  const bad = readBad();
  const found = [];
  for (const f of names.filter(n => /^seal-iptv-[\d.]+\.asar$/.test(n))) {
    const full = path.join(updatesDir, f);
    try {
      const pkg = readPackageJson(full);
      if (pkg.name === 'seal-iptv' && pkg.__hasMain && !bad.includes(pkg.version)) found.push({ full, version: pkg.version });
      else { try { fs.unlinkSync(full); } catch { /* ignore */ } }
    } catch { try { fs.unlinkSync(full); } catch { /* ignore */ } }
  }
  found.sort((a, b) => cmpVersion(b.version, a.version));
  const best = found[0] && cmpVersion(found[0].version, installedVersion) > 0 ? found[0] : null;
  for (const c of found) if (!best || c.full !== best.full) { try { fs.unlinkSync(c.full); } catch { /* ignore */ } }
  return best;
}

let started = false;
try {
  let upd = findUpdate();
  if (upd) {
    let boot = {};
    try { boot = JSON.parse(fs.readFileSync(bootFile, 'utf8')); } catch { /* first try */ }
    const tries = boot.version === upd.version ? (boot.tries || 0) : 0;
    if (tries >= 2) {
      fs.writeFileSync(badFile, JSON.stringify([...new Set([...readBad(), upd.version])]));
      upd = null;
    } else fs.writeFileSync(bootFile, JSON.stringify({ version: upd.version, tries: tries + 1 }));
  }
  if (upd) {
    process.env.SEAL_IPTV_RUNNING_VERSION = upd.version;
    process.env.SEAL_IPTV_UPDATE_FILE = upd.full;
    require(path.join(upd.full, 'src', 'main', 'main.js'));
    started = true;
  }
} catch (err) {
  console.error('The update didn\'t start; using the installed version:', err);
  try { fs.writeFileSync(badFile, JSON.stringify([...new Set([...readBad(), process.env.SEAL_IPTV_RUNNING_VERSION])])); } catch { /* ignore */ }
}
if (!started) {
  process.env.SEAL_IPTV_RUNNING_VERSION = installedVersion;
  delete process.env.SEAL_IPTV_UPDATE_FILE;
  require('./main.js');
}
