/* =====================================================================
 * Seal IPTV — devtest/fake-xtream.js
 * ---------------------------------------------------------------------
 * A pretend IPTV provider for trying the app without a real account:
 *   node devtest/fake-xtream.js [port]      (default 8790)
 *   Xtream login:  server http://127.0.0.1:8790  user demo  password demo
 *   M3U playlist:  http://127.0.0.1:8790/get.php?username=demo&password=demo&type=m3u_plus
 *                  (or /playlist.m3u for a plain M3U without the login)
 *
 * Made-up channels, movies and series with drawn posters. The streams
 * are public test videos (Big Buck Bunny):
 *   live .m3u8      -> Mux's HLS test stream
 *   live .ts        -> that stream's segments sent one after another
 *   movies          -> .m3u8 (10 minutes) or .mp4 (10 seconds)
 * FAKE_NOART=1: every other series has no cover and every third movie's
 * poster link is broken (for the poster look-up, artwork.js).
 *   episodes        -> .mp4 (10 seconds: good for "next episode")
 * Live channel 7 is "offline" (404) to see the error screen.
 * ===================================================================== */
const http = require('http');
const https = require('https');

const PORT = Number(process.argv[2]) || 8790;
const USER = 'demo', PASS = 'demo';
const HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const HLS_LOW = 'https://test-streams.mux.dev/x36xhzz/url_2/193039199_mp4_h264_aac_ld_7.m3u8';
const MP4 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';

/* ---------- made-up catalogue ---------- */
const LIVE_CATS = ['News', 'Sports', 'Kids', 'Movies 24/7', 'Music', 'Documentary', 'XXX Adult', 'FR | Infos'];
const VOD_CATS = ['Action', 'Comedy', 'Drama', 'Family', 'Sci-Fi', 'ARABIC MOVIES'];
const SERIES_CATS = ['Drama', 'Comedy', 'Sci-Fi', 'Crime'];
const CHANNELS = ['Seal News 24', 'World Report', 'Business Now', 'Weather Live', 'Sport One', 'Sport Two', 'Goal TV', 'Tennis HD', 'Cartoon Bay', 'Little Seals',
  'Cinema Classics', 'Action Max', 'Comedy Central Seal', 'Hits Music', 'Jazz Lounge', 'Nature World', 'History Deep', 'Science Plus', 'Ocean Life', 'Travel Seal'];
const MOVIES = ['The Ice Floe', 'Harbor Lights', 'Midnight Current', 'Arctic Run', 'Deep Blue Line', 'Northern Echo', 'The Last Lighthouse', 'Coastal Drift', 'Tidewater',
  'Silver Fin', 'Frozen Signal', 'Pack Ice', 'The Long Swim', 'Breakwater', 'Salt & Stone', 'Undertow', 'Polar Night', 'Sea Glass', 'Driftwood Hearts', 'Storm Season',
  'Kelp Forest', 'The Seal Keeper', 'Black Rock Bay', 'Iceberg Alley', 'Whale Road'];
const SERIES = ['Harbor Patrol', 'The Colony', 'Fjord', 'Station Zero', 'Fishermen', 'North Star', 'Deep Watch', 'Islanders'];

