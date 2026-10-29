/* =====================================================================
 * Seal IPTV — tvfind.js   ("Connect a TV", Settings → Sync)
 * ---------------------------------------------------------------------
 * A Seal IPTV that's connected to sync (a PC, a Fire TV, a Google TV)
 * brings a TV into the same vault: the TV shows "Set up from your phone"
 * (a code and a little web server, PhoneServer.java); this finds it on
 * the home network, and sends it what it needs to join (sync.invite),
 * sealed with the code (setuplink.js) — nobody types an address or a
 * passphrase on the TV.
 *
 *   lanAddresses(interfaces)  this device's home-network IPv4 addresses
 *   find({ addresses, fetch })  the TVs showing the setup window: [{ address, name }]
 *   send({ address, code, data, fetch })  -> the TV's answer { ok, text | error }
 * ===================================================================== */
const link = require('./setuplink');

const PORTS = [8765, 8766, 8767];   // PhoneServer takes the first free one from 8765

/** { name: [{ address, family, internal }] } (os.networkInterfaces() / SealNative.interfaces()) -> home-network IPv4s, Wi-Fi / Ethernet first */
function lanAddresses(all) {
  const ok = [];
  for (const [name, list] of Object.entries(all || {})) {
    if (/^(tun|ppp|wg|ipsec|lo|dummy|rmnet|p2p)|vpn|virtual|vbox|vmware|wsl|hyper-v/i.test(name)) continue;
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address)) ok.push({ name, address: a.address });
    }
  }
  const home = n => (/^(wlan|eth|wi-?fi|ethernet|en)/i.test(n) ? 1 : 0);
  return ok.sort((a, b) => home(b.name) - home(a.name)).map(x => x.address);
}

/** Every address on the same /24 as ours (but ours), asked for /hello a few at a time
    (a TV asks through Android six at a time: it looks on the first port only, more quickly). */
async function find({ addresses, fetch: fetchImpl = globalThis.fetch, timeout = 900, at = 48, ports = PORTS }) {
  const own = new Set(addresses);
  const hosts = [];
  for (const net of new Set(addresses.map(a => a.split('.').slice(0, 3).join('.')))) {
    for (let i = 1; i < 255; i++) { const h = `${net}.${i}`; if (!own.has(h)) for (const p of ports) hosts.push(`${h}:${p}`); }
  }
  const found = [];
  let next = 0;
  const one = async address => {
    try {
      const res = await fetchImpl(`http://${address}/hello`, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return;
      const j = JSON.parse(await res.text());
      if (j && j.app === 'seal-iptv-setup') found.push({ address, name: String(j.name || 'Seal IPTV').slice(0, 64) });
    } catch { /* nothing there */ }
  };
  await Promise.all(Array.from({ length: Math.min(at, hosts.length) }, async () => { while (next < hosts.length) await one(hosts[next++]); }));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Seal data with the TV's code and post it: -> the TV's answer */
async function send({ address, code, data, fetch: fetchImpl = globalThis.fetch }) {
  const c = link.normal(code);
  if (c.length !== 10) throw new Error('Type the code shown on the TV (10 letters and numbers).');
  const where = String(address || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[\w.-]+(:\d+)?$/.test(where)) throw new Error('That isn\'t a TV\'s address (it looks like 192.168.1.20:8765).');
  let res;
  try {
    res = await fetchImpl(`http://${where.includes(':') ? where : where + ':8765'}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: link.seal(link.keyFrom(c), data), signal: AbortSignal.timeout(90000) });
  } catch { throw new Error('The TV can\'t be reached. Is "Set up from your phone" open on it, and is it on the same network?'); }
  let r = null;
  try { r = JSON.parse(await res.text()); } catch { /* not an answer */ }
  if (!r) throw new Error('The TV gave no answer.');
  return r;
}

module.exports = { lanAddresses, find, send, PORTS };
