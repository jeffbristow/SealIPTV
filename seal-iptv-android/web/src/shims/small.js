/* path / os / util / events for the Fire TV app (just what the shared modules use). */
const { N } = require('./native');

const path = {
  sep: '/',
  join: (...a) => a.filter(x => x != null && x !== '').join('/').replace(/\/+/g, '/'),
  dirname: p => { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : '/'; },
  basename: (p, ext) => { let b = String(p).replace(/\/+$/, '').split('/').pop(); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
  resolve: (...a) => path.join(...a)
};

const os = {
  hostname: () => (N && N.deviceName ? N.deviceName() : 'Fire TV'),
  tmpdir: () => '/tmp',
  /** Like Node's: { name: [{ address, family, internal }] } — from Android's NetworkInterface list. */
  networkInterfaces: () => { try { return JSON.parse(N.interfaces()); } catch { return {}; } }
};

const util = {
  promisify: fn => (...args) => new Promise((resolve, reject) => fn(...args, (err, v) => (err ? reject(err) : resolve(v))))
};

class EventEmitter {
  constructor() { this._ev = new Map(); }
  on(n, fn) { if (!this._ev.has(n)) this._ev.set(n, []); this._ev.get(n).push(fn); return this; }
  off(n, fn) { const l = this._ev.get(n); if (l) this._ev.set(n, l.filter(f => f !== fn)); return this; }
  emit(n, ...a) { for (const fn of (this._ev.get(n) || []).slice()) fn(...a); return true; }
}

module.exports = { path, os, util, events: { EventEmitter } };
