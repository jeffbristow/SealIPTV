/* =====================================================================
 * Seal IPTV — events.js
 * ---------------------------------------------------------------------
 * The Sports and Pay-Per-View pages: the games and events on now and
 * later, found in the live channels (catalog.js events()).
 *
 * Two kinds of channel:
 *   - event channels: the provider writes the event and its start into the
 *     name, and changes it during the day —
 *       "Pay Per View 04: UFC BJJ 13 (10.29 8:00 PM ET)"
 *       "USA Soccer01: Italy - Serie A: Frosinone vs Lecce @ 01:30 PM EDT"
 *       "USA ESPN+ 017: Fireballs vs. Devils Oct 29 3:00PM ET (2026-10-29 15:00:00)"
 *       "Flo Sports 02: flograppling: 2026 IBJJF European NoGi (Mat 2) @ 28 Oct 03:30 AM ET"
 *       "USA NHL 02: UTA VS PIT (TVAS Feed ) @ 7:00 pm"       "Pay Per View 05:"  (nothing on)
 *     They have no guide: an event lasts the usual time for its sport.
 *   - sports channels (ESPN, Sky Sports …): what the guide says is on, when it
 *     looks like a game ("vs", "Live") and not a show about one.
 * The same event on several channels (feeds, SD / HD) is one event with
 * its channels to pick from.
 *
 * Sections:
 *   1. Times in a channel's name (time zones)
 *   2. Reading an event channel's name
 *   3. Sports
 *   4. Which channels
 *   5. The events (build)
 * ===================================================================== */

/* =================================================================
 * 1. TIMES — "8:00 PM ET" is New York time (summer or winter); a name
 *    with no zone is in the provider's zone (its server_info), else ET
 * ================================================================= */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FIXED = { EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8, GMT: 0, UTC: 0, BST: 1, CEST: 2, AEST: 10, AEDT: 11 };
const ZONES = { ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', PT: 'America/Los_Angeles', UK: 'Europe/London', CET: 'Europe/Paris' };
const TZ = '(ET|EDT|EST|CT|CDT|CST|MT|MDT|MST|PT|PDT|PST|GMT|UTC|BST|CET|CEST|UK|AEST|AEDT)';
const DEFAULT_ZONE = 'America/New_York';
const HOUR = 3600000;

const fmts = new Map();
/** minutes a zone is ahead of UTC at time t (null: a zone this device doesn't know) */
function offsetMin(zone, t) {
  let f = fmts.get(zone);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); }
    catch { f = null; }
    fmts.set(zone, f);
  }
  if (!f) return null;
  const p = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((wall - Math.floor(t / 60000) * 60000) / 60000);
}

/** a zone: a name (America/New_York) or hours ahead of UTC (-4) */
const zoneOf = (abbr, fallback) => (abbr && FIXED[abbr.toUpperCase()] != null ? FIXED[abbr.toUpperCase()] : abbr && ZONES[abbr.toUpperCase()]) || fallback;
const offOf = (zone, t) => (typeof zone === 'number' ? zone * 60 : offsetMin(zone, t) ?? offsetMin(DEFAULT_ZONE, t));

/** a wall-clock time in a zone -> ms */
function wallToUtc(y, mo, d, h, mi, zone) {
  const g = Date.UTC(y, mo, d, h, mi);
  let t = g - offOf(zone, g) * 60000;
  const again = g - offOf(zone, t) * 60000;   // the hours around a summer-time change
  if (again !== t) t = again;
  return t;
}

/** today's date in a zone: [y, month 0-11, day] */
function dateIn(zone, now) {
  const w = new Date(now + offOf(zone, now) * 60000);
  return [w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()];
}

const hour24 = (h, ap) => { h = Number(h); if (!ap) return h; ap = ap.toLowerCase(); return ap === 'pm' ? (h % 12) + 12 : h % 12; };

