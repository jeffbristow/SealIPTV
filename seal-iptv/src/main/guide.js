/* =====================================================================
 * Seal IPTV — guide.js
 * ---------------------------------------------------------------------
 * The full TV guide (XMLTV) of a playlist, for the TV Guide page and
 * what's on in Live TV.
 *   - Xtream: the provider's own xmltv.php, made from the login (nothing
 *     to type in); any playlist: a guide address of its own (profile.guide),
 *     or 'off'.
 *   - Downloaded every few hours and read as it arrives (a guide is often
 *     30 MB or more); only the next day of programmes is kept, for the
 *     playlist's channels:
 *       catalog/<id>.guide.json
 *         { v: 1, fetchedAt, ch: { <tvg id>: [[start, end, title, desc], …] } }   (seconds)
 *   - A channel the guide has nothing for still asks the provider for its
 *     own listings (catalog.js).
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const KEEP_HOURS = 26;          // programmes kept: from now to a day ahead
const EVERY_HOURS = 6;          // a new copy after this
const THIN_HOURS = 1;           // … or sooner when the copy had little ahead of now
const DESC_MAX = 400;

/** "20261029100000 +0000" -> ms (0 when it isn't a time) */
function xmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d\d):?(\d\d)?/.exec(String(s || '').trim());
  if (!m) return 0;
  const off = m[7] ? (Number(m[7]) * 60 + Math.sign(Number(m[7] + '1')) * Number(m[8] || 0)) * 60000 : 0;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - off;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()] || all;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  try { return String.fromCodePoint(n); } catch { return ''; }
}).replace(/\s+/g, ' ').trim();

const ATTR = /([\w-]+)\s*=\s*"([^"]*)"/g;
const attrsOf = head => {
  const a = {};
  ATTR.lastIndex = 0;
  for (let m; (m = ATTR.exec(head));) a[m[1]] = m[2];
  return a;
};
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/, DESC = /<desc\b[^>]*>([\s\S]*?)<\/desc>/;
const tagText = (block, re) => { const m = re.exec(block); return m ? unxml(m[1]) : ''; };

/**
 * Reads XMLTV a piece at a time: push(text) as it arrives, end() after the last piece.
 * onProgramme({ channel, start, end, title, desc }) for each <programme> (times in ms);
 * keep(channel, start, end), when given, picks them first — the rest aren't decoded at all (a TV is slow).
 */
function xmltvReader(onProgramme, keep = null) {
  let buf = '', seen = false;
  const one = block => {
    const close = block.indexOf('>');
    const a = attrsOf(block.slice(0, close));
    const start = Number(a.start_timestamp) * 1000 || xmltvTime(a.start);
    const end = (Number(a.stop_timestamp) * 1000 || xmltvTime(a.stop)) || start + 3600000;
    if (!a.channel || !start || (keep && !keep(a.channel, start, end))) return;
    const title = tagText(block, TITLE);
    if (title) onProgramme({ channel: a.channel, start, end, title, desc: tagText(block, DESC) });
  };
  return {
    push(text) {
      buf += text;
      if (!seen) {
        if (/<tv[\s>]/.test(buf)) seen = true;
        else if (buf.length > 4096) throw new Error(buf.charCodeAt(0) === 0x1f ? 'The TV guide is compressed (.gz), which Seal IPTV can\'t read yet — use the address of the plain .xml guide.' : 'That address isn\'t an XMLTV guide.');
      }
      let at = 0;
      for (;;) {
        const s = buf.indexOf('<programme', at);
        if (s < 0) { at = Math.max(at, buf.length - 16); break; }   // a tag cut in two stays for the next piece
        const e = buf.indexOf('</programme>', s);
        if (e < 0) { at = s; break; }
        one(buf.slice(s, e));
        at = e + 12;
      }
      buf = buf.slice(at);
    },
    end() { if (!seen) throw new Error('That address isn\'t an XMLTV guide.'); }
  };
}

/** The body of a fetch answer, a piece at a time: the TV's fetch (pieces), a web stream (Node), or all at once. */
async function eachText(res, fn) {
  if (typeof res.pieces === 'function') return res.pieces(fn);
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(), dec = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fn(dec.decode(value, { stream: true }));
    }
    const rest = dec.decode();
    if (rest) fn(rest);
    return;
  }
  fn(await res.text());
}

