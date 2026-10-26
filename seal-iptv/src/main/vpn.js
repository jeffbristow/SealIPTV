/* =====================================================================
 * Seal IPTV — vpn.js   (the VPN guard)
 * ---------------------------------------------------------------------
 * With Settings → VPN → "Only play when my VPN is on", nothing reaches
 * the IPTV provider (playlist, posters, streams) unless the VPN is
 * confirmed. The check fails closed: if it can't be confirmed, it's off.
 *
 * ProtonVPN:
 *   1. a ProtonVPN network adapter is up (it's called "ProtonVPN")
 *   2. Proton's own API confirms the traffic comes from a Proton server:
 *      api.protonvpn.ch/vpn/location answers code 86081 ("Location cannot
 *      be calculated when connected to a VPN server"). If that API can't
 *      be reached, ipinfo.io must name Proton as the network.
 * Other VPNs:
 *   1. the VPN's adapter is up (chosen in Settings, or found by name)
 *   2. the public IP isn't your home IP (if remembered), and the network
 *      name contains what you entered (if anything)
 *
 * While the VPN is required, main.js asks quickly every few seconds
 * whether the adapter is still there and fully every minute; a change is
 * sent to the window, which stops playback.
 *
 * Sections:
 *   1. Adapters
 *   2. The check
 *   3. Watching for changes
 * ===================================================================== */
const os = require('os');
const { EventEmitter } = require('events');

const PROTON_RE = /proton/i;
const VPN_NAME_RE = /proton|wireguard|\bwg\d*\b|openvpn|\btap\b|\btun\d*\b|nord|mullvad|surfshark|express|windscribe|private internet|\bpia\b|cyberghost|ipvanish|tunnelbear|vpn/i;
const PROTON_API = 'https://api.protonvpn.ch/vpn/location';
const IPINFO = 'https://ipinfo.io/json';
const IPIFY = 'https://api.ipify.org?format=json';
const PROTON_ON_VPN = 86081;
const CACHE_MS = 10000;

class VpnGuard extends EventEmitter {
  /**
   * @param o.getSettings  () -> settings (uses settings.vpn)
   * @param o.fetch        fetch implementation (tests pass a fake)
   * @param o.interfaces   () -> os.networkInterfaces()-like object
   * @param o.vpnActive    () -> name | null — Android (Fire TV) says itself whether a VPN
   *                       is connected; the interface is just "tun0", so names don't help there
   */
  constructor({ getSettings, fetch: fetchImpl, interfaces, vpnActive }) {
    super();
    this.vpnActive = vpnActive || null;
    this.getSettings = getSettings;
    this.fetch = fetchImpl || globalThis.fetch;
    this.interfaces = interfaces || os.networkInterfaces;
    this.last = null;
    this._pending = null;
  }

  /* =================================================================
   * 1. ADAPTERS
   * ================================================================= */
  /** Connected adapters: [{ name, address, vpnLike }] */
  adapters() {
    const out = [];
    for (const [name, addrs] of Object.entries(this.interfaces() || {})) {
      const a = (addrs || []).find(x => !x.internal && (x.family === 'IPv4' || x.family === 4)) || (addrs || []).find(x => !x.internal);
      if (a) out.push({ name, address: a.address, vpnLike: VPN_NAME_RE.test(name) });
    }
    return out;
  }

  /** The VPN's adapter name, or null when it isn't connected. */
  findAdapter(cfg) {
    if (this.vpnActive && !cfg.adapter) return this.vpnActive() || null;
    const list = this.adapters();
    if (cfg.adapter) return (list.find(a => a.name === cfg.adapter) || {}).name || null;
    const re = cfg.provider === 'proton' ? PROTON_RE : VPN_NAME_RE;
    return (list.find(a => re.test(a.name)) || {}).name || null;
  }

  async _json(url, ms = 6000) {
    const res = await this.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    return JSON.parse(text);
  }

  /** ipinfo.io, then ipify (IP only): { ip, isp, place } — throws if both fail. */
  async publicIp() {
    try {
      const j = await this._json(IPINFO);
      if (j && j.ip) return { ip: j.ip, isp: String(j.org || '').replace(/^AS\d+\s+/, ''), place: [j.city, j.country].filter(Boolean).join(', ') };
    } catch { /* try the next */ }
    const j = await this._json(IPIFY);
    if (j && j.ip) return { ip: j.ip, isp: '', place: '' };
    throw new Error('no answer');
  }

  /* =================================================================
   * 2. THE CHECK
   *    -> { ok, required, state, title, detail, adapter, ip, isp, place, at }
   *       state: 'off' (not required) | 'ok' | 'down' | 'leak' | 'unknown'
   * ================================================================= */
  status() {
    const cfg = this.getSettings().vpn;
    if (!cfg.required) return { ok: true, required: false, state: 'off', title: 'VPN not required', detail: '', at: Date.now() };
    return this.last && this.last.required ? this.last : { ok: false, required: true, state: 'unknown', title: 'Checking the VPN…', detail: '', at: 0 };
  }

  async check({ force = false } = {}) {
    const cfg = this.getSettings().vpn;
    if (!cfg.required) return this._set(this.status());
    if (!force && this.last && this.last.required && Date.now() - this.last.at < CACHE_MS) return this.last;
    if (this._pending) return this._pending;
    this._pending = this._check(cfg).then(r => this._set(r)).finally(() => { this._pending = null; });
    return this._pending;
  }

