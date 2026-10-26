/* =====================================================================
 * Seal IPTV — m3u.js
 * ---------------------------------------------------------------------
 * Reads M3U / M3U8 playlists:
 *   #EXTM3U
 *   #EXTINF:-1 tvg-id="…" tvg-logo="…" group-title="News",CNN
 *   http://…/stream.m3u8
 * and sorts each entry into Live TV, Movies or Series:
 *   - the address says so (/movie/…, /series/… as Xtream panels write it)
 *   - otherwise the group name (VOD, Movies, Films / Series, Shows)
 *   - otherwise the name looks like an episode (S01E02, 1x02)
 * Episodes are grouped into shows by name ("Show S01E02" -> "Show").
 *
 * Sections:
 *   1. Parsing
 *   2. Sorting into sections
 *   3. Building the catalogue
 * ===================================================================== */
const crypto = require('crypto');

const idOf = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

/* =================================================================
 * 1. PARSING
 * ================================================================= */
/** "-1 tvg-id="x" group-title="A, B",Name" -> { attrs, title } (commas inside quotes are kept). */
function splitExtinf(rest) {
  let inQ = false, cut = -1;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { cut = i; break; }
  }
  const head = cut >= 0 ? rest.slice(0, cut) : rest;
  const title = cut >= 0 ? rest.slice(cut + 1).trim() : '';
  const attrs = {};
  for (const m of head.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
  return { attrs, title };
}

/** -> [{ name, url, logo, group, tvgId, userAgent }] */
function parseM3U(text) {
  const out = [];
  let cur = null, group = '';
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const { attrs, title } = splitExtinf(line.slice(8));
      cur = {
        name: title || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || attrs.logo || '',
        group: attrs['group-title'] || '',
        tvgId: attrs['tvg-id'] || '',
        userAgent: attrs['user-agent'] || ''
      };
      group = '';
    } else if (line.startsWith('#EXTGRP:')) {
      group = line.slice(8).trim();
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const m = line.match(/^#EXTVLCOPT:http-user-agent=(.+)$/i);
      if (m && cur) cur.userAgent = m[1].trim();
    } else if (!line.startsWith('#')) {
      if (!/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(line)) { cur = null; continue; }
      const e = cur || { name: '', logo: '', group: '', tvgId: '', userAgent: '' };
      if (!e.group && group) e.group = group;
      e.url = line;
      if (!e.name) e.name = decodeURIComponent(line.split('/').pop().replace(/\.\w+$/, '')) || 'Untitled';
      out.push(e);
      cur = null;
      group = '';
    }
  }
  return out;
}

/* =================================================================
 * 2. SORTING INTO SECTIONS
 * ================================================================= */
const EPISODE_RE = /^(.*?)[\s._-]*(?:S(\d{1,2})[\s._-]*E(\d{1,3})|(\d{1,2})x(\d{2,3}))\b/i;

/** -> { show, season, episode } or null */
function episodeOf(name) {
  const m = String(name).match(EPISODE_RE);
  if (!m) return null;
  const show = m[1].replace(/[\s._-]+$/, '').replace(/[._]/g, ' ').trim();
  return { show: show || name, season: Number(m[2] || m[4]), episode: Number(m[3] || m[5]) };
}

/** 'live' | 'movies' | 'series' */
function sectionOf(e) {
  const path = (() => { try { return new URL(e.url).pathname; } catch { return ''; } })();
  if (/\/series\//i.test(path)) return 'series';
  if (/\/movies?\//i.test(path)) return 'movies';
  const g = e.group.toLowerCase();
  if (/\b(series|tv shows?|shows|serien|séries)\b/.test(g)) return 'series';
  if (/\b(vod|movies?|films?|cinema|peliculas|filme)\b/.test(g)) return 'movies';
  if (/\.(mp4|mkv|avi|mov|wmv)(\?|$)/i.test(path)) return episodeOf(e.name) ? 'series' : 'movies';
  if (episodeOf(e.name) && !/\.(m3u8|ts)$/i.test(path)) return 'series';
  return 'live';
}

/* =================================================================
 * 3. THE CATALOGUE
 *    { live, movies, series: { cats: [{id,name}], items: [...] } }
 *    Each item keeps its url (M3U streams have no other address);
 *    series items carry their episodes.
 * ================================================================= */
function buildCatalog(entries) {
  const sections = { live: new Map(), movies: new Map(), series: new Map() };
  const items = { live: [], movies: [], series: [] };
  const shows = new Map();
  const catId = (section, name) => {
    const m = sections[section];
    const n = name || 'Other';
    if (!m.has(n)) m.set(n, { id: idOf(section + '|' + n), name: n });
    return m.get(n).id;
  };
  let num = 0;
  for (const e of entries) {
    const section = sectionOf(e);
    if (section === 'live') {
      items.live.push({ id: idOf(e.url), name: e.name, logo: e.logo, cat: catId('live', e.group), num: ++num, epg: e.tvgId, url: e.url, ua: e.userAgent || undefined });
    } else if (section === 'movies') {
      const y = String(e.name).match(/\((19|20)\d{2}\)/);
      items.movies.push({ id: idOf(e.url), name: e.name, poster: e.logo, cat: catId('movies', e.group), rating: 0, year: y ? Number(y[0].slice(1, 5)) : 0, added: 0, ext: (e.url.match(/\.(\w{2,4})(\?|$)/) || [])[1] || '', url: e.url, ua: e.userAgent || undefined });
    } else {
      const ep = episodeOf(e.name) || { show: e.name, season: 1, episode: 0 };
      const cat = catId('series', e.group);
      const sid = idOf('series|' + cat + '|' + ep.show.toLowerCase());
      let show = shows.get(sid);
      if (!show) {
        show = { id: sid, name: ep.show, poster: e.logo, cat, rating: 0, year: 0, added: 0, plot: '', episodes: [] };
        shows.set(sid, show);
        items.series.push(show);
      }
      if (!show.poster && e.logo) show.poster = e.logo;
      show.episodes.push({ id: idOf(e.url), season: ep.season, num: ep.episode || show.episodes.length + 1, title: e.name, image: e.logo, url: e.url, ua: e.userAgent || undefined });
    }
  }
  const out = {};
  for (const s of Object.keys(items)) out[s] = { cats: [...sections[s].values()], items: items[s] };
  return out;
}

/** Series details from an M3U show (same shape as Xtream's). */
function seriesInfoFromShow(show) {
  const bySeason = new Map();
  for (const e of show.episodes || []) {
    if (!bySeason.has(e.season)) bySeason.set(e.season, []);
    bySeason.get(e.season).push({ id: e.id, num: e.num, season: e.season, title: e.title, plot: '', image: e.image || '', duration: 0, ext: '' });
  }
  return {
    name: show.name, poster: show.poster, backdrop: '', plot: '', genre: '', cast: '', year: 0, rating: 0,
    seasons: [...bySeason.keys()].sort((a, b) => a - b).map(num => ({ num, name: `Season ${num}`, episodes: bySeason.get(num).sort((a, b) => a.num - b.num) }))
  };
}

module.exports = { parseM3U, splitExtinf, episodeOf, sectionOf, buildCatalog, seriesInfoFromShow, idOf };
