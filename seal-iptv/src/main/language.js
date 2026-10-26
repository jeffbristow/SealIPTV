/* =====================================================================
 * Seal IPTV — language.js   ("hide what isn't in English")
 * ---------------------------------------------------------------------
 * There's no language field in Xtream or M3U data, but providers label
 * things in a few consistent ways. This reads those labels:
 *
 *   categories  a language / country tag in front ("FR | Films",
 *               "|AR| Movies", "[DE] Serien", "TR: Diziler"), or a
 *               language name ("ARABIC MOVIES", "Latino", "Hindi Series")
 *   titles      a tag in front ("FR - Amélie"), or written mostly in
 *               another script (Arabic, Cyrillic, Chinese, Devanagari…)
 *
 * Language NAMES are only read in category names: a movie called
 * "The French Connection" is English. "English" / EN / UK / US always
 * win. Anything without a clue counts as English (kept).
 *
 * -> { lang: 'en' | '<code>' | null, why }  (null = no clue)
 * ===================================================================== */

/* Tags providers put in front. English-speaking ones keep the item. */
const ENGLISH_TAGS = new Set(['EN', 'ENG', 'UK', 'US', 'USA', 'GB', 'CA', 'AU', 'NZ', 'IE', 'ENGLISH']);
const TAGS = {
  FR: 'fr', FRA: 'fr', DE: 'de', GER: 'de', AT: 'de', CH: 'de', ES: 'es', SPA: 'es', MX: 'es', AR: 'ar', ARA: 'ar', IT: 'it', ITA: 'it',
  PT: 'pt', POR: 'pt', BR: 'pt', NL: 'nl', BE: 'nl', TR: 'tr', TUR: 'tr', PL: 'pl', POL: 'pl', RU: 'ru', RUS: 'ru', UA: 'uk', UKR: 'uk',
  GR: 'el', RO: 'ro', HU: 'hu', CZ: 'cs', SK: 'sk', SE: 'sv', SWE: 'sv', NO: 'no', DK: 'da', FI: 'fi', AL: 'sq', ALB: 'sq',
  RS: 'sr', HR: 'hr', BA: 'bs', BG: 'bg', MK: 'mk', SI: 'sl', IL: 'he', IR: 'fa', PK: 'ur', AF: 'fa', KU: 'ku', KUR: 'ku',
  KR: 'ko', KOR: 'ko', JP: 'ja', JPN: 'ja', CN: 'zh', CHN: 'zh', TW: 'zh', HK: 'zh', TH: 'th', VN: 'vi', ID: 'id', MY: 'ms',
  SO: 'so', ET: 'am', LAT: 'es', LATINO: 'es', EXYU: 'sr', 'EX-YU': 'sr', YU: 'sr', MA: 'ar', DZ: 'ar', TN: 'ar', EG: 'ar',
  SA: 'ar', AE: 'ar', LB: 'ar', IQ: 'ar', SY: 'ar', KW: 'ar', QA: 'ar', JO: 'ar', IN: 'hi', HIN: 'hi', BD: 'bn'
};
/* Countries where English is common: their tag alone doesn't hide anything. */
const MIXED_TAGS = new Set(['IN', 'PH', 'ZA', 'NG', 'SG', 'MY', 'KE', 'GH', 'JM', 'MT', 'CY']);

/* Language names, as providers write them in category names. */
const NAMES = [
  ['ar', 'arabic|arab|عربي'], ['fr', 'french|fran[cç]ais|francais|vf|vostfr'], ['de', 'german|deutsch'], ['es', 'spanish|espa[nñ]ol|latino|latin|castellano'],
  ['it', 'italian|italiano'], ['pt', 'portuguese|portugu[eê]s|brazil|brasil|brazilian'], ['nl', 'dutch|nederlands|vlaams|flemish'],
  ['tr', 'turkish|t[uü]rk|t[uü]rkçe'], ['pl', 'polish|polska|polski'], ['ru', 'russian|русский'], ['uk', 'ukrainian'],
  ['hi', 'hindi|bollywood'], ['ur', 'urdu'], ['pa', 'punjabi'], ['ta', 'tamil'], ['te', 'telugu'], ['ml', 'malayalam'], ['kn', 'kannada'],
  ['mr', 'marathi'], ['bn', 'bengali|bangla'], ['gu', 'gujarati'], ['fa', 'persian|farsi|iranian'], ['ku', 'kurdish|kurdi'],
  ['el', 'greek'], ['ro', 'romanian|rom[aâ]n[aă]'], ['hu', 'hungarian|magyar'], ['cs', 'czech'], ['sk', 'slovak'], ['sv', 'swedish|svenska'],
  ['no', 'norwegian|norsk'], ['da', 'danish|dansk'], ['fi', 'finnish|suomi'], ['sq', 'albanian|shqip'], ['sr', 'serbian|ex-?yu|balkan|yugoslav'],
  ['hr', 'croatian|hrvatski'], ['bs', 'bosnian'], ['bg', 'bulgarian'], ['mk', 'macedonian'], ['he', 'hebrew|israeli'],
  ['ko', 'korean|k-?drama'], ['ja', 'japanese|anime jp'], ['zh', 'chinese|mandarin|cantonese'], ['th', 'thai'], ['vi', 'vietnamese'],
  ['tl', 'filipino|tagalog|pinoy'], ['id', 'indonesian'], ['ms', 'malay'], ['so', 'somali'], ['am', 'amharic|ethiopian'], ['sw', 'swahili'],
  ['af', 'afrikaans'], ['ps', 'pashto|afghan']
].map(([code, re]) => [code, new RegExp(`(^|[^\\p{L}])(${re})($|[^\\p{L}])`, 'iu')]);
const ENGLISH_NAME = /(^|[^\p{L}])(english|eng)($|[^\p{L}])/iu;