  async _check(cfg) {
    const base = { required: true, at: Date.now(), provider: cfg.provider };
    const proton = cfg.provider === 'proton';
    const adapter = this.findAdapter(cfg);
    if (!adapter) {
      return { ...base, ok: false, state: 'down', adapter: null, title: 'VPN is off',
        detail: proton ? 'ProtonVPN isn\'t connected. Connect it, then try again.'
          : cfg.adapter ? `The VPN adapter "${cfg.adapter}" isn't connected. Connect your VPN, then try again.`
          : 'No VPN connection was found. Connect your VPN, then try again (or choose its adapter in Settings → VPN).' };
    }

    if (proton) {
      let viaProton = null, seen = null;
      try {
        const j = await this._json(PROTON_API);
        if (j && Number(j.Code) === PROTON_ON_VPN) viaProton = true;
        else if (j && j.IP) { viaProton = false; seen = { ip: j.IP, isp: j.ISP || '' }; }
      } catch { /* fall back to ipinfo */ }
      let info = null;
      try { info = await this.publicIp(); } catch { /* shown below */ }
      if (viaProton === null && info) viaProton = /proton/i.test(info.isp);
      if (viaProton) return { ...base, ok: true, state: 'ok', adapter, ip: info ? info.ip : '', isp: info ? info.isp : 'Proton AG', place: info ? info.place : '', title: 'ProtonVPN is on', detail: info && info.place ? `Connected through ${info.place}.` : 'Connected through ProtonVPN.' };
      if (viaProton === false) {
        const s = seen || info;
        return { ...base, ok: false, state: 'leak', adapter, ip: s.ip, isp: s.isp, title: 'Not going through ProtonVPN',
          detail: `The ProtonVPN adapter is up, but your traffic leaves from ${s.ip}${s.isp ? ` (${s.isp})` : ''}. Reconnect ProtonVPN, then try again.` };
      }
      return { ...base, ok: false, state: 'unknown', adapter, title: 'Couldn\'t confirm the VPN',
        detail: 'Seal IPTV couldn\'t reach Proton or ipinfo.io to confirm the VPN. Nothing plays until the VPN can be confirmed.' };
    }

    // another VPN
    if (!cfg.homeIp && !cfg.ispMatch) {
      let info = null;
      try { info = await this.publicIp(); } catch { /* optional here */ }
      return { ...base, ok: true, state: 'ok', adapter, ip: info ? info.ip : '', isp: info ? info.isp : '', place: info ? info.place : '', title: 'VPN is on', detail: `Adapter "${adapter}" is connected.` };
    }
    let info;
    try { info = await this.publicIp(); } catch {
      return { ...base, ok: false, state: 'unknown', adapter, title: 'Couldn\'t confirm the VPN', detail: 'Seal IPTV couldn\'t look up your public IP to confirm the VPN. Nothing plays until it can.' };
    }
    if (cfg.homeIp && info.ip === cfg.homeIp) {
      return { ...base, ok: false, state: 'leak', adapter, ...info, title: 'Your home IP is showing', detail: `The VPN adapter is up, but your traffic leaves from your home IP (${info.ip}). Reconnect the VPN, then try again.` };
    }
    if (cfg.ispMatch && !info.isp.toLowerCase().includes(cfg.ispMatch.toLowerCase())) {
      return { ...base, ok: false, state: 'leak', adapter, ...info, title: 'Not going through your VPN', detail: `Your traffic leaves through "${info.isp || 'an unknown network'}", not "${cfg.ispMatch}". Reconnect the VPN, then try again.` };
    }
    return { ...base, ok: true, state: 'ok', adapter, ...info, title: 'VPN is on', detail: info.place ? `Connected through ${info.place}.` : `Adapter "${adapter}" is connected.` };
  }

  _set(r) {
    const before = this.last;
    this.last = r;
    if (!before || before.ok !== r.ok || before.state !== r.state || before.ip !== r.ip) this.emit('status', r);
    return r;
  }

  /** Throws (code 'VPN', with .vpn = status) unless the VPN is confirmed or not required. */
  async ensure() {
    const s = await this.check();
    if (!s.ok) {
      const e = new Error(`${s.title}. ${s.detail}`);
      e.code = 'VPN';
      e.vpn = s;
      throw e;
    }
    return s;
  }

  /** Synchronous: may the window contact the provider right now? */
  allowed() {
    const cfg = this.getSettings().vpn;
    return !cfg.required || !!(this.last && this.last.required && this.last.ok);
  }

  /* =================================================================
   * 3. WATCHING FOR CHANGES
   * ================================================================= */
  start({ quickMs = 4000, fullMs = 60000 } = {}) {
    this.stop();
    let lastFull = 0;
    this._timer = setInterval(() => {
      const cfg = this.getSettings().vpn;
      if (!cfg.required) {
        if (this.last && this.last.required) this._set(this.status());
        return;
      }
      const adapter = this.findAdapter(cfg);
      const wasUp = this.last && this.last.state !== 'down';
      if (!adapter && (wasUp || !this.last)) { this.check({ force: true }).catch(() => {}); lastFull = Date.now(); return; }
      if (adapter && this.last && this.last.state === 'down') { this.check({ force: true }).catch(() => {}); lastFull = Date.now(); return; }
      if (Date.now() - lastFull >= fullMs) { lastFull = Date.now(); this.check({ force: true }).catch(() => {}); }
    }, quickMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() { clearInterval(this._timer); this._timer = null; }
}

module.exports = { VpnGuard, PROTON_ON_VPN, VPN_NAME_RE };