/* the forms seen in channel names, most exact first */
const TIME_FORMS = [
  // (2026-10-29 15:00:00)
  { re: /\(?\b(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\)?/, get: m => ({ y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5] }) },
  // (10.29 8:00 PM ET)
  { re: new RegExp(`\\(?\\b(\\d{1,2})\\.(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\s*${TZ}?\\b\\)?`, 'i'), get: m => ({ mo: +m[1] - 1, d: +m[2], h: hour24(m[3], m[5]), mi: +m[4], z: m[6] }) },
  // @ 28 Oct 03:30 AM ET
  { re: new RegExp(`@?\\s*\\b(\\d{1,2})\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\s*${TZ}?\\b`, 'i'), get: m => ({ mo: MONTHS.indexOf(m[2].toLowerCase()), d: +m[1], h: hour24(m[3], m[5]), mi: +m[4], z: m[6] }) },
  // Oct 29 3:00PM ET
  { re: new RegExp(`@?\\s*\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\s*${TZ}?\\b`, 'i'), get: m => ({ mo: MONTHS.indexOf(m[1].toLowerCase()), d: +m[2], h: hour24(m[3], m[5]), mi: +m[4], z: m[6] }) },
  // @ 01:30 PM EDT · @ 7:00 pm · @ 20:00   (today)
  { re: new RegExp(`@\\s*(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\s*${TZ}?\\b`, 'i'), get: m => ({ h: hour24(m[1], m[3]), mi: +m[2], z: m[4] }) }
];

/**
 * The start time in a piece of text -> { start (ms), text (what's left) } or null.
 * zone: the provider's zone for times without one. A date without a year is the nearest one;
 * a time without a date, the nearest day (an evening game seen just after midnight is yesterday's).
 */
function findTime(text, { now = Date.now(), zone = DEFAULT_ZONE } = {}) {
  let start = null, rest = text;
  for (const f of TIME_FORMS) {
    const m = f.re.exec(text);
    if (!m) continue;
    const t = f.get(m);
    if (t.mo < 0 || t.h > 23 || t.mi > 59) continue;
    const z = zoneOf(t.z, zone);
    if (t.d == null) {
      const [y, mo, d] = dateIn(z, now);
      start = wallToUtc(y, mo, d, t.h, t.mi, z);
      if (start < now - 12 * HOUR) start += 24 * HOUR;
      else if (start > now + 12 * HOUR) start -= 24 * HOUR;
    } else if (t.y) start = wallToUtc(t.y, t.mo, t.d, t.h, t.mi, z);
    else {
      const y = dateIn(z, now)[0];
      start = [y - 1, y, y + 1].map(yy => wallToUtc(yy, t.mo, t.d, t.h, t.mi, z)).sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
    }
    rest = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    break;
  }
  if (start == null) return null;
  // another copy of the time (ESPN+ writes it twice): gone too
  for (const f of TIME_FORMS) rest = rest.replace(f.re, ' ');
  return { start, text: rest };
}

/* =================================================================
 * 2. AN EVENT CHANNEL'S NAME
 *    "<the channel>: [<league>: ]<the event> [(<feed> Feed)] <when>"
 * ================================================================= */
const tidy = s => String(s).replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/^[\s@:|–—-]+|[\s@:|,–—-]+$/g, '').trim();
const norm = s => String(s).toLowerCase().replace(/\blive\b|[^a-z0-9]+/g, ' ').replace(/\b(vs|v)\b/g, 'vs').replace(/\s+/g, ' ').trim();

/** "flograppling" -> "Grappling" */
const leagueName = s => { const m = /^flo([a-z]+)$/i.exec(s); return m ? m[1][0].toUpperCase() + m[1].slice(1) : s; };

/**
 * -> null (not an event channel's name), { empty: true } (an event slot with nothing on) or
 *    { title, league, feed, start, label }  (label: the channel part, "Pay Per View 04")
 */
function parseName(name, opts = {}) {
  const s = String(name || '');
  const m = /^(.{1,48}?)\s*:(?:\s+|$)(.*)$/.exec(s);
  if (!m) return null;
  const label = m[1].trim();
  let rest = m[2].trim();
  if (!rest) return /\d\s*$/.test(label) ? { empty: true, label } : null;
  const t = findTime(rest, opts);
  if (!t) return null;
  rest = t.text;
  let feed = '';
  rest = rest.replace(/\(([^()]*?\bfeed)\s*\)/i, (_, f) => { feed = tidy(f); return ' '; });
  rest = tidy(rest);
  if (!rest) return { empty: true, label };
  rest = tidy(rest.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[_.,]?\s*\d{1,2}\/\d{1,2}\s*[_|-]?\s*/i, ''));   // "Thu_ 10/29 _ …"
  let league = '';
  const lm = /^([^:]{2,40}):\s+(.+)$/.exec(rest);
  if (lm) { league = leagueName(tidy(lm[1])); rest = tidy(lm[2]); }
  // "UFC 310: Main Card": the part alone says too little
  if (league && /^(main card|prelims|early prelims|main event|undercard|weigh-?ins?|preshow|pre-?show)$/i.test(rest)) { rest = `${league}: ${rest}`; league = ''; }
  return { title: dropEcho(rest), league, feed, start: t.start, label };
}

