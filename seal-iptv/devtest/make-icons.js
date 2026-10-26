/* =====================================================================
 * Seal IPTV — devtest/make-icons.js   (npm run icons)
 * ---------------------------------------------------------------------
 * Draws src/renderer/logo.svg at each icon size with Microsoft Edge
 * (headless) and writes:
 *   build/icon.ico          16 … 256 px, for the installer and the .exe
 *   build/icon.png          256 px
 *   src/renderer/icon.png   256 px, the window icon
 * ===================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const svg = path.join(root, 'src', 'renderer', 'logo.svg');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
if (!EDGE) { console.error('Microsoft Edge not found'); process.exit(1); }
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-icons-'));

const pngs = SIZES.map(size => {
  const html = path.join(tmp, `i${size}.html`);
  const out = path.join(tmp, `i${size}.png`);
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent"><img src="${'file:///' + svg.replace(/\\/g, '/')}" width="${size}" height="${size}" style="display:block"></body></html>`);
  execFileSync(EDGE, ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${out}`, 'file:///' + html.replace(/\\/g, '/')], { stdio: 'ignore' });
  return { size, data: fs.readFileSync(out) };
});

// ICO with PNG images inside (Windows Vista and later read these)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
const dir = Buffer.alloc(16 * pngs.length);
let offset = 6 + dir.length;
pngs.forEach((p, i) => {
  const o = i * 16;
  dir.writeUInt8(p.size >= 256 ? 0 : p.size, o);
  dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
  dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(p.data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += p.data.length;
});
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, dir, ...pngs.map(p => p.data)]));
const big = pngs.find(p => p.size === 256).data;
fs.writeFileSync(path.join(root, 'build', 'icon.png'), big);
fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), big);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Icons written: build/icon.ico (' + SIZES.join(', ') + ' px), build/icon.png, src/renderer/icon.png');
