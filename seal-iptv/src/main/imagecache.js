/* =====================================================================
 * Seal IPTV — imagecache.js   (Windows: every poster / logo kept on disk)
 * ---------------------------------------------------------------------
 * The window asks for pictures as sealimg://img/?u=<address> (app.js
 * imgSrc); main.js answers from here. The first time a picture is fetched
 * from the provider / TMDB / TVmaze (through the window's session, so the
 * VPN guard and the User-Agent apply) and kept in images/; after that it
 * comes from the disk, whatever the provider says about caching, through
 * restarts and updates.
 *
 * At most MAX_BYTES on disk: the ones not shown for longest go first.
 * Only pictures are kept (checked by their first bytes).
 * ===================================================================== */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 600 * 1024 * 1024;
const MAX_ONE = 8 * 1024 * 1024;
const DAY = 86400000;

/** the picture's type from its first bytes, or '' when it isn't one */
function sniff(b) {
  if (!b || b.length < 4) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('latin1', 8, 12))) return 'image/avif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

class ImageCache {
  /**
   * @param o.dir      folder for the pictures (userData/images)
   * @param o.fetch    (url) => Response — the window's session (VPN guard, User-Agent)
   * @param o.allowed  () => may the network be used now
   */
  constructor({ dir, fetch, allowed, maxBytes = MAX_BYTES }) {
    this.dir = dir;
    this.fetch = fetch;
    this.allowed = allowed || (() => true);
    this.maxBytes = maxBytes;
    this.pending = new Map();
    this.size = null;            // bytes on disk (counted on first use)
    this.trimming = null;
  }

  file(url) { return path.join(this.dir, crypto.createHash('sha1').update(url).digest('hex')); }

  /** url -> { status, type, body } */
  async get(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return { status: 400, type: 'text/plain', body: Buffer.alloc(0) };
    const f = this.file(url);
    try {
      const body = await fsp.readFile(f);
      const type = sniff(body);
      if (type) {
        this._touch(f);
        return { status: 200, type, body };
      }
    } catch { /* not kept yet */ }
    if (!this.allowed()) return { status: 403, type: 'text/plain', body: Buffer.alloc(0) };
    if (this.pending.has(url)) return this.pending.get(url);
    const job = this._download(url, f).finally(() => this.pending.delete(url));
    this.pending.set(url, job);
    return job;
  }

  async _download(url, f) {
    let res;
    try { res = await this.fetch(url); } catch { return { status: 502, type: 'text/plain', body: Buffer.alloc(0) }; }
    if (!res.ok) return { status: res.status || 502, type: 'text/plain', body: Buffer.alloc(0) };
    const body = Buffer.from(await res.arrayBuffer());
    const type = sniff(body);
    if (!type) return { status: 415, type: 'text/plain', body: Buffer.alloc(0) };   // not a picture (an error page …)
    if (body.length <= MAX_ONE) {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.writeFile(f + '.tmp', body);
        await fsp.rename(f + '.tmp', f);
        await this._count();
        this.size += body.length;
        if (this.size > this.maxBytes) this.trim();
      } catch { /* shown anyway; kept next time */ }
    }
    return { status: 200, type, body };
  }

  /** shown now: moved to the back of the queue for clearing out (at most once a day per picture) */
  _touch(f) {
    fsp.stat(f).then(s => {
      if (Date.now() - s.mtimeMs > DAY) { const now = new Date(); return fsp.utimes(f, now, now); }
    }).catch(() => {});
  }

  async _list() {
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!/^[0-9a-f]{40}$/.test(n)) continue;
      try { const s = await fsp.stat(path.join(this.dir, n)); out.push({ f: path.join(this.dir, n), size: s.size, t: s.mtimeMs }); } catch { /* gone */ }
    }
    return out;
  }

  async _count() {
    if (this.size == null) this.size = (await this._list()).reduce((n, x) => n + x.size, 0);
  }

  /** over the limit: the ones not shown for longest go, down to 90 % */
  trim() {
    if (this.trimming) return this.trimming;
    this.trimming = (async () => {
      const all = (await this._list()).sort((a, b) => a.t - b.t);
      let size = all.reduce((n, x) => n + x.size, 0);
      for (const x of all) {
        if (size <= this.maxBytes * 0.9) break;
        try { await fsp.unlink(x.f); size -= x.size; } catch { /* in use */ }
      }
      this.size = size;
    })().finally(() => { this.trimming = null; });
    return this.trimming;
  }
}

module.exports = { ImageCache, sniff };
