#!/usr/bin/env node
/* =====================================================================
 * Seal IPTV — tools/studios.js
 * ---------------------------------------------------------------------
 * Builds seal-iptv/src/main/studios.dat: the Disney, Netflix and Prime collections
 * (Collections page), from Wikipedia's lists of each one's films and
 * shows — lists people keep up to date as titles come out.
 *
 *   node tools/studios.js            writes seal-iptv/src/main/studios.dat
 *   node tools/studios.js --check    only prints what it found
 *
 * Each release ships that file; the apps also fetch it from GitHub every few
 * days (seal-iptv/src/main/studios.js), and a GitHub workflow runs this every
 * week (.github/workflows/studios.yml), so new titles arrive between releases. A list that comes
 * out much smaller than the last one (a page renamed, a table changed) is
 * an error: the old file stays.
 *
 * Wikipedia text is CC BY-SA; only titles, years and kinds are taken.
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'seal-iptv', 'src', 'main', 'studios.dat');
const { pack, unpack } = require('../seal-iptv/src/main/studios');   // scrambled: the titles aren't searchable text
const UA = 'SealIPTV-studios/1.0 (https://github.com/jeffbristow/SealIPTV)';

// each collection: its Wikipedia pages (a trailing "(" = every page whose title starts like that)
const STUDIOS = [
  { id: 'disney', name: 'Disney', words: ['disney', 'disney movies', 'walt disney'], kinds: ['movie'],
    pages: [
      { page: 'List of Walt Disney Pictures films', kind: 'movie' },
      { page: 'List of Walt Disney Animation Studios films', kind: 'movie' },
      { page: 'List of Pixar films', kind: 'movie' },
      { page: 'List of Disney+ original films', kind: 'movie' },
      { page: 'List of Disney Channel original films', kind: 'movie' }
    ] },
  { id: 'netflix', name: 'Netflix', words: ['netflix', 'netflix originals', 'netflix original'], kinds: ['movie', 'series'],
    pages: [
      { prefix: 'List of Netflix original films (', kind: 'movie' },
      { page: 'List of Netflix original programming', kind: 'series' },
      { prefix: 'List of ended Netflix original programming (', kind: 'series' }
    ] },
  { id: 'prime', name: 'Prime Video', words: ['prime', 'prime video', 'amazon', 'amazon prime', 'amazon originals'], kinds: ['movie', 'series'],
    pages: [
      { page: 'List of Amazon Prime Video original films', kind: 'movie' },
      { page: 'List of Amazon MGM Studios films', kind: 'movie' },
      { page: 'List of Prime Video original programming', kind: 'series' },
      { page: 'List of ended Amazon Prime Video original programming', kind: 'series' }
    ] }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(params) {
  const url = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&' + new URLSearchParams(params);
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    await sleep(2000 * (i + 1));
  }
  throw new Error('Wikipedia answered with an error for ' + JSON.stringify(params));
}
const pagesStarting = async prefix => (await api({ action: 'query', list: 'prefixsearch', pssearch: prefix, pslimit: 50 })).query.prefixsearch.map(x => x.title).filter(t => t.startsWith(prefix));
const html = async page => { const r = await api({ action: 'parse', page, prop: 'text', redirects: 1 }); if (!r.parse) throw new Error('No page: ' + page); return r.parse.text; };

/* ---- HTML tables -> rows of cell text (rowspan / colspan filled in) ---- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
const text = s => s.replace(/<sup[\s\S]*?<\/sup>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e] || m)).replace(/\s+/g, ' ').trim();
function tables(doc) {
  const out = [];
  // each table with the sections it's in (its heading and the ones above that: "Exclusive international distribution / Feature films")
  const heads = [...doc.matchAll(/<h([2-4])[^>]*>([\s\S]*?)<\/h[2-4]>/gi)].map(m => ({ at: m.index, level: Number(m[1]), text: text(m[2]) }));
  for (const m of doc.matchAll(/<table[^>]*class="[^"]*wikitable[\s\S]*?<\/table>/gi)) {
    const chain = [];
    for (const h of heads.filter(x => x.at < m.index)) { chain.length = Math.min(chain.length, h.level - 2); chain[h.level - 2] = h.text; }
    const section = chain.filter(Boolean).join(' / ');
    const t = m[0];
    const grid = [], pending = [];   // pending[col] = { text, left } from a rowspan above
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const row = [];
      let col = 0;
      const cells = tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
      const fill = () => { while (pending[col] && pending[col].left > 0) { row[col] = pending[col].text; pending[col].left--; col++; } };
      for (const c of cells) {
        fill();
        const open = c.match(/^<t[hd]([^>]*)>/i)[1];
        const rs = Number((open.match(/rowspan="?(\d+)/i) || [])[1] || 1), cs = Number((open.match(/colspan="?(\d+)/i) || [])[1] || 1);
        const v = text(c.replace(/^<t[hd][^>]*>|<\/t[hd]>$/gi, ''));
        for (let k = 0; k < cs; k++) { row[col] = v; if (rs > 1) pending[col] = { text: v, left: rs - 1 }; col++; }
      }
      fill();
      grid.push({ head: /^<tr[^>]*>\s*<th/i.test(tr) && !/<td/i.test(tr), cells: row });
    }
    grid.section = section;
    out.push(grid);
  }
  return out;
}

// sections that aren't the service's own: shown only abroad, bought after release, a show it carried on
const NOT_OWN = /international|exclusive|licen[cs]|regional|acquired|distribution|continuation|co-production|upcoming|in development|stand-up|specials/i;

const YEAR = s => { const m = String(s || '').match(/\b(19[2-9]\d|20[0-4]\d)\b/); return m ? Number(m[1]) : 0; };
const cleanTitle = s => String(s || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/[†‡*§#]+$/g, '').replace(/^["“]|["”]$/g, '').replace(/\s+/g, ' ').trim();

/** One page's titles: the tables with a title column and a date column. */
function titlesOf(doc, kind) {
  const found = [];
  for (const grid of tables(doc)) {
    if (NOT_OWN.test(grid.section)) continue;
    const head = grid.find(r => r.head);
    if (!head) continue;
    const h = head.cells.map(c => (c || '').toLowerCase());
    const ti = h.findIndex(c => /^(title|film|series|program|programme|show)s?\b/.test(c));
    const di = h.findIndex(c => /(release|premiere|air|date|year|debut)/.test(c));
    if (ti < 0 || di < 0) continue;
    for (const r of grid.filter(x => !x.head)) {
      const t = cleanTitle(r.cells[ti]);
      const y = YEAR(r.cells[di]);
      if (!t || t.length > 120 || /^(tba|tbd|untitled)/i.test(t) || !y) continue;
      if (/\((seasons?|series|part|vol\.?)\s*[\d–-]/i.test(t)) continue;   // later seasons of someone else's show
      found.push({ t, y, k: kind });
    }
  }
  return found;
}

async function build() {
  const out = { about: 'Seal IPTV studio collections, from Wikipedia (CC BY-SA): t title, y year, k movie|series. Built by tools/studios.js.', built: new Date().toISOString().slice(0, 10), studios: [] };
  for (const s of STUDIOS) {
    const items = new Map();
    const report = [];
    for (const src of s.pages) {
      const pages = src.prefix ? await pagesStarting(src.prefix) : [src.page];
      for (const p of pages) {
        const got = titlesOf(await html(p), src.kind);
        report.push(`${p}: ${got.length}`);
        for (const e of got) { const k = e.k + '|' + e.t.toLowerCase() + '|' + e.y; if (!items.has(k)) items.set(k, e); }
        await sleep(300);
      }
    }
    const list = [...items.values()].sort((a, b) => a.y - b.y || a.t.localeCompare(b.t));
    out.studios.push({ id: s.id, name: s.name, words: s.words, items: list });
    console.log(`${s.name}: ${list.length} (${list.filter(x => x.k === 'movie').length} movies, ${list.filter(x => x.k === 'series').length} shows)\n  ` + report.join('\n  '));
  }
  return out;
}

async function main() {
  const data = await build();
  if (process.argv.includes('--check')) { for (const s of data.studios) console.log(s.id, s.items.slice(-5).map(x => `${x.t} (${x.y})`).join('; ')); return; }
  let old = null;
  try { old = unpack(fs.readFileSync(OUT, 'utf8')); } catch { /* the first one */ }
  for (const s of data.studios) {
    const before = old && old.studios.find(x => x.id === s.id);
    if (s.items.length < 50 || (before && s.items.length < before.items.length * 0.8)) throw new Error(`${s.name}: ${s.items.length} titles${before ? ', was ' + before.items.length : ''} — a page or table has changed; the old list is kept`);
  }
  // the same titles as last time: the file stays as it is (the weekly run commits only real changes)
  if (old && JSON.stringify(old.studios) === JSON.stringify(data.studios)) { console.log('No changes.'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, pack(data));
  console.log('written', OUT, Math.round(fs.statSync(OUT).size / 1024), 'KB');
}

if (require.main === module) main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
module.exports = { tables, titlesOf, STUDIOS };   // the tests (seal-iptv/test/studios-test.js)
