/* =====================================================================
 * Seal IPTV — updater.js   (new versions from GitHub)
 * ---------------------------------------------------------------------
 * Releases are on github.com/jeffbristow/SealIPTV/releases, tagged
 * v<version>. Each one has:
 *   update.json       what's in it: version, files, their SHA-256 and size
 *   update.json.sig   a signature of update.json (ECDSA P-256, SHA-256)
 *   SealIPTV-<v>.sealiptv        Windows: the app's code (app.asar)
 *   SealIPTV-Setup-<v>.exe       Windows: the full installer (new PCs)
 *   SealIPTV-TV-<v>.zip          Fire TV: the app's pages and logic
 *   SealIPTV-FireTV-<v>.apk      Fire TV: the whole app (new TVs, Android changes)
 *
 * Only an update.json signed with the release key (its public half is
 * below; the private half never leaves the PC releases are made on) is
 * believed, and every file must match its SHA-256 in it — so nobody but
 * the releaser can make Seal IPTV install anything.
 *
 * Windows: the .sealiptv package is saved in <data>\updates and runs from
 * the next start (bootstrap.js). When a release needs a newer Electron
 * than the one installed (windows.minInstalled), you're sent to the
 * installer instead.
 *
 * Sections:
 *   1. Versions, the release key
 *   2. Finding the newest release (GitHub) and checking its update.json
 *   3. Windows: check / download / install
 * ===================================================================== */
const path = require('path');
const crypto = require('crypto');
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }   // no asar magic: .asar files are just files here

/* =================================================================
 * 1. VERSIONS, THE RELEASE KEY
 * ================================================================= */
const REPO = 'jeffbristow/SealIPTV';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const download = (tag, file) => `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(file)}`;
// the release key's public half (SPKI, base64) — the same one is in the Fire TV app (UpdateManager.java)
const PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKZIU9roCGtSAm7JCS63cE0dsI38vgGnjMGCDoWII7MTZJRRs7kkpfj8/MOqzDNDfyHkS8er9VS/GN9dll4v3KQ==';
const TAG = /^v(\d+\.\d+\.\d+)$/;
const MAX_BYTES = 300 * 1024 * 1024;

/** "1.0.10" > "1.0.9" -> 1 / 0 / -1 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Is sigB64 the release key's signature of bytes? */
function verifySignature(bytes, sigB64, publicKey = PUBLIC_KEY) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.from(bytes), { key, dsaEncoding: 'der' }, Buffer.from(String(sigB64).trim(), 'base64'));
  } catch { return false; }
}

/* =================================================================
 * 2. THE NEWEST RELEASE
 * ================================================================= */