const pad = n => String(n).padStart(2, '0');
const live = CHANNELS.map((name, i) => ({ num: i + 1, name, stream_type: 'live', stream_id: 1000 + i, stream_icon: `http://127.0.0.1:${PORT}/img/logo/${i}.svg`, epg_channel_id: `ch${i}`, added: '1700000000', category_id: String(1 + (i % LIVE_CATS.length)), tv_archive: 0 }));
// event channels (the Sports / Pay-Per-View pages): the event and its start in the name, made from the time now
const EVENT_CATS = ['Pay Per View Events', 'USA Sports Events'];
const et = (t, o) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', ...o });
const evName = (label, title, t) => `${label}: ${title} (${et(t, { month: '2-digit' })}.${et(t, { day: '2-digit' })} ${et(t, { hour: 'numeric', minute: '2-digit' })} ET)`;
function eventChannels() {
  const now = Date.now(), m = 60000;
  const list = [
    ['Pay Per View 01', 'Seal Fight Night: Main Card', now - 40 * m, 1], ['Pay Per View 02', '', 0, 1], ['Pay Per View 03', 'Harbor Grand Prix', now + 150 * m, 1],
    ['USA NHL 01', 'Seals vs Walruses (Home Feed )', now - 30 * m, 2], ['USA NHL 02', 'Seals vs Walruses (Away Feed )', now - 30 * m, 2],
    ['USA NBA 01', 'Orcas vs Pelicans', now + 90 * m, 2], ['USA Soccer01', 'Premier League: Harbor FC vs Iceberg United', now + 26 * 60 * m, 2]
  ];
  return list.map(([label, title, t, c], i) => ({ num: CHANNELS.length + i + 1, name: title ? evName(label, title, t) : label + ':', stream_type: 'live', stream_id: 1100 + i, stream_icon: '', epg_channel_id: '', added: '1700000000', category_id: String(LIVE_CATS.length + c), tv_archive: 0 }));
}
const NOART = process.env.FAKE_NOART === '1';
const vod = MOVIES.map((name, i) => ({ num: i + 1, name: `${name} (${2005 + (i % 19)})`, stream_type: 'movie', stream_id: 2000 + i, stream_icon: NOART && i % 3 === 0 ? `http://127.0.0.1:${PORT}/gone/m${i}.jpg` : `http://127.0.0.1:${PORT}/img/poster/m${i}.svg`, rating: String(5 + (i % 5)), rating_5based: 2.5 + (i % 5) / 2, added: String(1760000000 + i * 86400), category_id: String(1 + (i % VOD_CATS.length)), container_extension: i % 3 === 0 ? 'mp4' : 'm3u8' }));
const series = SERIES.map((name, i) => ({ num: i + 1, name, series_id: 3000 + i, cover: NOART && i % 2 === 0 ? '' : `http://127.0.0.1:${PORT}/img/poster/s${i}.svg`, plot: `${name} follows a crew of seals keeping the north coast safe.`, cast: 'Sam Seal, Pat Pup', genre: SERIES_CATS[i % SERIES_CATS.length], releaseDate: `${2016 + i}-03-01`, last_modified: String(1760000000 + i * 3600), rating: '8', rating_5based: 4, category_id: String(1 + (i % SERIES_CATS.length)) }));
const cats = list => list.map((n, i) => ({ category_id: String(i + 1), category_name: n, parent_id: 0 }));

function seriesInfo(id) {
  const s = series.find(x => x.series_id === Number(id));
  if (!s) return { info: {}, episodes: {} };
  const seasons = 2 + (s.num % 2), episodes = {};
  for (let n = 1; n <= seasons; n++) {
    episodes[n] = [];
    for (let e = 1; e <= 6; e++) {
      episodes[n].push({ id: String(id * 100 + n * 10 + e), episode_num: e, title: `${s.name} S${pad(n)}E${pad(e)} - Chapter ${e}`, container_extension: 'mp4', season: n, info: { plot: `Episode ${e} of season ${n}. The crew faces a storm.`, duration_secs: 10, movie_image: `http://127.0.0.1:${PORT}/img/still/${id}-${n}-${e}.svg` } });
    }
  }
  return { seasons: Object.keys(episodes).map(n => ({ season_number: Number(n), name: `Season ${n}` })), info: { name: s.name, cover: s.cover, plot: s.plot, cast: s.cast, genre: s.genre, releaseDate: s.releaseDate, rating_5based: s.rating_5based, backdrop_path: [s.cover] }, episodes };
}

function vodInfo(id) {
  const m = vod.find(x => x.stream_id === Number(id)) || vod[0];
  return { info: { name: m.name, movie_image: m.stream_icon, backdrop_path: [m.stream_icon], plot: `${m.name.replace(/ \(\d+\)$/, '')} is a story about a seal who wouldn't give up. A made-up movie on a made-up provider.`, genre: VOD_CATS[(Number(m.category_id) - 1) % VOD_CATS.length], cast: 'Sam Seal, Pat Pup, Robin Walrus', director: 'Jo Orca', releasedate: `${m.name.match(/\((\d+)\)/)[1]}-06-01`, duration_secs: m.container_extension === 'mp4' ? 10 : 596, rating_5based: m.rating_5based }, movie_data: { stream_id: m.stream_id, name: m.name, container_extension: m.container_extension } };
}

function shortEpg(id, limit = 4) {
  const now = Math.floor(Date.now() / 1000);
  const b = s => Buffer.from(s).toString('base64');
  const ch = live.find(x => x.stream_id === Number(id));
  const n = ch ? ch.num : 0;
  // programmes of 30, 60 or 90 minutes (by channel), the first one already on
  const len = 1800 * (1 + (n % 3)), start = now - (now % 1800) - (n % 2) * 1800;
  const shows = ['Morning Edition', 'The Big Story', 'Seal Talk', 'Late Report', 'Coast Watch', 'Harbour Lights', 'Night Desk', 'Tide Tables'];
  return { epg_listings: Array.from({ length: Math.min(Number(limit) || 4, 20) }, (_, i) => shows[(i + n) % shows.length]).map((t, i) => ({ title: b(t), description: b(`${t} on ${ch ? ch.name : 'this channel'}: news and stories from the coast.`), start_timestamp: String(start + i * len), stop_timestamp: String(start + (i + 1) * len) })) };
}

