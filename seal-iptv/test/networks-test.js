/* Seal IPTV self-test: US local stations shown with their network's logo (networks.js). Run with `npm test`. */
const assert = require('assert');
const { networkLogo } = require('../src/main/networks');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };
const is = (name, cat, want) => networkLogo(name, cat) === (want ? `networks/${want}.png` : '');

ok(is('FL | Fort Myers | NBC WBBH', 'USA Local Channels ( Full List )', 'nbc') && is('USA NBC 2 WBBH FORT MYERS', 'USA Local - NBC', 'nbc'), 'NBC stations, both ways providers write them');
ok(is('USA ABC7 (WZVN) Fort Myers', '', 'abc') && is('USA abc4 KXLY Spokane', '', 'abc'), 'ABC with the channel number stuck on, any case');
ok(is('USA CBS 11 WINK FORT MYERS', '', 'cbs') && is('USA FOX 4 WFTX FORT MYERS', '', 'fox') && is('USA PBS (WGCU) Fort Myers', '', 'pbs') && is('USA CW 46 WXCW FORT MYERS', '', 'cw'), 'CBS, FOX, PBS, CW');
ok(is('USA MY 38 WSBK BOSTON', 'USA Local - MISC', 'mnt') && is('LA: TELEMUNDO MIAMI HD', 'USA Latin TELEMUNDO', 'telemundo') && is('USA Univision 21 (KFTV) Fresno', '', 'univision') && is('USA ION TV*', '', 'ion'), 'MyNetworkTV, Telemundo, Univision, ION');
ok(is('USA FOX 5 PLUS WTTG WASHINGTON DC', '', 'fox') && is('USA PBS (UNC-TV) Norfolk/Portsmouth/Newport News', '', 'pbs'), '"News" in a place name later on is still the local station');
ok(is('AU ABC Sydney', 'Australia', '') && is('PT: FOX', 'PT: Portugal entertainment', '') && is('ARG: TELEMUNDO', 'ARG: Argentina Entertainment', ''), 'not outside the US: Australia\'s ABC is another channel');
ok(is('USA Fox News Channel', 'USA News', '') && is('USA NBC Sports Boston', 'USA NBC Sports', '') && is('USA CBS Sports Network', '', '') && is('USA PBS (KQED) Kids San Francisco', 'USA Local', '') && is('USA Telemundo Al Dia', '', ''), 'not the networks\' own cable channels (they have their own logos)');
ok(is('USA MLB 01: Brewers VS Rays (FOX Feed ) @ 20:00', 'USA MLB', '') && is('USA CNBC', '', '') && is('USA MSNBC', '', '') && is('USA Weather Channel', '', ''), 'not games, CNBC / MSNBC or other channels');
console.log(`\nNetwork logo tests: ${passed} passed`);
