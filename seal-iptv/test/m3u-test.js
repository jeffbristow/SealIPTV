/* Seal IPTV self-test: M3U parsing and sorting. Run with `npm test`. */
const assert = require('assert');
const { parseM3U, splitExtinf, episodeOf, sectionOf, buildCatalog, seriesInfoFromShow } = require('../src/main/m3u');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

const s = splitExtinf('-1 tvg-id="cnn.us" tvg-logo="http://x/l.png" group-title="News, USA",CNN, International');
ok(s.attrs['tvg-id'] === 'cnn.us' && s.attrs['group-title'] === 'News, USA' && s.title === 'CNN, International', 'commas inside quotes and in the title are kept');

const text = `#EXTM3U x-tvg-url="http://x/epg.xml"
#EXTINF:-1 tvg-id="bbc1" tvg-logo="http://x/bbc.png" group-title="UK",BBC One
http://p.example/live/u/p/1.m3u8
#EXTINF:-1 group-title="Sports",Sky Sports
#EXTVLCOPT:http-user-agent=Mozilla/5.0 Test
http://p.example/live/u/p/2.ts

#EXTINF:-1 tvg-logo="http://x/m.jpg" group-title="VOD: Action",Die Hard (1988)
http://p.example/movie/u/p/10.mkv
#EXTINF:-1 group-title="Series: Drama",Breaking Bad S01E02
http://p.example/series/u/p/20.mp4
#EXTINF:-1 group-title="Series: Drama",Breaking Bad S01 E01
http://p.example/series/u/p/19.mp4
#EXTINF:-1 group-title="Shows",The Office 2x03
http://p.example/x/30.mp4
#EXTINF:-1,No Group Channel
#EXTGRP:Misc
rtmp://p.example/live/3
#EXTINF:-1,Broken entry
not a url
`;
const entries = parseM3U(text);
ok(entries.length === 7, 'every stream is read; a line that isn\'t an address is skipped');
ok(entries[1].userAgent === 'Mozilla/5.0 Test', '#EXTVLCOPT user agent is kept');
ok(entries[6].group === 'Misc', '#EXTGRP sets the group');
ok(sectionOf(entries[0]) === 'live' && sectionOf(entries[2]) === 'movies' && sectionOf(entries[3]) === 'series' && sectionOf(entries[5]) === 'series', 'sorted into live / movies / series');
ok(JSON.stringify(episodeOf('Breaking Bad S01E02')) === JSON.stringify({ show: 'Breaking Bad', season: 1, episode: 2 }), 'S01E02 is read');
ok(episodeOf('The.Office.2x03').show === 'The Office' && episodeOf('The.Office.2x03').season === 2, '2x03 is read, dots become spaces');
ok(episodeOf('Channel 4 HD') === null, 'a channel name isn\'t an episode');

const c = buildCatalog(entries);
ok(c.live.items.length === 3 && c.movies.items.length === 1 && c.series.items.length === 2, 'catalogue: 3 channels, 1 movie, 2 shows');
ok(c.movies.items[0].year === 1988 && c.movies.items[0].ext === 'mkv', 'movie year and file type from the name and address');
const bb = c.series.items.find(x => x.name === 'Breaking Bad');
ok(bb && bb.episodes.length === 2, 'both Breaking Bad episodes are in one show');
const info = seriesInfoFromShow(bb);
ok(info.seasons.length === 1 && info.seasons[0].episodes.map(e => e.num).join() === '1,2', 'series details: episodes in order');
ok(c.live.items[1].ua === 'Mozilla/5.0 Test', 'channel keeps its own user agent');
ok(new Set([...c.live.items, ...c.movies.items].map(i => i.id)).size === 4, 'ids are unique');
ok(buildCatalog(parseM3U(text)).live.items[0].id === c.live.items[0].id, 'ids stay the same when the playlist is read again');

console.log(`\nM3U tests: ${passed} passed`);