class Guide {
  /**
   * @param o.dir        the catalog folder
   * @param o.vpn        VpnGuard
   * @param o.userAgent  () -> User-Agent string
   * @param o.fetch      fetch implementation
   */
  constructor({ dir, vpn, userAgent, fetch: fetchImpl }) {
    this.dir = dir;
    this.vpn = vpn;
    this.userAgent = userAgent || (() => 'SealIPTV');
    this.fetch = fetchImpl || globalThis.fetch;
    this.mem = new Map();        // pid -> the saved copy
    this.loading = new Map();    // pid -> its download
    this.failed = new Map();     // pid -> when the last download failed (tried again an hour later)
  }

  _file(pid) { return path.join(this.dir, String(pid).replace(/[^\w-]/g, '') + '.guide.json'); }

  /** Where a playlist's guide comes from: its own address, the Xtream provider's, or nowhere. */
  static address(p) {
    if (!p || p.guide === 'off') return '';
    if (p.guide) return p.guide;
    if (p.type === 'xtream' && p.server && p.username) return `${p.server}/xmltv.php?username=${encodeURIComponent(p.username)}&password=${encodeURIComponent(p.password || '')}`;
    return '';
  }

  /** The saved copy (memory, else disk), or null. */
  get(pid) {
    if (this.mem.has(pid)) return this.mem.get(pid);
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this._file(pid), 'utf8')); } catch { /* none yet */ }
    if (!d || d.v !== 1 || !d.ch) d = null;
    this.mem.set(pid, d);
    return d;
  }

  /** Time for a new copy? */
  due(pid) {
    const d = this.get(pid), now = Date.now();
    if (this.failed.has(pid) && now - this.failed.get(pid) < 3600000) return false;
    if (!d) return true;
    return now - d.fetchedAt > (d.thin ? THIN_HOURS : EVERY_HOURS) * 3600000;
  }

  /**
   * Download the guide (one download at a time per playlist).
   * want: the playlist's tvg ids (a Set), or null for every channel. -> the new copy
   */
  refresh(pid, p, want = null) {
    if (this.loading.has(pid)) return this.loading.get(pid);
    const url = Guide.address(p);
    if (!url) return Promise.resolve(null);
    const job = (async () => {
      const t0 = Date.now();
      try {
        await this.vpn.ensure();
        const res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent() }, signal: AbortSignal.timeout(180000), stream: true });
        if (!res.ok) throw new Error(`The TV guide answered ${res.status}.`);
        const now = Date.now(), until = now + KEEP_HOURS * 3600000, ch = {};
        let n = 0, ahead = 0;
        const reader = xmltvReader(e => {
          (ch[e.channel] || (ch[e.channel] = [])).push([Math.round(e.start / 1000), Math.round(e.end / 1000), e.title, e.desc.slice(0, DESC_MAX)]);
          n++;
          if (e.end > now + 3 * 3600000) ahead++;
        }, (channel, start, end) => end > now && start < until && (!want || want.has(channel)));
        await eachText(res, text => reader.push(text));
        reader.end();
        for (const k of Object.keys(ch)) ch[k].sort((a, b) => a[0] - b[0]);
        // little ahead of now: the provider hasn't put out today's guide yet — try again sooner
        const d = { v: 1, fetchedAt: Date.now(), thin: ahead < 50, channels: Object.keys(ch).length, programmes: n, ch };
        fs.mkdirSync(this.dir, { recursive: true });
        const tmp = this._file(pid) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(d).replace(/[Ā-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
        fs.renameSync(tmp, this._file(pid));
        this.mem.set(pid, d);
        this.failed.delete(pid);
        if (typeof console !== 'undefined') console.log(`[seal] guide: ${d.channels} channels, ${n} programmes in ${Date.now() - t0} ms`);
        return d;
      } catch (e) {
        this.failed.set(pid, Date.now());
        if (typeof console !== 'undefined') console.log('[seal] guide failed:', e.message);
        throw e;
      } finally {
        this.loading.delete(pid);
      }
    })();
    this.loading.set(pid, job);
    job.catch(() => { /* reported where it's awaited */ });
    return job;
  }

  /** A channel's programmes from now on, from the saved copy: [{ title, desc, start, end }] (ms), or null if it has none. */
  lookup(pid, tvgId, limit = 12) {
    const d = tvgId && this.get(pid);
    const list = d && d.ch[tvgId];
    if (!list) return null;
    const now = Date.now() / 1000;
    const out = [];
    for (const [s, e, title, desc] of list) {
      if (e <= now) continue;
      out.push({ title, desc, start: s * 1000, end: e * 1000 });
      if (out.length >= limit) break;
    }
    return out.length ? out : null;
  }

  forget(pid) {
    this.mem.delete(pid);
    try { fs.unlinkSync(this._file(pid)); } catch { /* none */ }
  }
}

module.exports = { Guide, xmltvReader, xmltvTime, eachText };