/* ---------- drawn pictures ---------- */
function svg(kind, key) {
  const hue = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  const label = kind === 'logo' ? (CHANNELS[Number(key)] || key) : kind === 'poster' ? (key[0] === 'm' ? MOVIES[Number(key.slice(1))] : SERIES[Number(key.slice(1))]) || key : key;
  const words = String(label).split(' ');
  const lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > 12) { lines.push(line.trim()); line = w; } else line += ' ' + w; }
  lines.push(line.trim());
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (kind === 'logo') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" rx="10" fill="hsl(${hue},55%,42%)"/><text x="80" y="${50 - (lines.length - 1) * 9}" font-family="Segoe UI,Arial" font-weight="700" font-size="17" fill="#fff" text-anchor="middle">${lines.map((l, i) => `<tspan x="80" dy="${i ? 19 : 0}">${l}</tspan>`).join('')}</text></svg>`;
  }
  const w = kind === 'still' ? 320 : 200, hgt = kind === 'still' ? 180 : 300;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hgt}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},55%,16%)"/></linearGradient></defs><rect width="${w}" height="${hgt}" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${hgt * 0.28}" r="${hgt * 0.16}" fill="rgba(255,255,255,.18)"/><path d="M0 ${hgt * 0.72} Q ${w / 2} ${hgt * 0.6} ${w} ${hgt * 0.74} V ${hgt} H 0 Z" fill="rgba(0,0,0,.25)"/>${kind === 'still' ? '' : `<text x="16" y="${hgt - 24 - (lines.length - 1) * 26}" font-family="Segoe UI,Arial" font-weight="700" font-size="24" fill="#fff">${lines.map((l, i) => `<tspan x="16" dy="${i ? 26 : 0}">${l}</tspan>`).join('')}</text>`}</svg>`;
}

/* ---------- live .ts: Mux's segments one after another, at about real time ---------- */
function get(url) {
  return new Promise((resolve, reject) => https.get(url, r => { const b = []; r.on('data', d => b.push(d)); r.on('end', () => resolve(Buffer.concat(b))); }).on('error', reject));
}
async function liveTs(res) {
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' });
  const list = (await get(HLS_LOW)).toString().split('\n').filter(l => l && !l.startsWith('#')).slice(0, 30);
  const base = HLS_LOW.slice(0, HLS_LOW.lastIndexOf('/') + 1);
  let closed = false;
  res.on('close', () => { closed = true; });
  for (let i = 0; i < list.length && !closed; i++) {
    const seg = await get(new URL(list[i], base).href);
    if (closed) break;
    res.write(seg);
    if (i > 1) await new Promise(r => setTimeout(r, 8000));   // first two at once (a buffer), then ~real time
  }
  res.end();
}

/* ---------- FAKE_PROXY=1: everything over this server's plain http ---------- */
const PROXY = process.env.FAKE_PROXY === '1';
async function proxyPlaylist(req, res) {
  const base = HLS_LOW.slice(0, HLS_LOW.lastIndexOf('/') + 1);
  const text = (await get(HLS_LOW)).toString().split('\n')
    .map(l => (l && !l.startsWith('#') ? `http://${req.headers.host}/seg?u=${encodeURIComponent(new URL(l, base).href)}` : l)).join('\n');
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
  res.end(text);
}
function proxyFile(url, req, res) {
  if (!/^https:\/\/(test-streams\.mux\.dev|test-videos\.co\.uk)\//.test(String(url))) { res.writeHead(400); return res.end(); }
  https.get(url, r => { res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', ...(r.headers['content-length'] ? { 'Content-Length': r.headers['content-length'] } : {}) }); r.pipe(res); })
    .on('error', () => { res.writeHead(502); res.end(); });
}

/* ---------- M3U ---------- */
function m3u(host) {
  const out = ['#EXTM3U'];
  const base = `http://${host}`;
  for (const c of live) out.push(`#EXTINF:-1 tvg-id="ch${c.num}" tvg-name="${c.name}" tvg-logo="${c.stream_icon}" group-title="${LIVE_CATS[Number(c.category_id) - 1]}",${c.name}`, `${base}/live/${USER}/${PASS}/${c.stream_id}.m3u8`);
  for (const m of vod) out.push(`#EXTINF:-1 tvg-logo="${m.stream_icon}" group-title="VOD: ${VOD_CATS[Number(m.category_id) - 1]}",${m.name}`, `${base}/movie/${USER}/${PASS}/${m.stream_id}.${m.container_extension}`);
  for (const s of series) {
    const info = seriesInfo(s.series_id);
    for (const [n, eps] of Object.entries(info.episodes)) for (const e of eps) out.push(`#EXTINF:-1 tvg-logo="${s.cover}" group-title="Series: ${s.genre}",${s.name} S${pad(n)}E${pad(e.episode_num)}`, `${base}/series/${USER}/${PASS}/${e.id}.mp4`);
  }
  return out.join('\n') + '\n';
}

/* ---------- server ---------- */
const json = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(u.searchParams);
  console.log(new Date().toISOString().slice(11, 19), req.method, u.pathname + (q.action ? ' ' + q.action : ''), req.headers['user-agent'] || '');
  if (u.pathname === '/player_api.php') {
    if (q.username !== USER || q.password !== PASS) return json(res, { user_info: { auth: 0 } });
    switch (q.action) {
      case undefined: case '':
        return json(res, { user_info: { username: USER, password: PASS, auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400 * 200), is_trial: '0', active_cons: '0', max_connections: '2', allowed_output_formats: ['m3u8', 'ts'] }, server_info: { url: '127.0.0.1', port: String(PORT), server_protocol: 'http', timezone: 'UTC' } });
      case 'get_live_categories': return json(res, cats([...LIVE_CATS, ...EVENT_CATS]));
      case 'get_vod_categories': return json(res, cats(VOD_CATS));
      case 'get_series_categories': return json(res, cats(SERIES_CATS));
      case 'get_live_streams': { const all = [...live, ...eventChannels()]; return json(res, q.category_id ? all.filter(x => x.category_id === q.category_id) : all); }
      case 'get_vod_streams': return json(res, vod);
      case 'get_series': return json(res, series);
      case 'get_series_info': return json(res, seriesInfo(q.series_id));
      case 'get_vod_info': return json(res, vodInfo(q.vod_id));
      case 'get_short_epg': return json(res, shortEpg(q.stream_id, q.limit));
      default: return json(res, []);
    }
  }
  // the full guide (XMLTV): the same programmes as get_short_epg, for every channel
  if (u.pathname === '/xmltv.php') {
    const t = sec => new Date(sec * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const x = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const progs = live.flatMap(c => shortEpg(c.stream_id, 20).epg_listings.map(e => `<programme start="${t(Number(e.start_timestamp))}" stop="${t(Number(e.stop_timestamp))}" channel="${c.epg_channel_id}"><title>${x(Buffer.from(e.title, 'base64').toString())}</title><desc>${x(Buffer.from(e.description, 'base64').toString())}</desc></programme>`));
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end(`<?xml version="1.0"?><tv>${live.map(c => `<channel id="${c.epg_channel_id}"/>`).join('')}${progs.join('')}</tv>`);
  }
  if (u.pathname === '/get.php' || u.pathname === '/playlist.m3u') {
    if (u.pathname === '/get.php' && (q.username !== USER || q.password !== PASS)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    return res.end(m3u(req.headers.host));
  }
  let m = u.pathname.match(/^\/img\/(logo|poster|still)\/([\w-]+)\.svg$/);
  if (m) { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' }); return res.end(svg(m[1], m[2])); }
  m = u.pathname.match(/^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/);
  if (m) {
    if (m[2] !== USER || m[3] !== PASS) { res.writeHead(401); return res.end(); }
    if (m[1] === 'live' && m[4] === '1006') { res.writeHead(404); return res.end(); }
    if (m[1] === 'live' && m[5] === 'ts') return liveTs(res).catch(() => res.end());
    const hls = m[1] === 'live' || (m[1] === 'movie' && m[5] === 'm3u8');
    if (PROXY) return hls ? proxyPlaylist(req, res) : proxyFile(MP4, req, res);
    return redirect(res, hls ? HLS : MP4);
  }
  // FAKE_PROXY=1: segments come through this server too (plain http, like a real provider)
  if (u.pathname === '/seg') return proxyFile(q.u, req, res);
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`Fake Xtream server on http://127.0.0.1:${PORT}  (user ${USER} / password ${PASS})`));
