/* A pretend Android side (window.SealNative) for tv-harness.js: Node files, Node http(s),
   "Keystore" = reversible encoding, VPN = is the ProtonVPN adapter of this PC up. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const root = process.env.TV_DATA || path.join(os.tmpdir(), 'sealtv-harness-data');
const file = p => path.join(root, String(p).replace(/^\/data\/?/, ''));
const answers = new Map();

function get(o, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(o.url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: o.method || 'GET', headers: o.headers || {}, timeout: o.timeout || 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && o.redirect !== 'error' && hops < 5) {
        res.resume();
        return resolve(get({ ...o, url: new URL(res.headers.location, o.url).href }, hops + 1));
      }
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => resolve({ ok: true, status: res.statusCode, url: o.url, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

window.SealNative = {
  readFile: p => { try { return fs.readFileSync(file(p), 'utf8'); } catch { return null; } },
  writeFile: (p, t) => { fs.mkdirSync(path.dirname(file(p)), { recursive: true }); fs.writeFileSync(file(p), t); return true; },
  renameFile: (a, b) => { try { fs.renameSync(file(a), file(b)); return true; } catch { return false; } },
  deleteFile: p => { try { fs.unlinkSync(file(p)); return true; } catch { return false; } },
  exists: p => fs.existsSync(file(p)),
  encrypt: s => 'K' + Buffer.from(s).toString('base64'),
  decrypt: s => (s && s[0] === 'K' ? Buffer.from(s.slice(1), 'base64').toString() : null),
  interfaces: () => JSON.stringify(os.networkInterfaces()),
  vpnActive: () => (os.networkInterfaces().ProtonVPN ? 'Android VPN (tun0)' : null),
  audioOutput: () => 'Roku Streambar SE (Bluetooth)',
  deviceName: () => 'Living room Fire TV',
  appVersion: () => '1.0.0',
  request: (id, json) => {
    get(JSON.parse(json)).then(r => answers.set(id, JSON.stringify(r)), e => answers.set(id, JSON.stringify({ ok: false, error: e.message })))
      .finally(() => window.__nativeDone(id));
  },
  take: id => { const a = answers.get(id); answers.delete(id); return a; },
  launchApp: () => false,
  openExternal: u => { window.__ext = u; return true; },
  showKeyboard: () => {},
  editText: j => { const o = JSON.parse(j); setTimeout(() => window.__tvText(o.value), 50); },
  exitApp: () => { window.__exited = true; },
  setGuard: (b, ua) => { window.__guard = { blocked: b, ua }; },
  play: json => { window.__played = JSON.parse(json); },
  playerCommand: json => { (window.__cmds = window.__cmds || []).push(JSON.parse(json)); }
};
