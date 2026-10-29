/* =====================================================================
 * Seal IPTV for Fire TV — web/build.js   (npm run build)
 * ---------------------------------------------------------------------
 * Puts the app's web part in ../app/src/main/assets/www:
 *   core.js       the shared logic (../../seal-iptv/src/main) + shims/, one file
 *   index.html    the Windows app's page with the TV parts instead of the
 *                 web players (hls.js / mpegts.js / player.js)
 *   app.js, avsync.js, styles.css, logo.svg, icon.png, networks/   copied from Windows
 *   tvnav.js, player-tv.js, tv.css, tvflag.js            the TV parts
 *   version.json  { version, minNative }: the version (seal-iptv/package.json) and
 *                 the oldest APK (versionCode) these pages work with — raise
 *                 MIN_NATIVE when they start using a new NativeBridge call
 * Run it after changing anything in seal-iptv/src/renderer or src/main.
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const WIN = path.join(__dirname, '..', '..', 'seal-iptv', 'src', 'renderer');
const OUT = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const SH = p => path.join(__dirname, 'src', 'shims', p);
const VERSION = require('../../seal-iptv/package.json').version;
const MIN_NATIVE = 4;   // versionCode 4 (1.1.0): updates, editText
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src', 'core.js')],
  bundle: true,
  outfile: path.join(OUT, 'core.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome80'],
  alias: { fs: SH('fs.js'), path: SH('path.js'), os: SH('os.js'), crypto: SH('crypto.js'), util: SH('util.js'), events: SH('events.js') },
  inject: [SH('inject.js')],
  define: { __SEAL_VERSION__: JSON.stringify(VERSION), SEAL_TV_BUNDLE: 'true' },
  loader: { '.dat': 'text' },   // studios.dat: the studio collections' list, in the bundle
  legalComments: 'none',
  logLevel: 'warning'
});

for (const f of ['app.js', 'avsync.js', 'styles.css', 'logo.svg', 'icon.png']) fs.copyFileSync(path.join(WIN, f), path.join(OUT, f));
// network logos for US local stations (main/networks.js)
fs.cpSync(path.join(WIN, 'networks'), path.join(OUT, 'networks'), { recursive: true, filter: f => !f.endsWith('.txt') });
for (const f of ['tvnav.js', 'player-tv.js', 'tv.css']) fs.copyFileSync(path.join(__dirname, 'src', f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, 'tvflag.js'), "window.SEAL_TV = true; document.documentElement.classList.add('tv');\n");

let html = fs.readFileSync(path.join(WIN, 'index.html'), 'utf8');
const swap = (a, b) => { if (!html.includes(a)) throw new Error('index.html changed: ' + a.slice(0, 50)); html = html.replace(a, b); };
swap('<html lang="en">', '<html lang="en" class="tv">');
swap('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=1280, user-scalable=no">');
swap('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n<link rel="stylesheet" href="tv.css">');
swap(`<script src="../../node_modules/hls.js/dist/hls.min.js"></script>
<script src="../../node_modules/mpegts.js/dist/mpegts.js"></script>
<script src="app.js"></script>
<script src="avsync.js"></script>
<script src="player.js"></script>`, `<script src="tvflag.js"></script>
<script src="core.js"></script>
<script src="app.js"></script>
<script src="avsync.js"></script>
<script src="tvnav.js"></script>
<script src="player-tv.js"></script>`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// the page a phone opens for "Set up from your phone" (phone/page.js, served by PhoneServer.java): one file, its script inline
const phoneJs = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'src', 'phone', 'page.js')], bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome80', 'safari14'], minify: true, legalComments: 'none', logLevel: 'warning' }).outputFiles[0].text;
const phoneHtml = fs.readFileSync(path.join(__dirname, 'src', 'phone', 'phone.html'), 'utf8');
if (!phoneHtml.includes('/*PAGE_JS*/')) throw new Error('phone.html changed: no /*PAGE_JS*/');
fs.writeFileSync(path.join(OUT, 'phone.html'), phoneHtml.replace('/*PAGE_JS*/', () => phoneJs.replace(/<\/(script)/gi, '<\/$1')));
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ version: VERSION, minNative: MIN_NATIVE }) + '\n');

const kb = f => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
console.log(`web part ${VERSION} built in ${OUT}: core.js ${kb('core.js')} KB, app.js ${kb('app.js')} KB`);
