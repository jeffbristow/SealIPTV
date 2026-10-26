/* =====================================================================
 * Seal IPTV — tools/release.js   (making a release)
 * ---------------------------------------------------------------------
 *   node tools/release.js             build everything into dist/release/<version>/
 *   node tools/release.js --publish   … and publish it as GitHub release v<version>
 *                                     (needs release-notes/<version>.md and gh logged in)
 *
 * The version is seal-iptv/package.json "version" (Windows, Fire TV pages
 * and the APK's versionName all use it). What goes in:
 *   SealIPTV-Setup-<v>.exe          Windows installer (new PCs)
 *   SealIPTV-<v>.sealiptv           Windows update package (app.asar)
 *   SealIPTV-FireTV-<v>.apk         Fire TV app (new TVs; Android changes)
 *   SealIPTV-TV-<v>.zip             Fire TV update package (assets/www)
 *   SealIPTV-Sync-Server-<sv>.zip   the sync server (never with config.php)
 *   update.json + update.json.sig   what's in the release, signed
 *
 * update.json is signed with the release key in
 *   %USERPROFILE%\.sealiptv\update-signing-key.pem
 * which must never be shared or committed. Without it nobody can make an
 * update the apps accept — keep a backup somewhere safe (if it's lost, a new
 * key means installing the next version by hand on every device).
 *
 * When to raise what:
 *   seal-iptv/package.json "updateMinInstalled"  a release needs a newer
 *       Electron or a new bootstrap.js: PCs older than this get the installer
 *   seal-iptv-android/app/build.gradle versionCode  the Android (Java) part changed
 *   seal-iptv-android/web/build.js MIN_NATIVE  the pages need the new Java part
 * ===================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WIN = path.join(ROOT, 'seal-iptv');
const TV = path.join(ROOT, 'seal-iptv-android');
const SRV = path.join(ROOT, 'seal-iptv-server');
const KEY = path.join(os.homedir(), '.sealiptv', 'update-signing-key.pem');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');   // Windows' tar makes .zip files
const publish = process.argv.includes('--publish');

const pkg = JSON.parse(fs.readFileSync(path.join(WIN, 'package.json'), 'utf8'));
const V = pkg.version;
const OUT = path.join(ROOT, 'dist', 'release', V);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const size = f => fs.statSync(f).size;
const step = t => console.log('\n== ' + t);
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

if (!fs.existsSync(KEY)) { console.error('The release key is missing: ' + KEY); process.exit(1); }
const key = crypto.createPrivateKey(fs.readFileSync(KEY));
// the key must be the one the apps know
const { PUBLIC_KEY } = require(path.join(WIN, 'src', 'main', 'updater.js'));
if (crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') !== PUBLIC_KEY) {
  console.error('The release key doesn\'t match the public key in updater.js / UpdateManager.java.');
  process.exit(1);
}
const notesFile = path.join(ROOT, 'release-notes', `${V}.md`);
if (publish && !fs.existsSync(notesFile)) { console.error(`Write release-notes/${V}.md first (what's new, shown in the apps).`); process.exit(1); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

step(`Tests (${V})`);
run('npm test', WIN);

step('Windows installer + update package');
run('npx electron-builder --win nsis --x64 --publish never', WIN);
const setup = path.join(OUT, `SealIPTV-Setup-${V}.exe`);
fs.copyFileSync(path.join(WIN, 'dist', `SealIPTV-Setup-${V}.exe`), setup);
const winPkg = path.join(OUT, `SealIPTV-${V}.sealiptv`);
fs.copyFileSync(path.join(WIN, 'dist', 'win-unpacked', 'resources', 'app.asar'), winPkg);
const inPkg = require(path.join(WIN, 'src', 'main', 'asarinfo.js')).readPackageJson(winPkg);
if (inPkg.version !== V || !inPkg.__hasMain) { console.error('The Windows package doesn\'t look right:', inPkg.version); process.exit(1); }

step('Fire TV app + update package');
run('powershell -NoProfile -ExecutionPolicy Bypass -File build-apk.ps1', TV);
const apk = path.join(OUT, `SealIPTV-FireTV-${V}.apk`);
fs.copyFileSync(path.join(ROOT, 'dist', `SealIPTV-FireTV-${V}.apk`), apk);
const www = path.join(TV, 'app', 'src', 'main', 'assets', 'www');
const webInfo = JSON.parse(fs.readFileSync(path.join(www, 'version.json'), 'utf8'));
if (webInfo.version !== V) { console.error('The Fire TV pages are version ' + webInfo.version); process.exit(1); }
const tvZip = path.join(OUT, `SealIPTV-TV-${V}.zip`);
execFileSync(TAR, ['-a', '-c', '-f', tvZip, '-C', www, '.']);
const versionCode = Number((fs.readFileSync(path.join(TV, 'app', 'build.gradle'), 'utf8').match(/versionCode\s+(\d+)/) || [])[1]);

step('Sync server');
const srvVersion = (fs.readFileSync(path.join(SRV, 'lib.php'), 'utf8').match(/SEALIPTV_SERVER_VERSION = '([\d.]+)'/) || [])[1];
const srvZip = path.join(OUT, `SealIPTV-Sync-Server-${srvVersion}.zip`);
const srvFiles = fs.readdirSync(SRV).filter(f => f !== 'config.php' && !f.startsWith('seal-iptv-data'));
execFileSync(TAR, ['-a', '-c', '-f', srvZip, '-C', ROOT, ...srvFiles.map(f => 'seal-iptv-server/' + f)]);
if (execFileSync(TAR, ['-t', '-f', srvZip]).toString().split(/\r?\n/).some(l => /(^|\/)config\.php$/.test(l))) {
  console.error('config.php got into the server zip!'); process.exit(1);
}

step('update.json');
const manifest = {
  version: V,
  date: new Date().toISOString().slice(0, 10),
  notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').slice(0, 4000) : '',
  windows: {
    file: path.basename(winPkg), sha256: sha(winPkg), size: size(winPkg),
    minInstalled: pkg.updateMinInstalled || V,
    installer: path.basename(setup)
  },
  tv: {
    web: { file: path.basename(tvZip), sha256: sha(tvZip), size: size(tvZip), minNative: webInfo.minNative },
    apk: { file: path.basename(apk), sha256: sha(apk), size: size(apk), versionCode }
  },
  server: { file: path.basename(srvZip), sha256: sha(srvZip), version: srvVersion }
};
const json = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'update.json'), json);
fs.writeFileSync(path.join(OUT, 'update.json.sig'), crypto.sign('sha256', json, { key, dsaEncoding: 'der' }).toString('base64') + '\n');
if (!require(path.join(WIN, 'src', 'main', 'updater.js')).verifySignature(json, fs.readFileSync(path.join(OUT, 'update.json.sig'), 'utf8'))) {
  console.error('The signature doesn\'t check out.'); process.exit(1);
}
console.log(JSON.stringify(manifest, null, 2));
console.log('\nRelease files in', OUT);

if (publish) {
  step(`Publishing v${V} on GitHub`);
  const files = fs.readdirSync(OUT).map(f => path.join(OUT, f));
  execFileSync('gh', ['release', 'create', `v${V}`, ...files, '--repo', 'jeffbristow/SealIPTV', '--title', `Seal IPTV ${V}`, '--notes-file', notesFile, '--latest'], { stdio: 'inherit' });
}