/** "Austria Wien vs. Juventus (ESP) (Austria Wien vs. Juventus (ESP))": once is enough */
function dropEcho(s) {
  if (!s.endsWith(')')) return s;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(' && --depth === 0) return i && norm(s.slice(i + 1, -1)) === norm(s.slice(0, i)) ? s.slice(0, i).trim() : s;
  }
  return s;
}

/** an event channel's name that is a game or an event (not a talk show listed like one) */
const GAME = /\s(vs?\.?|@|at)\s|\b(race|grand prix|gp|ufc|fight|fights|bout|card|tournament|championships?|cup|open|classic|invitational|qualifying|practice|stage|round|rd\.|game|match|series|bowl|mat \d|day \d|session|heats?|finals?|semi-?finals?|playoffs?|derby|tour|rally|meet|regatta|marathon|grappling|nogi|bjj|jiu|boxing|wrestling|wwe|aew)\b/i;
const TALK = /\b(show|talk|total access|good morning|podcast|tonight|insider|countdown|daily|weekly|recap|highlights|magazine|in 60|press conference|studio|hour|radio)\b/i;
const isGame = (title, league) => !TALK.test(title) && GAME.test(`${league} ${title}`);

/* =================================================================
 * 3. SPORTS — by words in the event, its league, the channel and its category;
 *    hours: how long one usually lasts (event channels have no guide)
 * ================================================================= */
const SPORTS = [
  // a league's name first ("Racing Santander (Copa del Rey)" is soccer)
  { id: 'soccer', name: 'Soccer', icon: '⚽', hours: 2.25, re: /\b(soccer|futbol|fútbol|serie a|la ?liga|bundesliga|premier league|epl|ligue 1|mls|nwsl|uefa|champions league|europa league|conference league|fa cup|league cup|carabao|ta[çc]a|copa|eredivisie|fifa|world cup|concacaf)\b/i },
  { id: 'football', name: 'Football', icon: '🏈', hours: 3.5, re: /\b(nfl|ncaaf|college football|red ?zone|sunday ticket|super bowl|cfl|xfl|ufl|thursday night football)\b/i },
  { id: 'basketball', name: 'Basketball', icon: '🏀', hours: 2.5, re: /\b(nba|wnba|ncaab|basketball|euroleague|g league)\b/i },
  { id: 'hockey', name: 'Hockey', icon: '🏒', hours: 3, re: /\b(nhl|hockey|ahl|khl|ohl|whl)\b/i },
  { id: 'baseball', name: 'Baseball', icon: '⚾', hours: 3.5, re: /\b(mlb|baseball|world series|npb|kbo)\b/i },
  { teams: true },   // both sides of "X vs Y" a team of one league ("Columbus Blue Jackets vs. Carolina Hurricanes" on an ESPN+ channel)
  { id: 'motor', name: 'Motorsport', icon: '🏁', hours: 3.5, re: /\b(f1|formula ?[1e]|nascar|indycar|motogp|racing|raceway|speedway|dirt track|thunderbowl|rally|supercross|motocross|grand prix|sprint cars?|drag)\b/i },
  { id: 'fight', name: 'Fighting', icon: '🥊', hours: 4, re: /\b(ufc|mma|boxing|bjj|jiu.?jitsu|grappling|nogi|ibjjf|wrestling|wwe|aew|tna|pfl|bellator|fight|fighting|kickboxing|iwr|bkfc|one championship|monsters ball)\b/i },
  { id: 'golf', name: 'Golf', icon: '⛳', hours: 6, re: /\b(golf|pga|lpga|liv golf|the open|ryder cup|masters)\b/i },
  { id: 'tennis', name: 'Tennis', icon: '🎾', hours: 3, re: /\b(tennis|atp|wta|wimbledon|roland garros|australian open)\b/i },
  { id: 'cricket', name: 'Cricket', icon: '🏏', hours: 8, re: /\b(cricket|ipl|t20|odi|big bash)\b/i },
  { id: 'rugby', name: 'Rugby', icon: '🏉', hours: 2, re: /\b(rugby|nrl|six nations)\b/i },
  { id: 'cycling', name: 'Cycling', icon: '🚴', hours: 5, re: /\b(tour de france|giro|vuelta|cycling)\b/i },
  { id: 'lacrosse', name: 'Lacrosse', icon: '🥍', hours: 2.5, re: /\b(lacrosse|pll|nll)\b/i },
  // club words last
  { id: 'soccer', name: 'Soccer', icon: '⚽', hours: 2.25, re: /\b(fc|afc|cf|united|liga|sporting|atletico|atlético|juventus|ac milan|inter milan)\b/i }
];
const teams = s => new RegExp(`\\b(${s.split(',').join('|')})\\b`, 'i');
const TEAMS = [
  ['hockey', teams('blue jackets,hurricanes,penguins,mammoth,lightning,bruins,canadiens,canucks,sharks,maple leafs,senators,sabres,red wings,panthers,capitals,flyers,islanders,rangers,devils,blackhawks,avalanche,wild,predators,blues,flames,oilers,kraken,golden knights,ducks,kings,stars,jets')],
  ['basketball', teams('celtics,nets,knicks,76ers,sixers,raptors,bulls,cavaliers,pistons,pacers,bucks,hawks,hornets,heat,magic,wizards,nuggets,timberwolves,thunder,trail blazers,blazers,warriors,clippers,lakers,suns,mavericks,rockets,grizzlies,pelicans,spurs,kings,jazz,valkyries,dream,aces,liberty,sparks,mercury,lynx,storm,fever,sky,wings,mystics,sun,tempo,fire')],
  ['football', teams('bills,dolphins,patriots,jets,ravens,bengals,browns,steelers,texans,colts,jaguars,titans,broncos,chiefs,raiders,chargers,cowboys,giants,eagles,commanders,bears,lions,packers,vikings,falcons,panthers,saints,buccaneers,49ers,cardinals,rams,seahawks')],
  ['baseball', teams('yankees,red sox,orioles,blue jays,rays,guardians,twins,white sox,tigers,royals,astros,mariners,athletics,angels,rangers,braves,phillies,mets,marlins,nationals,cubs,brewers,reds,pirates,cardinals,dodgers,giants,padres,diamondbacks,rockies')]
];
const OTHER = { id: 'other', name: 'More sports', icon: '🏟️', hours: 3 };
const US_CONTEXT = /^(usa?|ca)\b|\b(espn|ncaa|college|fox|cbs|nbc|abc)\b/i;

