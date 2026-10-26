/* fs for the Fire TV app: the few synchronous calls store / library / catalog / sync use,
   done by Android in the app's private storage (NativeBridge.readFile …). Text files only. */
const { N } = require('./native');

const enoent = p => Object.assign(new Error(`ENOENT: no such file '${p}'`), { code: 'ENOENT' });

module.exports = {
  readFileSync(p) {
    const s = N.readFile(String(p));
    if (s == null) throw enoent(p);
    return s;
  },
  writeFileSync(p, data) {
    if (!N.writeFile(String(p), typeof data === 'string' ? data : String(data))) throw new Error('Could not save ' + p);
  },
  renameSync(a, b) { if (!N.renameFile(String(a), String(b))) throw enoent(a); },
  unlinkSync(p) { if (!N.deleteFile(String(p))) throw enoent(p); },
  existsSync(p) { return !!N.exists(String(p)); },
  mkdirSync() { /* folders are made when a file is written */ },
  rmSync(p) { try { N.deleteFile(String(p)); } catch { /* gone */ } },
  readdirSync() { return []; }
};
