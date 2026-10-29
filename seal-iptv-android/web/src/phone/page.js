/* =====================================================================
 * Seal IPTV for Fire TV — phone/page.js   (the page the phone opens)
 * ---------------------------------------------------------------------
 * Served by the TV (PhoneServer.java) while it shows the QR code. Fill in
 * the sync server or a playlist, press Send: it's sealed with the code
 * from the QR code (link.js) and posted to the TV, which answers
 * "Connected" or what went wrong. build.js puts this in www/phone.html.
 * ===================================================================== */
const link = require('../../../../seal-iptv/src/main/setuplink');

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FORMS = {
  sync: { tab: 'Sync', note: 'Join the sync vault you made on another device: the TV gets your playlists, favorites and settings. (Seal IPTV on your PC or another TV is in sync? There: Settings → Sync → Connect a TV — no typing at all.)', fields: [
    ['server', 'Sync server address', 'url', 'https://example.com/iptv-sync/'], ['username', 'Username', 'text', ''], ['passphrase', 'Vault passphrase', 'password', ''], ['deviceName', 'This TV\'s name (optional)', 'text', 'Living room TV']] },
  xtream: { tab: 'Xtream login', note: 'The server, username and password from your provider ("Xtream Codes").', fields: [
    ['server', 'Server address', 'url', 'http://provider.example.com:8080'], ['username', 'Username', 'text', ''], ['password', 'Password', 'password', ''], ['name', 'Name (optional)', 'text', 'My IPTV']] },
  m3u: { tab: 'M3U link', note: 'A link to an .m3u / .m3u8 playlist.', fields: [
    ['m3uUrl', 'Playlist link', 'url', 'https://… .m3u'], ['name', 'Name (optional)', 'text', 'My IPTV']] }
};

let kind = 'sync';
const code = link.normal(decodeURIComponent(location.hash.slice(1)));

function draw() {
  const f = FORMS[kind];
  $('#app').innerHTML = `
    <h1><span class="logo">📺</span> Set up Seal IPTV on your TV</h1>
    ${code.length === 10 ? '' : `<label for="code">The code on the TV</label><input id="code" autocomplete="off" autocapitalize="characters" placeholder="K7Q2-M9XA-4F">`}
    <div class="tabs">${Object.entries(FORMS).map(([k, x]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${x.tab}</button>`).join('')}</div>
    <p class="note">${esc(f.note)}</p>
    ${f.fields.map(([k, label, type, ph]) => `<label for="f-${k}">${esc(label)}</label><input id="f-${k}" type="${type}" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="off" spellcheck="false">`).join('')}
    <button id="send" class="send">Send to the TV</button>
    <p id="msg" class="msg"></p>
    <p class="small">What you type is encrypted on this phone with the code from the TV before it's sent. It goes only to your TV, on your home network.</p>`;
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { kind = b.dataset.k; draw(); });
  $('#send').onclick = send;
}

async function send() {
  const msg = $('#msg');
  const c = code.length === 10 ? code : link.normal($('#code').value);
  if (c.length !== 10) { msg.className = 'msg bad'; msg.textContent = 'Type the code shown on the TV (10 letters and numbers).'; return; }
  const data = { kind };
  for (const [k] of FORMS[kind].fields) data[k] = $('#f-' + k).value.trim();
  if (kind === 'sync') data.passphrase = $('#f-passphrase').value;   // as typed
  if (kind === 'xtream') data.password = $('#f-password').value;
  const missing = FORMS[kind].fields.find(([k, label]) => !/optional/.test(label) && !data[k]);
  if (missing) { msg.className = 'msg bad'; msg.textContent = `Fill in "${missing[1]}".`; return; }
  const btn = $('#send');
  btn.disabled = true;
  msg.className = 'msg'; msg.textContent = 'Sending…';
  try {
    await new Promise(r => setTimeout(r, 30));   // (lets "Sending…" show before the key is made)
    const body = link.seal(link.keyFrom(c), data);
    msg.textContent = kind === 'sync' ? 'Connecting the TV to your sync server…' : 'The TV is checking the playlist…';
    const res = await fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const r = await res.json();
    msg.className = r.ok ? 'msg ok' : 'msg bad';
    msg.textContent = r.ok ? '✓ ' + r.text : r.error || 'Something went wrong.';
  } catch (e) {
    msg.className = 'msg bad';
    msg.textContent = 'The TV can\'t be reached. Is this phone on the same Wi-Fi, and is the QR code still on the TV?';
  } finally { btn.disabled = false; }
}

draw();