/** the sport of an event: { id, name, icon, hours } — title first (its two teams), then the league, channel, category */
function sportOf(title, ...texts) {
  const t = [title, ...texts].filter(Boolean).join(' · ');
  const sides = String(title || '').split(/\s(?:vs?\.?|@|at)\s/i);
  for (const s of SPORTS) {
    if (s.teams) {
      const hit = sides.length === 2 && TEAMS.find(([, re]) => re.test(sides[0]) && re.test(sides[1]));
      if (hit) return SPORTS.find(x => x.id === hit[0]);
    } else if (s.re.test(t)) return s;
  }
  // "Football:" on a US channel is American football; elsewhere it's soccer
  if (/\bfootball\b/i.test(t)) return US_CONTEXT.test(t) ? SPORTS.find(s => s.id === 'football') : SPORTS.find(s => s.id === 'soccer');
  return OTHER;
}

/* =================================================================
 * 4. WHICH CHANNELS
 * ================================================================= */
const SPORT_CAT = /sport|ppv|pay.?per|event|match|nfl|nba|nhl|mlb|mls|ncaa|ufc|wwe|aew|boxing|fight|soccer|football|f[uú]tbol|epl|premier league|liga|golf|tennis|cricket|rugby|racing|motor|dazn|espn|bein|tsn|sportsnet|flo|peacock|lacrosse|olympic/i;
const SPORT_CHANNEL = /\b(espn\w*|fox sports|fs[12]|nbc ?sports|cbs sports|bein|sky sports?|tsn\d*|sportsnet|dazn|nfl|nba|nhl|mlb|golf|tennis|ufc|wwe|eurosport|supersport|bt sport|tnt sports|premier sports|arena sport|setanta|match ?cent(er|re)|flo ?sports|sec network|acc network|big ten|redzone|willow|fight network|boxing|racing)\b/i;
const NOT_LIVE = /(^|[^a-z])(24\/7|replays?|classics?|highlights|rewind|vod)([^a-z]|$)/i;
const PPV = /(^|[^a-z])(ppv|pay[\s-]?per[\s-]?view)([^a-z]|$)/i;

