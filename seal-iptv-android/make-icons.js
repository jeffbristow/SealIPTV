/* Seal IPTV for Fire TV — make-icons.js: launcher icons + the Fire TV banner (320×180), drawn with
   Microsoft Edge from ../seal-iptv/src/renderer/logo.svg. Run: node make-icons.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const logo = 'file:///' + path.join(__dirname, '..', 'seal-iptv', 'src', 'renderer', 'logo.svg').replace(/\\/g, '/');
const res = path.join(__dirname, 'app', 'src', 'main', 'res');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealtv-icons-'));

function shot(name, w, h, body, transparent) {
  const html = path.join(tmp, name + '.html'), out = path.join(tmp, name + '.png');
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${transparent ? 'transparent' : '#121418'}">${body}</body></html>`);
  execFileSync(EDGE, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', ...(transparent ? ['--default-background-color=00000000'] : []), `--window-size=${w},${h}`, `--screenshot=${out}`, 'file:///' + html.replace(/\\/g, '/')], { stdio: 'ignore' });
  return out;
}

for (const [dir, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  const pad = Math.round(size * 0.04);
  const out = shot('ic' + size, size, size, `<div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;background:#181b21;display:flex;align-items:center;justify-content:center"><img src="${logo}" width="${size - pad * 2}" height="${size - pad * 2}"></div>`, true);
  fs.copyFileSync(out, path.join(res, 'mipmap-' + dir, 'ic_launcher.png'));
}
const banner = shot('banner', 320, 180, `<div style="width:320px;height:180px;display:flex;align-items:center;gap:14px;padding:0 22px;box-sizing:border-box;background:linear-gradient(135deg,#1f232b,#121418);font-family:'Segoe UI',Arial,sans-serif">
  <img src="${logo}" width="112" height="112"><div><div style="color:#e6e8ec;font-size:34px;font-weight:700;line-height:1">Seal</div><div style="color:#3ccf91;font-size:34px;font-weight:700;line-height:1.05">IPTV</div></div></div>`);
fs.copyFileSync(banner, path.join(res, 'drawable-xhdpi', 'banner.png'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('icons + banner written');
