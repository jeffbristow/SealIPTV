/* Seal IPTV self-test: updates from GitHub (faked) — signed update.json, checked downloads. Run with `npm test`. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const asar = require('@electron/asar');
const { Updater, verifySignature, cmpVersion, PUBLIC_KEY } = require('../src/main/updater');
const { readPackageJson } = require('../src/main/asarinfo');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓ ' + msg); };

(async () => {
  ok(cmpVersion('1.0.10', '1.0.9') === 1 && cmpVersion('1.1.0', '1.1') === 0 && cmpVersion('1.2.0', '1.10.0') === -1, 'version compare');
  ok(Buffer.from(PUBLIC_KEY, 'base64').length === 91, 'the built-in release key is a P-256 public key');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sealiptv-upd-'));
  try {
    // a release key for the test, and a "1.2.0" package
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const sign = (buf, key = privateKey) => crypto.sign('sha256', buf, { key, dsaEncoding: 'der' }).toString('base64');
    ok(verifySignature(Buffer.from('x'), sign(Buffer.from('x')), pub) && !verifySignature(Buffer.from('y'), sign(Buffer.from('x')), pub), 'signatures: right bytes pass, changed bytes fail');

    const src = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(src, 'src', 'main'), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'seal-iptv', version: '1.2.0' }));
    fs.writeFileSync(path.join(src, 'src', 'main', 'main.js'), '// 1.2.0');
    fs.writeFileSync(path.join(src, 'src', 'main', 'bootstrap.js'), '// 1.2.0');
    const pkgFile = path.join(tmp, 'app.asar');
    await asar.createPackage(src, pkgFile);
    const pkg = fs.readFileSync(pkgFile);

    let release = {};
    const files = {};
    const publish = (version, windows, { key = privateKey, manifestVersion = version } = {}) => {
      const tag = 'v' + version;
      const manifest = Buffer.from(JSON.stringify({ version: manifestVersion, windows }));
      files[`${tag}/update.json`] = manifest;
      files[`${tag}/update.json.sig`] = Buffer.from(sign(manifest, key));
      if (windows && windows.file) files[`${tag}/${windows.file}`] = pkg;
      release = { tag_name: tag, html_url: `https://github.com/jeffbristow/SealIPTV/releases/tag/${tag}`, body: 'What\'s new', assets: [{ name: 'update.json' }, { name: 'update.json.sig' }, { name: windows && windows.file }] };
    };
    const seen = [];
    const fake = async url => {
      seen.push(url);
      const reply = buf => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf });
      if (url.startsWith('https://api.github.com/')) {
        return reply(Buffer.from(JSON.stringify([
          { tag_name: 'server-v9.0.0', assets: [] },
          { tag_name: 'v9.9.9', prerelease: true, assets: [{ name: 'update.json' }, { name: 'update.json.sig' }] },
          release,
          { tag_name: 'v1.0.5', assets: [] }
        ])));
      }
      const m = url.match(/releases\/download\/(.+)$/);
      const f = m && files[decodeURIComponent(m[1])];
      return f ? reply(f) : { ok: false, status: 404, headers: { get: () => null } };
    };
    const sha = crypto.createHash('sha256').update(pkg).digest('hex');
    const dir = path.join(tmp, 'updates');
    const make = (current = '1.1.0', installed = '1.1.0') => new Updater({ current, installed, dir, fetch: fake, publicKey: pub, readPackageJson });

    publish('1.2.0', { file: 'SealIPTV-1.2.0.sealiptv', sha256: sha, size: pkg.length, minInstalled: '1.1.0' });
    let u = make();
    let r = await u.check();
    ok(r.available && r.latest === '1.2.0' && r.kind === 'app' && r.notes === 'What\'s new', 'newer release found (server and pre-releases skipped)');
    ok(seen.every(x => /^https:\/\/(api\.)?github\.com\//.test(x)), 'only github.com is asked');
    let progress = 0;
    await u.install(() => progress++);
    const saved = path.join(dir, 'seal-iptv-1.2.0.asar');
    ok(fs.existsSync(saved) && readPackageJson(saved).version === '1.2.0' && readPackageJson(saved).__hasMain, 'installed: the package is in the updates folder for the next start');
    ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')), 'no half-written files left');
    ok((await u.check()).ready, 'after installing: "restart to finish"');

    ok(!(await make('1.2.0').check()).available, 'already on the newest version: nothing to do');

    fs.rmSync(dir, { recursive: true, force: true });
    publish('1.2.0', { file: 'SealIPTV-1.2.0.sealiptv', sha256: 'f'.repeat(64), size: pkg.length });
    u = make();
    await u.check();
    await assert.rejects(() => u.install(), /doesn't match the signed release/);
    ok(!fs.existsSync(saved), 'a download that doesn\'t match update.json isn\'t installed');

    publish('1.2.0', { file: 'SealIPTV-1.2.0.sealiptv', sha256: sha, size: pkg.length }, { key: other });
    await assert.rejects(() => make().check(), /isn't signed by Seal IPTV/);
    ok(true, 'update.json signed by another key: refused');

    publish('1.2.0', { file: 'SealIPTV-1.2.0.sealiptv', sha256: sha, size: pkg.length }, { manifestVersion: '1.0.1' });
    await assert.rejects(() => make().check(), /for another version/);
    ok(true, 'an old update.json put in a new release: refused');

    publish('1.2.0', { file: 'SealIPTV-1.2.0.sealiptv', sha256: sha, size: pkg.length, minInstalled: '1.2.0', installer: 'SealIPTV-Setup-1.2.0.exe' });
    r = await make().check();
    ok(r.kind === 'installer' && /SealIPTV-Setup-1\.2\.0\.exe$/.test(r.installer), 'needs a newer Electron: sent to the installer');
    await assert.rejects(() => make().install(), /needs a new installer/);
    ok(true, '… and the package isn\'t installed');

    // the 1.2.0 package claims another version: refused after download
    const src2 = path.join(tmp, 'pkg2');
    fs.cpSync(src, src2, { recursive: true });
    fs.writeFileSync(path.join(src2, 'package.json'), JSON.stringify({ name: 'seal-iptv', version: '1.3.0' }));
    await asar.createPackage(src2, path.join(tmp, 'wrong.asar'));
    const wrong = fs.readFileSync(path.join(tmp, 'wrong.asar'));
    publish('1.2.0', { file: 'SealIPTV-1.2.0.sealiptv', sha256: crypto.createHash('sha256').update(wrong).digest('hex'), size: wrong.length });
    files['v1.2.0/SealIPTV-1.2.0.sealiptv'] = wrong;
    u = make();
    await u.check();
    await assert.rejects(() => u.install(), /isn't a Seal IPTV 1\.2\.0 package/);
    ok(!fs.existsSync(saved), 'a package for another version isn\'t installed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\nUpdate tests: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
