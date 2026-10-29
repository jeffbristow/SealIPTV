/* "Set up from your phone": the code and the sealed message (seal-iptv/src/main/setuplink.js), as the phone and the TV use them. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const link = require('../../seal-iptv/src/main/setuplink');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m); };

const code = link.newCode();
ok(code.length === 10 && [...code].every(c => link.ALPHABET.includes(c)), 'a code: 10 letters / digits without 0 O 1 I L');
ok(new Set(Array.from({ length: 200 }, link.newCode)).size === 200, 'a new one every time');
ok(link.pretty(code) === code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8) && link.normal(' ' + link.pretty(code).toLowerCase() + ' ') === code, 'shown as XXXX-XXXX-XX; typed in any case, with or without dashes');
const key = link.keyFrom(code);
const sent = link.seal(key, { kind: 'sync', server: 'https://example.com/iptv-sync/', username: 'sam', passphrase: 'very secret phrase' });
ok(!/secret|sam|example/.test(sent) && JSON.parse(sent).v === 1, 'what goes over the network has nothing readable in it');
ok(link.open(link.keyFrom(link.pretty(code).toLowerCase()), sent).passphrase === 'very secret phrase', 'the TV opens it with the same code');
let threw = false;
try { link.open(link.keyFrom(link.newCode()), sent); } catch { threw = true; }
ok(threw, 'another code can\'t open it');
const j = JSON.parse(sent); j.c = j.c.slice(0, -4) + (j.c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
threw = false;
try { link.open(key, JSON.stringify(j)); } catch { threw = true; }
ok(threw, 'a changed message is refused');
ok(link.seal(key, { a: 1 }) !== link.seal(key, { a: 1 }), 'the same message sealed twice looks different');
const page = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'phone.html');
if (fs.existsSync(page)) {
  const html = fs.readFileSync(page, 'utf8');
  ok(/<script>[\s\S]*Send to the TV[\s\S]*<\/script>/.test(html) && !/\/\*PAGE_JS\*\//.test(html) && !/<script src=/.test(html), 'the phone\'s page (build.js) is one file with its script inside');
}
console.log(`\nPhone setup tests: ${passed} passed`);