async function getBytes(fetchImpl, url, ua, { max = MAX_BYTES, onProgress, timeout = 30000 } = {}) {
  if (!/^https:\/\/(api\.)?github\.com\//.test(url)) throw new Error('Updates only come from github.com.');
  let res;
  try { res = await fetchImpl(url, { headers: { 'User-Agent': ua, Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : '*/*' }, signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error('Couldn\'t reach GitHub. Check the internet connection.'); }
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub is busy (too many update checks). Try again in an hour.' : `GitHub answered ${res.status}.`);
  const total = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
  if (total > max) throw new Error('The download is too big.');
  if (!res.body || typeof res.body.getReader !== 'function') return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > max) { try { reader.cancel(); } catch { /* gone */ } throw new Error('The download is too big.'); }
    parts.push(Buffer.from(value));
    if (onProgress) onProgress(got, total);
  }
  return Buffer.concat(parts);
}

/**
 * The newest published v<version> release with a correctly signed update.json.
 * -> { version, tag, manifest, notes, page } | null
 */
async function latestRelease({ fetch: fetchImpl = globalThis.fetch, userAgent = 'SealIPTV', publicKey = PUBLIC_KEY } = {}) {
  let raw;
  try { raw = await getBytes(fetchImpl, RELEASES_API, userAgent, { max: 5 * 1024 * 1024, timeout: 15000 }); }
  catch (e) { if (/answered 404/.test(e.message)) return null; throw e; }   // no releases published yet
  const list = JSON.parse(raw.toString('utf8'));
  const releases = (Array.isArray(list) ? list : [])
    .filter(r => r && !r.draft && !r.prerelease && TAG.test(String(r.tag_name || '')))
    .sort((a, b) => cmpVersion(TAG.exec(b.tag_name)[1], TAG.exec(a.tag_name)[1]));
  for (const r of releases.slice(0, 3)) {
    const names = (r.assets || []).map(a => a && a.name);
    if (!names.includes('update.json') || !names.includes('update.json.sig')) continue;
    const json = await getBytes(fetchImpl, download(r.tag_name, 'update.json'), userAgent, { max: 1024 * 1024 });
    const sig = (await getBytes(fetchImpl, download(r.tag_name, 'update.json.sig'), userAgent, { max: 4096 })).toString('utf8');
    if (!verifySignature(json, sig, publicKey)) throw new Error(`The update information for ${r.tag_name} isn't signed by Seal IPTV, so it was ignored.`);
    const manifest = JSON.parse(json.toString('utf8'));
    if (manifest.version !== TAG.exec(r.tag_name)[1]) throw new Error(`The update information for ${r.tag_name} is for another version, so it was ignored.`);
    return {
      version: manifest.version, tag: r.tag_name, manifest,
      notes: String(r.body || manifest.notes || '').slice(0, 4000),
      page: /^https:\/\/github\.com\//.test(r.html_url || '') ? r.html_url : RELEASES_PAGE
    };
  }
  return null;
}

/* =================================================================
 * 3. WINDOWS
 * ================================================================= */
class Updater {
  /**
   * @param o.current    the version running now (an update or the installed one)
   * @param o.installed  the installed (installer's) version
   * @param o.dir        where packages go (<data>/updates, read by bootstrap.js)
   * @param o.fetch      fetch implementation (tests pass a fake)
   * @param o.userAgent  User-Agent for GitHub
   * @param o.readPackageJson  reads package.json from an .asar (asarinfo.js)
   * @param o.publicKey  the release key (tests use their own)
   */
  constructor({ current, installed, dir, fetch: fetchImpl, userAgent, readPackageJson, publicKey }) {
    this.publicKey = publicKey || PUBLIC_KEY;
    this.current = current;
    this.installed = installed || current;
    this.dir = dir;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.userAgent = userAgent || `SealIPTV/${current}`;
    this.readPackageJson = readPackageJson || require('./asarinfo').readPackageJson;
    this.found = null;
    this.ready = null;   // a version downloaded this session, waiting for a restart
  }

  /**
   * -> { current, latest, available, kind: 'app' | 'installer' | null, ready, notes, page, size }
   *    kind 'app': Update installs it here; 'installer': download the installer from page
   */
  async check() {
    const rel = await latestRelease({ fetch: this.fetch, userAgent: this.userAgent, publicKey: this.publicKey });
    const w = rel && rel.manifest.windows;
    const available = !!(w && cmpVersion(rel.version, this.current) > 0);
    let kind = null;
    if (available) kind = w.minInstalled && cmpVersion(this.installed, w.minInstalled) < 0 ? 'installer' : (w.file ? 'app' : 'installer');
    this.found = available ? rel : null;
    return {
      current: this.current, latest: rel ? rel.version : null, available, kind,
      ready: !!(this.ready && rel && this.ready === rel.version),
      notes: rel ? rel.notes : '', page: rel ? rel.page : RELEASES_PAGE,
      size: w && w.size ? w.size : 0,
      installer: w && w.installer ? download(rel.tag, w.installer) : null
    };
  }

  /** Downloads + checks the package; it runs from the next start. -> { version } */
  async install(onProgress) {
    const rel = this.found || (await this.check(), this.found);
    if (!rel) throw new Error('There\'s no newer version to install.');
    const w = rel.manifest.windows;
    if (!w || !w.file || !/^[0-9a-f]{64}$/.test(w.sha256 || '')) throw new Error('This release has no Windows update package. Use the installer instead.');
    if (w.minInstalled && cmpVersion(this.installed, w.minInstalled) < 0) throw new Error(`Seal IPTV ${rel.version} needs a new installer: download it from the releases page.`);
    const buf = await getBytes(this.fetch, download(rel.tag, w.file), this.userAgent, { onProgress, timeout: 600000 });
    if (w.size && buf.length !== w.size) throw new Error('The download is incomplete. Try again.');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== w.sha256) throw new Error('The download doesn\'t match the signed release, so it wasn\'t installed.');
    fs.mkdirSync(this.dir, { recursive: true });
    const final = path.join(this.dir, `seal-iptv-${rel.version}.asar`);
    const tmp = path.join(this.dir, `incoming-${rel.version}-${process.pid}.tmp`);
    fs.writeFileSync(tmp, buf);
    try {
      const pkg = this.readPackageJson(tmp);
      if (pkg.name !== 'seal-iptv' || pkg.version !== rel.version || !pkg.__hasMain) throw new Error('The update package isn\'t a Seal IPTV ' + rel.version + ' package.');
      try { fs.unlinkSync(final); } catch { /* none */ }
      fs.renameSync(tmp, final);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      throw e;
    }
    // a version that was marked bad before gets a new chance once it's downloaded again
    try {
      const badFile = path.join(this.dir, 'bad-versions.json');
      const bad = JSON.parse(fs.readFileSync(badFile, 'utf8')).filter(v => v !== rel.version);
      fs.writeFileSync(badFile, JSON.stringify(bad));
    } catch { /* none */ }
    try { fs.unlinkSync(path.join(this.dir, 'boot.json')); } catch { /* none */ }   // a fresh start count
    this.ready = rel.version;
    return { version: rel.version };
  }
}

module.exports = { Updater, latestRelease, verifySignature, cmpVersion, REPO, RELEASES_PAGE, PUBLIC_KEY };
