/* =====================================================================
 * Seal IPTV — asarinfo.js   (update packages)
 * ---------------------------------------------------------------------
 * Reads package.json out of an update package (.asar / .sealiptv)
 * WITHOUT Electron's built-in asar support: that keeps the file open for
 * the rest of the session, and on Windows an open file can't be renamed
 * or deleted. Here the file is opened, the few bytes needed are read,
 * and it's closed again. (Same as Sealpost's asarinfo.js.)
 *
 * asar layout: [4 bytes][4 bytes header size][4][4 bytes JSON length]
 *              [JSON directory header] [file data...]
 * ===================================================================== */
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }   // original-fs = no asar magic

function readPackageJson(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > 50 * 1024 * 1024) throw new Error('not an asar archive');
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const entry = header.files && header.files['package.json'];
    if (!entry || entry.offset === undefined) throw new Error('package.json missing');
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, 8 + headerSize + Number(entry.offset));
    const pkg = JSON.parse(buf.toString('utf8'));
    // must also hold the app's code
    const main = header.files.src && header.files.src.files && header.files.src.files.main;
    pkg.__hasMain = !!(main && main.files && main.files['main.js'] && main.files['bootstrap.js']);
    return pkg;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readPackageJson, fs };
