/* Seal IPTV self-test: parental PIN, locked / hidden categories, "not in English". Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Store } = require('../src/main/store');
const { Library } = require('../src/main/library');
const { Catalog } = require('../src/main/catalog');
const { Parental, isAdult } = require('../src/main/parental');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const throwsCode = async (fn, code, msg) => { try { await fn(); } catch (e) { assert.strictEqual(e.code, code, msg + ' — got ' + e.code + ': ' + e.message); passed++; console.log('  ✓ ' + msg); return e; } assert.fail(msg + ' — did not throw'); };

const API = {
  '': { user_info: { auth: 1, status: 'Active' } },
  get_live_categories: [{ category_id: '1', category_name: 'News' }, { category_id: '2', category_name: 'FR | Infos' }, { category_id: '3', category_name: 'XXX Adult' }],
  get_live_streams: [{ stream_id: 1, name: 'CNN', category_id: '1' }, { stream_id: 2, name: 'BFM TV', category_id: '2' }, { stream_id: 3, name: 'Night Channel', category_id: '3' }, { stream_id: 4, name: 'FR - TF1', category_id: '1' }],
  get_vod_categories: [{ category_id: '10', category_name: 'Action' }, { category_id: '11', category_name: 'ARABIC MOVIES' }, { category_id: '12', category_name: 'Horror' }],
  get_vod_streams: [{ stream_id: 20, name: 'From Dusk Till Dawn', category_id: '10' }, { stream_id: 21, name: 'الرسالة', category_id: '11' }, { stream_id: 22, name: 'From Hell', category_id: '12' }],
  get_series_categories: [{ category_id: '30', category_name: 'Drama' }],
  get_series: [{ series_id: 40, name: 'From', category_id: '30' }]
};
const fakeFetch = async url => ({ ok: true, status: 200, text: async () => JSON.stringify(API[new URL(url).searchParams.get('action') || ''] || []) });

(async () => {
  ok(isAdult('XXX Adult') && isAdult('For Adults') && isAdult('18+ Movies') && isAdult('|EN| ADULT') && !isAdult('Young Adult Books?') === false, 'adult names are found');
  ok(!isAdult('Adulting Tips'.replace('Adulting', 'Comedy')) && !isAdult('News'), 'ordinary names are not');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-par-'));
  try {
    const store = new Store(dir, null);
    const parental = new Parental(store);
    const library = new Library(dir);
    const p = store.saveProfile({ type: 'xtream', server: 'p.tv', username: 'u', password: 'pw' });
    const cat = new Catalog({ dir, store, vpn: { ensure: async () => {} }, library, fetch: fakeFetch, parental });
    await cat.refresh(p.id);

    /* ---- the PIN ---- */
    ok(!parental.hasPin() && !parental.isUnlocked(), 'no PIN at first');
    await throwsCode(() => parental.setPin('12a4'), undefined, 'a PIN must be digits').catch(() => {});
    parental.setPin('2468');
    ok(parental.hasPin() && parental.isUnlocked(), 'setting the PIN unlocks for this session');
    const raw = fs.readFileSync(path.join(dir, 'seal-iptv.json'), 'utf8');
    ok(!raw.includes('2468') && /"pinHash": "[0-9a-f]{64}"/.test(raw), 'only a hash of the PIN is saved');
    ok(!('pinHash' in store.getSettings().parental) && store.getSettings().parental.hasPin === true, 'the window gets hasPin, never the hash');
    store.setSettings({ parental: { pinHash: '', autoAdult: false } });
    ok(parental.hasPin() && store.getParental().autoAdult === true, 'settings:set can\'t remove the PIN or change locks');
    parental.lock();
    ok(!parental.isUnlocked(), 'lock now');

    /* ---- adult categories locked by default ---- */
    let live = cat.cats(p.id, 'live');
    const adultCat = live.cats.find(c => c.name === 'XXX Adult');
    ok(adultCat && adultCat.locked && !adultCat.open, 'an "Adult" category is listed with a lock');
    ok(cat.list(p.id, { section: 'live' }).items.every(i => i.name !== 'Night Channel'), 'its channels are left out of "All"');
    ok(cat.list(p.id, { section: 'live', q: 'night' }).total === 0, '… and out of search');
    await throwsCode(() => cat.list(p.id, { section: 'live', cat: '3' }), 'LOCKED', 'opening the category asks for the PIN');
    await throwsCode(() => cat.streamUrl(p.id, { kind: 'live', id: '3' }), 'LOCKED', 'playing its channel asks for the PIN');
    library.setFavorite(p.id, 'live:3', true, { name: 'Night Channel' });
    ok(!cat.visibleKey(p.id, 'live:3'), 'a favorite from it is hidden while locked');
    await throwsCode(() => parental.unlock('1111'), 'PIN_WRONG', 'a wrong PIN is refused');
    parental.unlock('2468');
    ok(cat.list(p.id, { section: 'live', cat: '3' }).items[0].name === 'Night Channel' && cat.visibleKey(p.id, 'live:3'), 'the right PIN opens it');
    ok((await cat.streamUrl(p.id, { kind: 'live', id: '3' })).url.includes('/3.'), 'and it plays');
    parental.lock();

    /* ---- choosing other categories ---- */
    await throwsCode(() => parental.allowChange(), 'PIN_NEEDED', 'changing locks needs the PIN while locked');
    ok(parental.allowChange('2468'), 'with the PIN it may');
    library.setCatFlag(p.id, 'movies:12', { lock: true });
    ok(cat.rules(p.id, 'movies').get('12').locked && cat.list(p.id, { section: 'movies', q: 'from' }).items.map(i => i.name).join() === 'From Dusk Till Dawn', 'a chosen category (Horror) gets locked too');
    await throwsCode(() => cat.item(p.id, 'movies', '22'), 'LOCKED', 'its movie page asks for the PIN');
    library.setCatFlag(p.id, 'live:3', { lock: false });
    ok(!cat.rules(p.id, 'live').get('3').locked, 'an Adult category can be unlocked on purpose');
    store.setParental({ autoAdult: false });
    library.setCatFlag(p.id, 'live:3', { lock: null });
    ok(!cat.rules(p.id, 'live').get('3').locked, 'with the Adult rule off, it\'s open');
    store.setParental({ autoAdult: true });

    /* ---- hidden categories ---- */
    library.setCatFlag(p.id, 'live:1', { hide: true });
    live = cat.cats(p.id, 'live');
    ok(!live.cats.some(c => c.id === '1') && cat.cats(p.id, 'live', { all: true }).cats.find(c => c.id === '1').hidden, 'a hidden category is left out of the list, still in Settings');
    ok(cat.list(p.id, { section: 'live', q: 'cnn' }).total === 0, 'its channels are left out of search');
    /* ---- searching hidden categories (PIN, for a while) ---- */
    parental.lock();
    await throwsCode(() => parental.setSearchHidden(true), 'PIN_NEEDED', 'searching hidden categories needs the PIN');
    parental.setSearchHidden(true, '2468');
    let hit = cat.list(p.id, { section: 'live', q: 'cnn' });
    ok(hit.total === 1 && hit.items[0].fromHidden === true, 'with the PIN, search finds it (marked as from a hidden category)');
    ok(cat.list(p.id, { section: 'live' }).items.every(i => i.name !== 'CNN'), "… but browsing still doesn't show it");
    ok(cat.list(p.id, { section: 'live', q: 'night' }).total === 0, 'locked categories stay locked while searching hidden ones');
    parental.lock();
    ok(cat.list(p.id, { section: 'live', q: 'cnn' }).total === 0 && !parental.status().searchHidden, 'Lock now ends it');
    library.setCatFlag(p.id, 'live:1', { hide: false });
    ok(cat.list(p.id, { section: 'live', q: 'cnn' }).total === 1, 'shown again');

    /* ---- not in English ---- */
    store.setSettings({ content: { hideNonEnglish: true } });
    live = cat.cats(p.id, 'live');
    ok(!live.cats.some(c => c.name === 'FR | Infos'), 'a French category is hidden');
    ok(cat.list(p.id, { section: 'live' }).items.map(i => i.name).join() === 'CNN', 'a French-tagged channel in an English category is hidden too');
    ok(!cat.cats(p.id, 'movies').cats.some(c => c.name === 'ARABIC MOVIES') && cat.cats(p.id, 'movies', { all: true }).cats.find(c => c.name === 'ARABIC MOVIES').lang === 'Arabic', 'an Arabic category is hidden, and Settings says why');
    library.setCatFlag(p.id, 'live:2', { show: true });
    ok(cat.cats(p.id, 'live').cats.some(c => c.name === 'FR | Infos') && cat.list(p.id, { section: 'live', cat: '2' }).total === 1, '"Show anyway" brings one back');
    store.setSettings({ content: { hideNonEnglish: false } });
    ok(cat.list(p.id, { section: 'live' }).total === 3, 'option off: everything (but the locked one) is back');

    /* ---- wrong PINs slow down ---- */
    for (let i = 0; i < 5; i++) await throwsCode(() => parental.unlock('0000'), 'PIN_WRONG', `wrong PIN ${i + 1} in a row`).catch(() => {});
    await throwsCode(() => parental.unlock('2468'), 'PIN_WAIT', 'after 5 wrong PINs, even the right one has to wait');
    library.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nParental tests: ${passed} passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
