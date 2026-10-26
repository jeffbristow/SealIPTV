/* Seal IPTV self-test: "not in English" detection. Run with `npm test`. */
const assert = require('assert');
const { categoryLanguage, titleLanguage } = require('../src/main/language');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const cat = n => (categoryLanguage(n) || { lang: null }).lang;
const title = n => (titleLanguage(n) || { lang: null }).lang;

ok(cat('FR | Films') === 'fr' && cat('|AR| Movies') === 'ar' && cat('[DE] Serien') === 'de' && cat('TR: Diziler') === 'tr' && cat('ES - Deportes') === 'es', 'tags in front of categories');
ok(cat('ARABIC MOVIES') === 'ar' && cat('Latino Series') === 'es' && cat('Hindi Movies') === 'hi' && cat('Bollywood') === 'hi' && cat('EX-YU Kanali') === 'sr', 'language names in categories');
ok(cat('EN | Movies') === 'en' && cat('UK Sports') === null && cat('|UK| Sports') === 'en' && cat('Arabic channels in English') === 'en', 'English tags and "English" win');
ok(cat('Action') === null && cat('Movies 24/7') === null && cat('Sports HD') === null && cat('Documentary') === null, 'ordinary categories: no clue (kept)');
ok(cat('IN | News') === null && cat('IN | Hindi News') === 'hi', 'India tag alone keeps it; "Hindi" hides it');
ok(cat('Русские фильмы') === 'ru' && cat('أفلام عربية') === 'ar' && cat('中文电影') === 'zh', 'categories in another script');
ok(cat('Adult') === null && cat('Turkey Travel Shows') === null, 'words that only look like languages are kept ("Turkey" isn\'t "Turkish")');
ok(title('FR - Amélie') === 'fr' && title('|DE| Tatort') === 'de' && title('EN - The Office') === 'en', 'tags in front of titles');
ok(title('The French Connection (1971)') === null && title('Spanish Princess') === null, 'language names in titles don\'t count');
ok(title('Москва слезам не верит') === 'ru' && title('الرسالة') === 'ar' && title('हम आपके हैं कौन') === 'hi', 'titles in another script');
ok(title('Amélie') === null && title('Pokémon: The Movie') === null && title('Léon: The Professional') === null, 'accents alone don\'t count');
ok(title('BBC One HD') === null && title('CNN') === null && title('US: CNN') === 'en', 'channel names');
console.log(`\nLanguage tests: ${passed} passed`);
