/* =====================================================================
 * Seal IPTV — networks.js
 * ---------------------------------------------------------------------
 * US local stations shown with their network's logo instead of the
 * provider's picture: "USA ABC 7 WZVN FORT MYERS", "FL | Fort Myers |
 * NBC WBBH", "LA: TELEMUNDO MIAMI HD" … The logos come with the app
 * (renderer/networks/*.png, from Wikimedia Commons: SOURCES.txt), so
 * they show without asking anyone, also while the VPN guard blocks.
 *
 * Only US channels (the name or the category says USA / US / Local, or
 * a state as in "FL | …"): Australia's ABC and Portugal's FOX are other
 * channels. Not the networks' cable channels either (FOX News, NBC
 * Sports, CBS Reality, PBS Kids, ION Mystery …): they have logos of
 * their own.
 * ===================================================================== */
const NETWORKS = [
  ['abc', /(?:^|[^a-z])abc(?=$|[\s\d(|:*-])/i],
  ['cbs', /(?:^|[^a-z])cbs(?=$|[\s\d(|:*-])/i],
  ['nbc', /(?:^|[^a-z])nbc(?=$|[\s\d(|:*-])/i],
  ['fox', /(?:^|[^a-z])fox(?=$|[\s\d(|:*-])/i],
  ['pbs', /(?:^|[^a-z])pbs(?=$|[\s\d(|:*-])/i],
  ['cw', /(?:^|[^a-z])(?:the\s)?cw(?=$|[\s\d(|:*-])/i],
  ['mnt', /(?:^|[^a-z])(?:mnt|my\s?network\s?tv|mytv|my\s?\d+)(?=$|[\s\d(|:*-])/i],
  ['telemundo', /telemundo/i],
  ['univision', /univision/i],
  ['ion', /(?:^|[^a-z])ion(?:\s?tv|\s?television)?(?=$|[\s\d(|:*-])/i]
];
// right after the network's name: its own cable / streaming channels (FOX News, PBS (KQED) Kids,
// Telemundo Al Día …), not the local station. Further on it's the place: "Newport News".
const NOT_LOCAL = /\b(sports?|news|business|golf|weather|soul|deportes|soccer|reality|justice|crime|life|movies?|kids|comedy|action|family|premium|dateline|mystery|universo|telenovelas|al|classics?|xtra|nfl|nba|mlb|nhl|ppv|events?)\b/i;
const US_NAME = /^\s*(?:usa?|united states)\b|^\s*[a-z]{2}\s*\|/i;
const US_CAT = /\b(?:usa?|united states|locals?)\b/i;
const EVENT = /\bvs\.?\s|@\s*\d|\d{1,2}:\d{2}/i;   // "Brewers VS Rays (FOX Feed) @ 20:00": a game, not the station

/** "networks/nbc.png" for a US local NBC station, else '' */
function networkLogo(name, catName = '') {
  name = String(name || '');
  if (!US_NAME.test(name) && !US_CAT.test(String(catName || ''))) return '';
  if (EVENT.test(name)) return '';
  let best = null;
  for (const [id, re] of NETWORKS) {
    const m = re.exec(name);
    if (m && (!best || m.index < best.at)) best = { id, at: m.index, end: m.index + m[0].length };
  }
  if (!best) return '';
  // the next two words, leaving out channel numbers and call signs in brackets: "ABC 7 (WZVN) Fort Myers"
  const next = name.slice(best.end).split(/[\s|:,/]+/).filter(w => w && !/^\d+\*?$|^\(.*\)$/.test(w)).slice(0, 2).join(' ');
  return NOT_LOCAL.test(next) ? '' : `networks/${best.id}.png`;
}

module.exports = { networkLogo };
