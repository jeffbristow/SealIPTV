/* =====================================================================
 * Seal IPTV — xtream.js
 * ---------------------------------------------------------------------
 * Client for the Xtream Codes player API that most IPTV providers offer:
 *   <server>/player_api.php?username=…&password=…&action=…
 * Streams:
 *   live     <server>/live/<user>/<pass>/<id>.<m3u8|ts>
 *   movies   <server>/movie/<user>/<pass>/<id>.<container_extension>
 *   episodes <server>/series/<user>/<pass>/<id>.<container_extension>
 *
 * Sections:
 *   1. Requests
 *   2. Login + lists
 *   3. Details (movie, series, short EPG)
 *   4. Stream addresses
 *   5. Turning the API's answers into the app's catalogue
 * ===================================================================== */

class Xtream {
  /**
   * @param o.server     normalized server ("http://host:port")
   * @param o.fetch      fetch implementation (tests pass a fake)
   * @param o.userAgent  sent with every request
   */
  constructor({ server, username, password, userAgent, fetch: fetchImpl, timeout = 30000 }) {
    this.server = String(server).replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.userAgent = userAgent || 'SealIPTV';
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeout = timeout;
  }

  /* =================================================================
   * 1. REQUESTS
   * ================================================================= */
  async api(params = {}, timeout = this.timeout) {
    const q = new URLSearchParams({ username: this.username, password: this.password, ...params });
    const url = `${this.server}/player_api.php?${q}`;
    let res;
    try {
      res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new Error(`Can't reach ${new URL(this.server).host} (${e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('The provider refused the login (wrong username or password, or the account is blocked).');
    if (!res.ok) throw new Error(`The provider answered HTTP ${res.status}.`);
    const text = await res.text();
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch {
      throw new Error('The server didn\'t answer like an Xtream Codes server. Check the address.');
    }
  }

  /* =================================================================
   * 2. LOGIN + LISTS
   * ================================================================= */
  /** -> { user, server } ; throws when the login is refused. */
  async login() {
    const j = await this.api({}, 15000);
    const u = j && j.user_info;
    if (!u || Number(u.auth) === 0) throw new Error('Wrong username or password.');
    const status = String(u.status || 'Active');
    if (!/^active$/i.test(status)) throw new Error(`The provider says this account is ${status.toLowerCase()}.`);
    return {
      user: {
        status,
        expires: u.exp_date ? Number(u.exp_date) * 1000 : null,
        maxConnections: Number(u.max_connections) || null,
        activeConnections: Number(u.active_cons) || 0,
        formats: Array.isArray(u.allowed_output_formats) ? u.allowed_output_formats.map(String) : []
      },
      server: j.server_info || {}
    };
  }

  static ACTIONS = {
    live: ['get_live_categories', 'get_live_streams'],
    movies: ['get_vod_categories', 'get_vod_streams'],
    series: ['get_series_categories', 'get_series']
  };

  async categories(section) { return arr(await this.api({ action: Xtream.ACTIONS[section][0] })); }
  async streams(section) { return arr(await this.api({ action: Xtream.ACTIONS[section][1] }, 120000)); }

  /* =================================================================
   * 3. DETAILS
   * ================================================================= */
  async movieInfo(id) {
    const j = await this.api({ action: 'get_vod_info', vod_id: id });
    return Xtream.normMovieInfo(j || {});
  }

  async seriesInfo(id) {
    const j = await this.api({ action: 'get_series_info', series_id: id });
    return Xtream.normSeriesInfo(j || {});
  }

  /** Now / next for a live channel: [{ title, desc, start, end }] (ms). */
  async shortEpg(id, limit = 4) {
    const j = await this.api({ action: 'get_short_epg', stream_id: id, limit }, 10000);
    return arr(j && j.epg_listings).map(e => ({
      title: b64(e.title),
      desc: b64(e.description),
      start: Number(e.start_timestamp) * 1000 || Date.parse(e.start) || 0,
      end: Number(e.stop_timestamp) * 1000 || Date.parse(e.end) || 0
    })).filter(e => e.title);
  }

  /* =================================================================
   * 4. STREAM ADDRESSES
   * ================================================================= */
  _path(kind, id, ext) {
    return `${this.server}/${kind}/${encodeURIComponent(this.username)}/${encodeURIComponent(this.password)}/${encodeURIComponent(id)}.${ext}`;
  }
  liveUrl(id, format = 'm3u8') { return this._path('live', id, format === 'ts' ? 'ts' : 'm3u8'); }
  movieUrl(id, ext) { return this._path('movie', id, cleanExt(ext)); }
  episodeUrl(id, ext) { return this._path('series', id, cleanExt(ext)); }

  /** "http://host/get.php?username=a&password=b&type=m3u_plus" -> login, or null. */
  static fromM3uUrl(link) {
    let u;
    try { u = new URL(String(link).trim()); } catch { return null; }
    const user = u.searchParams.get('username'), pass = u.searchParams.get('password');
    if (!/\/get\.php$/i.test(u.pathname) || !user || !pass) return null;
    return { server: u.protocol + '//' + u.host + u.pathname.replace(/\/get\.php$/i, ''), username: user, password: pass };
  }

  /* =================================================================
   * 5. API ANSWERS -> CATALOGUE
   * ================================================================= */
  static normCategories(list) {
    return arr(list).map(c => ({ id: String(c.category_id), name: String(c.category_name || 'Other').trim() })).filter(c => c.id);
  }

  static normItem(section, s) {
    const cat = String(s.category_id != null ? s.category_id : (Array.isArray(s.category_ids) && s.category_ids[0]) || '');
    const name = String(s.name || s.title || '').trim();
    if (section === 'live') {
      return { id: String(s.stream_id), name, logo: s.stream_icon || '', cat, num: Number(s.num) || 0, epg: s.epg_channel_id || '', archive: !!Number(s.tv_archive) };
    }
    if (section === 'movies') {
      return { id: String(s.stream_id), name, poster: s.stream_icon || '', cat, rating: rating(s.rating_5based, s.rating), year: yearOf(s.year || s.releaseDate, name), added: Number(s.added) || 0, ext: s.container_extension || 'mp4' };
    }
    return { id: String(s.series_id), name, poster: s.cover || '', cat, rating: rating(s.rating_5based, s.rating), year: yearOf(s.releaseDate || s.release_date || s.year, name), added: Number(s.last_modified) || 0, plot: s.plot || '' };
  }

  static normMovieInfo(j) {
    const i = j.info || {}, m = j.movie_data || {};
    return {
      name: m.name || i.name || '',
      poster: i.movie_image || i.cover_big || '',
      backdrop: arr(i.backdrop_path)[0] || '',
      plot: i.plot || i.description || '',
      genre: i.genre || '',
      cast: i.cast || i.actors || '',
      director: i.director || '',
      year: yearOf(i.releasedate || i.release_date, ''),
      duration: Number(i.duration_secs) || 0,
      rating: rating(i.rating_5based, i.rating),
      trailer: i.youtube_trailer || '',
      ext: m.container_extension || ''
    };
  }

  static normSeriesInfo(j) {
    const i = j.info || {};
    const eps = j.episodes || {};
    const seasonNames = new Map(arr(j.seasons).map(s => [Number(s.season_number), s.name]));
    const groups = Array.isArray(eps) ? { 1: eps } : eps;
    const seasons = Object.keys(groups).map(Number).filter(Number.isFinite).sort((a, b) => a - b).map(num => ({
      num,
      name: seasonNames.get(num) || `Season ${num}`,
      episodes: arr(groups[num]).map(e => ({
        id: String(e.id),
        num: Number(e.episode_num) || 0,
        season: num,
        title: String(e.title || '').trim(),
        plot: (e.info && e.info.plot) || '',
        image: (e.info && (e.info.movie_image || e.info.cover_big)) || '',
        duration: Number(e.info && e.info.duration_secs) || 0,
        ext: e.container_extension || 'mp4'
      })).sort((a, b) => a.num - b.num)
    }));
    return {
      name: i.name || '',
      poster: i.cover || '',
      backdrop: arr(i.backdrop_path)[0] || '',
      plot: i.plot || '',
      genre: i.genre || '',
      cast: i.cast || '',
      year: yearOf(i.releaseDate || i.release_date, ''),
      rating: rating(i.rating_5based, i.rating),
      seasons
    };
  }
}

const arr = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const cleanExt = e => (/^[a-z0-9]{2,5}$/i.test(String(e || '')) ? String(e) : 'mp4');
function b64(s) {
  if (!s) return '';
  try {
    const t = Buffer.from(String(s), 'base64').toString('utf8');
    return /�/.test(t) ? String(s) : t;
  } catch { return String(s); }
}
function rating(five, ten) {
  const f = Number(five);
  if (f > 0) return Math.round(f * 20) / 10;              // 0–10
  const t = Number(ten);
  return t > 0 ? Math.round((t > 10 ? t / 10 : t) * 10) / 10 : 0;
}
function yearOf(date, name) {
  const m = String(date || '').match(/(19|20)\d{2}/) || String(name || '').match(/\((19|20)\d{2}\)/);
  return m ? Number(m[0].replace(/\D/g, '')) : 0;
}

module.exports = { Xtream, b64, rating, yearOf };