/** a channel for the Sports page (category or name) */
const isSports = (name, cat) => !NOT_LIVE.test(cat || '') && !NOT_LIVE.test(name || '') && (SPORT_CAT.test(cat || '') || SPORT_CHANNEL.test(name || ''));
/** a channel for the Pay-Per-View page */
const isPpv = (name, cat) => !NOT_LIVE.test(cat || '') && (PPV.test(cat || '') || PPV.test(name || ''));

/** a guide programme that's a game or event, not a show about them */
const SHOW = /\b(highlights|classic|encore|rewind|recap|preview|press conference|magazine|review|countdown|pre-?game|post-?game|pre-?match|post-?match|replay|analysis|talk|tonight|daily|weekly|news|kickoff show|studio|the [a-z]+ show)\b/i;
const looksLive = (title, desc = '') => !SHOW.test(title) && (/\blive\b|\ben (vivo|directo)\b|\bdirect\b/i.test(title) || /\s(vs?\.?|@)\s/i.test(title) || /^live\b/i.test(desc));

/** a region from the category / channel: "UK: Sport" -> UK, "USA NHL" -> US, "FR: France Sports" -> FR */
function regionOf(cat, name) {
  for (const s of [cat, name]) {
    const m = /^\s*(?:\|)?([A-Z]{2,3})\s*(?:[:|]|\s-\s|\s)/.exec(String(s || ''));
    if (m && !/^(PPV|NFL|NBA|NHL|MLB|MLS|EPL|UFC|WWE|AEW|ESPN|HD|SD|UHD|FHD|VIP|TV|NBC|CBS|ABC|FOX|DAZN|TSN|BBC|ITV|USA)$/.test(m[1])) return m[1];
    if (/^\s*(usa?)\b/i.test(String(s || ''))) return 'US';
  }
  return '';
}

/* =================================================================
 * 5. THE EVENTS
 * ================================================================= */
/** how alike two events' names are, 0–1 (letter pairs in common; years and numbers left out) */
/** an event's letter pairs, worked out once (they're compared with many others) */
function pairsOf(ev) {
  if (ev._pairs) return ev._pairs;
  const s = norm(`${ev.league} ${ev.title}`).replace(/\b\d+\b/g, '').replace(/\s+/g, '');
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
  return (ev._pairs = [m, Math.max(0, s.length - 1)]);
}

function similar(a, b) {
  const [x, nx] = pairsOf(a), [y, ny] = pairsOf(b);
  if (!nx || !ny) return 0;
  // at most 2·min / (nx + ny) alike: names of very different lengths aren't counted at all
  if ((2 * Math.min(nx, ny)) / (nx + ny) < 0.72) return 0;
  let both = 0;
  for (const [k, v] of x) both += Math.min(v, y.get(k) || 0);
  return (2 * both) / (nx + ny);
}

/** better copies first: UHD / HD / no mark, SD last */
const quality = n => (/\b(uhd|4k|fhd)\b/i.test(n) ? 0 : /\bhd\b/i.test(n) ? 1 : /\b(sd|lq)\b/i.test(n) ? 3 : 2);

/**
 * channels: [{ id, name, logo, cat, catName, guide: [{ title, desc, start, end }] | null }]
 * opts: { now, zone (the provider's), ppv: only pay-per-view channels }
 * -> { live: [event], later: [], tomorrow: [], soon: [], sports: [{ id, name, icon, count }], regions: [code] }
 *    event: { id, title, league, sport: { id, name, icon }, start, end, live, region, ppv, channels: [{ id, name, label, logo, feed, catName }] }
 *    (label: an event channel's own part of its name, "USA NHL 01")
 */
