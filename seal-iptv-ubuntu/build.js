/* =====================================================================
 * Seal IPTV for Ubuntu Touch — build.js
 * ---------------------------------------------------------------------
 *   node build.js           the pages: ../seal-iptv-android/web/build.js (the same
 *                           core.js / app.js / phone pages as Android), copied to
 *                           www/, plus ut.html = mobile.html with utnative.js first
 *   node build.js --click   … and the click package -> ../dist/seal-iptv.jeffbristow_<ver>_<arch>.click
 *                           (arch: --arch=arm64 | armhf | all; default all — the app is QML +
 *                           Python + web pages, nothing compiled)
 * A click is a Debian-style ar archive: debian-binary, control.tar.gz (control,
 * manifest, md5sums), data.tar.gz (the app's files), built here without clickable.
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const ANDROID_WEB = path.join(ROOT, '..', 'seal-iptv-android', 'web');
const ANDROID_WWW = path.join(ROOT, '..', 'seal-iptv-android', 'app', 'src', 'main', 'assets', 'www');
const WWW = path.join(ROOT, 'www');
// (a --debug build gets .<time> on the end, so installing it again always replaces the last one)
const VERSION = require('../seal-iptv/package.json').version + (process.argv.includes('--debug') ? '.' + Math.floor(Date.now() / 1000) : '');
const APP_ID = 'seal-iptv.jeffbristow';

// ---- the pages ----
execFileSync(process.execPath, [path.join(ANDROID_WEB, 'build.js')], { cwd: ANDROID_WEB, stdio: 'inherit' });
fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(ANDROID_WWW, WWW, { recursive: true, filter: f => !/[\\/](index\.html|tvnav\.js|tv\.css|tvflag\.js)$/.test(f) });
let html = fs.readFileSync(path.join(WWW, 'mobile.html'), 'utf8');
if (!html.includes('<script src="phoneflag.js"></script>')) throw new Error('mobile.html changed: no phoneflag.js');
html = html.replace('<script src="phoneflag.js"></script>', '<script src="utnative.js"></script>\n<script src="phoneflag.js"></script>');
fs.writeFileSync(path.join(WWW, 'ut.html'), html);
html = html.replace('<script src="player-tv.js"></script>', '<script src="player-tv.js"></script>\n<script src="hls.min.js"></script>\n<script src="mpegts.js"></script>\n<script src="utplayer.js"></script>');
html = html.replace('<link rel="stylesheet" href="phone.css">', '<link rel="stylesheet" href="phone.css">\n<link rel="stylesheet" href="utplayer.css">');
if (!html.includes('utplayer.js') || !html.includes('utplayer.css')) throw new Error('mobile.html changed: no player-tv.js / phone.css');
fs.writeFileSync(path.join(WWW, 'ut.html'), html);
for (const f of ['utnative.js', 'utplayer.js', 'utplayer.css']) fs.copyFileSync(path.join(ROOT, 'web', f), path.join(WWW, f));
// the backup player's stream engines (the same as Windows)
const NM = path.join(ROOT, '..', 'seal-iptv', 'node_modules');
fs.copyFileSync(path.join(NM, 'hls.js', 'dist', 'hls.min.js'), path.join(WWW, 'hls.min.js'));
fs.copyFileSync(path.join(NM, 'mpegts.js', 'dist', 'mpegts.js'), path.join(WWW, 'mpegts.js'));
console.log(`Ubuntu Touch pages ${VERSION} in ${WWW}`);

if (!process.argv.includes('--click')) process.exit(0);

// ---- the click package ----
const archArg = (process.argv.find(a => a.startsWith('--arch=')) || '--arch=all').slice(7);
const manifest = {
  name: APP_ID, title: 'Seal IPTV', version: VERSION, maintainer: 'Jeff Bristow <noreply@example.com>',
  description: 'IPTV player: Xtream Codes and M3U playlists, favorites, watched marks, resume, sync and a VPN guard',
  framework: process.env.UT_FRAMEWORK || 'ubuntu-touch-24.04-1.x', architecture: archArg,
  hooks: { 'seal-iptv': { apparmor: 'seal-iptv.apparmor', desktop: 'seal-iptv.desktop' } },
  'installed-size': '0'
};

// tar (ustar) of [ [name, Buffer | null (folder), mode] ]
function tar(entries) {
  const blocks = [];
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const [name, data, mode] of entries) {
    const h = Buffer.alloc(512);
    const isDir = data === null;
    let nm = name, prefix = '';
    if (Buffer.byteLength(nm) > 99) { const i = nm.lastIndexOf('/', 154); prefix = nm.slice(0, i); nm = nm.slice(i + 1); }
    h.write(nm, 0, 100, 'utf8');
    h.write(oct(mode || (isDir ? 0o755 : 0o644), 8), 100);
    h.write(oct(0, 8), 108); h.write(oct(0, 8), 116);
    h.write(oct(isDir ? 0 : data.length, 12), 124);
    h.write(oct(Math.floor(Date.now() / 1000), 12), 136);
    h.write('        ', 148);
    h.write(isDir ? '5' : '0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    h.write('root', 265); h.write('root', 297);
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0; for (const b of h) sum += b;
    h.write(oct(sum, 7) + ' ', 148);
    blocks.push(h);
    if (!isDir) { blocks.push(data); const pad = (512 - (data.length % 512)) % 512; if (pad) blocks.push(Buffer.alloc(pad)); }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function walk(dir, base, out) {
  for (const n of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, n), rel = base ? base + '/' + n : n;
    if (fs.statSync(f).isDirectory()) { out.push(['./' + rel, null]); walk(f, rel, out); }
    else if (!/__pycache__|\.pyc$/.test(f)) out.push(['./' + rel, fs.readFileSync(f), /\.(sh|py)$/.test(n) ? 0o755 : 0o644]);
  }
}

const files = [['./', null]];
for (const [src, dest] of [['www', 'www'], ['qml', 'qml'], ['backend', 'backend'], ['assets', 'assets']]) { files.push(['./' + dest, null]); walk(path.join(ROOT, src), dest, files); }
// --debug (testing only, never a release): Chromium's DevTools on the phone's 127.0.0.1:9222 (adb forward)
const DEBUG = process.argv.includes('--debug');
for (const f of ['seal-iptv.apparmor', 'seal-iptv.desktop', 'manifest.json']) {
  let data = f === 'manifest.json' ? Buffer.from(JSON.stringify(manifest, null, 2) + '\n') : fs.readFileSync(path.join(ROOT, f));
  if (f === 'seal-iptv.desktop' && DEBUG) data = Buffer.from(data.toString().replace('Exec=qmlscene', 'Exec=env QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222 qmlscene'));
  files.push(['./' + f, data]);
}
const size = files.reduce((s, [, d]) => s + (d ? d.length : 0), 0);
manifest['installed-size'] = String(Math.ceil(size / 1024));
files.find(f => f[0] === './manifest.json')[1] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');

const md5sums = files.filter(([, d]) => d).map(([n, d]) => `${crypto.createHash('md5').update(d).digest('hex')}  ${n.slice(2)}`).join('\n') + '\n';
const control = [`Package: ${APP_ID}`, `Version: ${VERSION}`, 'Click-Version: 0.4', `Architecture: ${archArg}`,
  `Maintainer: ${manifest.maintainer}`, `Installed-Size: ${manifest['installed-size']}`, `Description: ${manifest.description}`, ''].join('\n');
const controlTar = zlib.gzipSync(tar([['./', null], ['./control', Buffer.from(control)], ['./manifest', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')], ['./md5sums', Buffer.from(md5sums)]]));
const dataTar = zlib.gzipSync(tar(files));

// ar archive
function ar(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, data] of members) {
    const h = Buffer.alloc(60, ' ');
    h.write(name.padEnd(16), 0); h.write(String(Math.floor(Date.now() / 1000)).padEnd(12), 16);
    h.write('0'.padEnd(6), 28); h.write('0'.padEnd(6), 34); h.write('100644'.padEnd(8), 40);
    h.write(String(data.length).padEnd(10), 48); h.write('`\n', 58);
    parts.push(h, data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}
const click = ar([['debian-binary', Buffer.from('2.0\n')], ['_click-binary', Buffer.from('0.4\n')], ['control.tar.gz', controlTar], ['data.tar.gz', dataTar]]);
const out = path.join(ROOT, '..', 'dist', `${APP_ID}_${VERSION}_${archArg}.click`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, click);
console.log(`click: ${out} (${Math.round(click.length / 1024)} KB)`);