/* A tag in front: "FR | x", "FR: x", "FR - x", "|FR| x", "[FR] x", "FR▎x" */
const LEAD_TAG = /^\s*(?:\|\s*([A-Z]{2,6}(?:-[A-Z]{2})?)\s*\||\[\s*([A-Z]{2,6}(?:-[A-Z]{2})?)\s*\]|([A-Z]{2,6}(?:-[A-Z]{2})?)\s*(?:[|:▎┃]|\s-\s|\s–\s))/;

function leadTag(text) {
  const m = String(text || '').match(LEAD_TAG);
  return m ? (m[1] || m[2] || m[3]).toUpperCase() : null;
}

/** Mostly another script? -> language code guess, or null */
function scriptOf(text) {
  const letters = String(text || '').match(/\p{L}/gu);
  if (!letters || letters.length < 3) return null;
  const count = re => (String(text).match(re) || []).length;
  const latin = count(/\p{Script=Latin}/gu);
  if (latin / letters.length >= 0.6) return null;
  const scripts = [
    ['ar', /\p{Script=Arabic}/gu], ['ru', /\p{Script=Cyrillic}/gu], ['zh', /\p{Script=Han}/gu], ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
    ['ko', /\p{Script=Hangul}/gu], ['hi', /\p{Script=Devanagari}/gu], ['he', /\p{Script=Hebrew}/gu], ['th', /\p{Script=Thai}/gu],
    ['el', /\p{Script=Greek}/gu], ['bn', /\p{Script=Bengali}/gu], ['ta', /\p{Script=Tamil}/gu], ['te', /\p{Script=Telugu}/gu],
    ['gu', /\p{Script=Gujarati}/gu], ['pa', /\p{Script=Gurmukhi}/gu], ['ml', /\p{Script=Malayalam}/gu], ['kn', /\p{Script=Kannada}/gu],
    ['am', /\p{Script=Ethiopic}/gu], ['ka', /\p{Script=Georgian}/gu], ['hy', /\p{Script=Armenian}/gu]
  ];
  let best = null, n = 0;
  for (const [code, re] of scripts) { const c = count(re); if (c > n) { n = c; best = code; } }
  return n / letters.length >= 0.4 ? best : null;
}

function fromTag(tag) {
  if (!tag) return null;
  const t = tag.replace(/-/g, '-');
  if (ENGLISH_TAGS.has(t)) return { lang: 'en', why: `tag ${t}` };
  if (MIXED_TAGS.has(t)) return null;
  const code = TAGS[t] || TAGS[t.replace('-', '')];
  return code ? { lang: code, why: `tag ${t}` } : null;
}

/** A category name. */
function categoryLanguage(name) {
  const s = String(name || '');
  const tag = fromTag(leadTag(s));
  if (tag && tag.lang === 'en') return tag;
  if (ENGLISH_NAME.test(s)) return { lang: 'en', why: 'says English' };
  if (tag) return tag;
  for (const [code, re] of NAMES) if (re.test(s)) return { lang: code, why: `says ${s.match(re)[2]}` };
  const sc = scriptOf(s);
  return sc ? { lang: sc, why: 'written in another script' } : null;
}

/** A channel / movie / series title (tags and scripts only). */
function titleLanguage(name) {
  const tag = fromTag(leadTag(name));
  if (tag) return tag;
  const sc = scriptOf(name);
  return sc ? { lang: sc, why: 'written in another script' } : null;
}

const NAMES_OF = { ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', tr: 'Turkish', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', hi: 'Hindi', ur: 'Urdu', fa: 'Persian', el: 'Greek', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', he: 'Hebrew', sv: 'Swedish', sr: 'Balkan', ro: 'Romanian' };
const languageName = code => NAMES_OF[code] || String(code || '').toUpperCase();

module.exports = { categoryLanguage, titleLanguage, leadTag, scriptOf, languageName };