function build(channels, { now = Date.now(), zone = DEFAULT_ZONE, ppv = false } = {}) {
  const byKey = new Map();
  const add = (ch, e) => {
    const key = norm(e.title) + '|' + Math.round(e.start / (30 * 60000));
    let ev = byKey.get(key);
    if (!ev) {
      ev = { id: '', title: e.title, league: e.league || '', sport: e.sport, start: e.start, end: e.end, region: regionOf(ch.catName, ch.name), ppv: isPpv(ch.name, ch.catName), channels: [] };
      byKey.set(key, ev);
    }
    if (!ev.league && e.league) ev.league = e.league;
    if (ev.sport.id === 'other' && e.sport.id !== 'other') ev.sport = e.sport;
    ev.end = Math.max(ev.end, e.end);
    if (!ev.channels.some(c => c.id === String(ch.id))) ev.channels.push({ id: String(ch.id), name: ch.name, label: e.label || '', logo: ch.logo || '', feed: e.feed || '', catName: ch.catName || '' });
  };
  for (const ch of channels) {
    if (ppv ? !isPpv(ch.name, ch.catName) : !isSports(ch.name, ch.catName)) continue;
    const p = parseName(ch.name, { now, zone });
    if (p && p.empty) continue;
    if (p) {
      if (!ppv && !isPpv(ch.name, ch.catName) && !isGame(p.title, p.league)) continue;   // (pay-per-view channels only have events)
      const sport = sportOf(p.title, p.league, ch.catName, p.label);
      const end = p.start + sport.hours * HOUR;
      if (end <= now || p.start > now + 7 * 24 * HOUR) continue;   // over (an old name), or far off
      add(ch, { title: p.title, league: p.league, feed: p.feed, label: p.label, start: p.start, end, sport });
      continue;
    }
    // a sports channel: the guide's games
    for (const g of ch.guide || []) {
      if (!g.start || !g.end || g.end <= now || g.start > now + 2 * 24 * HOUR || !looksLive(g.title, g.desc)) continue;
      const title = tidy(String(g.title).replace(/^\s*(live|en vivo|en directo|direct)\s*[:|-]\s*/i, '').replace(/\s*[([]?\blive\b[)\]]?\s*$/i, ''));
      if (!title) continue;
      add(ch, { title, league: '', start: g.start, end: g.end, sport: sportOf(g.title, ch.catName, ch.name) });
    }
  }
  // one event listed twice by the provider, a little differently ("IWR Monsers Ball" / "IWR: Monsters Ball 2026",
  // 5:00 PM ET / 6:00 PM EDT): the same sport (or one not known), within 3 hours, nearly the same name
  // (in start order, each compared only with the ones up to 3 hours later: hundreds of events on a TV)
  const list = [...byKey.values()].sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b && b.start - a.start > 3 * HOUR) break;
      if (!b || (b.sport.id !== a.sport.id && a.sport.id !== 'other' && b.sport.id !== 'other') || similar(a, b) < 0.72) continue;
      for (const ch of b.channels) if (!a.channels.some(c => c.id === ch.id)) a.channels.push(ch);
      if (b.title.length > a.title.length && !a.league) a.title = b.title;
      a.league = a.league || b.league;
      if (a.sport.id === 'other') a.sport = b.sport;
      a.start = Math.min(a.start, b.start);
      a.end = Math.max(a.end, b.end);
      a.region = a.region || b.region;
      a.ppv = a.ppv || b.ppv;
      list[j] = null;
    }
  }
  byKey.clear();
  list.filter(Boolean).forEach((ev, n) => { delete ev._pairs; byKey.set(n, ev); });
  const midnight = d => { const x = new Date(now); x.setHours(24 * d, 0, 0, 0); return x.getTime(); };
  const [today, tomorrow] = [midnight(1), midnight(2)];
  const out = { live: [], later: [], tomorrow: [], soon: [], sports: [], regions: [] };
  const counts = new Map(), regions = new Set();
  for (const ev of byKey.values()) {
    ev.channels.sort((a, b) => quality(a.name) - quality(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    ev.id = ev.channels[0].id + '@' + ev.start;
    ev.live = ev.start <= now + 5 * 60000 && now < ev.end;
    ev.sport = { id: ev.sport.id, name: ev.sport.name, icon: ev.sport.icon };
    (ev.live ? out.live : ev.start < today ? out.later : ev.start < tomorrow ? out.tomorrow : out.soon).push(ev);
    counts.set(ev.sport.id, { ...ev.sport, count: ((counts.get(ev.sport.id) || {}).count || 0) + 1 });
    if (ev.region) regions.add(ev.region);
  }
  for (const k of ['live', 'later', 'tomorrow', 'soon']) out[k].sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  out.sports = [...counts.values()].sort((a, b) => b.count - a.count);
  out.regions = [...regions].sort((a, b) => (a === 'US' ? -1 : b === 'US' ? 1 : a.localeCompare(b)));
  return out;
}

module.exports = { build, parseName, findTime, sportOf, isSports, isPpv, looksLive, regionOf, wallToUtc, offsetMin };
