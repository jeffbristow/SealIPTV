/* =====================================================================
 * Seal IPTV — parental.js   (the PIN)
 * ---------------------------------------------------------------------
 * The PIN (4–8 digits) is stored only as a salted scrypt hash, in the
 * settings file; the window never sees it. Entering it opens locked
 * categories until Seal IPTV closes, or for the time chosen in Settings.
 * After 5 wrong PINs, the next try waits 30 seconds (then 60, 120 …).
 *
 * Locked categories: any with "Adult" (or XXX / 18+) in the name while
 * "autoAdult" is on, plus the ones chosen per playlist (library.js
 * category flags). Changing what's locked needs the PIN.
 *
 * lockSettings: Settings itself only opens after the PIN (the same
 * unlock as for locked categories).
 * ===================================================================== */
const crypto = require('crypto');

const ADULT_RE = /(^|[^\p{L}])(adults?|xxx|18\s*\+|porn\w*|erotic\w*)($|[^\p{L}])/iu;
const isAdult = name => ADULT_RE.test(String(name || ''));

class Parental {
  /** @param store  Store (getParental / setParental) */
  constructor(store) {
    this.store = store;
    this.until = 0;           // unlocked until (ms); Infinity = until the app closes
    this.wrong = 0;
    this.waitUntil = 0;
    this.searchUntil = 0;     // "search hidden categories too" until (ms)
  }

  get cfg() { return this.store.getParental(); }
  hasPin() { return !!this.cfg.pinHash; }
  isUnlocked() { return !this.hasPin() ? false : Date.now() < this.until; }

  status() {
    const c = this.cfg;
    return { hasPin: !!c.pinHash, unlocked: this.isUnlocked(), autoAdult: c.autoAdult !== false, unlockMinutes: c.unlockMinutes || 0, lockSettings: !!c.pinHash && !!c.lockSettings,
      waitSeconds: Math.max(0, Math.ceil((this.waitUntil - Date.now()) / 1000)),
      searchHidden: this.searchHidden(), searchUntil: this.searchHidden() ? (this.searchUntil === Infinity ? null : this.searchUntil) : 0 };
  }

  static hash(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }

  static checkFormat(pin) {
    if (!/^\d{4,8}$/.test(String(pin || ''))) throw new Error('The PIN must be 4 to 8 digits.');
  }

  /** true if right; throws for wrong / too many tries. */
  verify(pin) {
    const c = this.cfg;
    if (!c.pinHash) throw new Error('No PIN is set.');
    const wait = Math.ceil((this.waitUntil - Date.now()) / 1000);
    if (wait > 0) { const e = new Error(`Too many wrong PINs. Try again in ${wait} seconds.`); e.code = 'PIN_WAIT'; throw e; }
    const a = Buffer.from(Parental.hash(pin, c.pinSalt), 'hex'), b = Buffer.from(c.pinHash, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { this.wrong = 0; return true; }
    this.wrong++;
    if (this.wrong >= 5) this.waitUntil = Date.now() + 30000 * 2 ** Math.min(4, this.wrong - 5);
    const e = new Error('Wrong PIN.');
    e.code = 'PIN_WRONG';
    throw e;
  }

  unlock(pin) {
    this.verify(pin);
    const m = this.cfg.unlockMinutes || 0;
    this.until = m ? Date.now() + m * 60000 : Infinity;
    return this.status();
  }

  lock() { this.until = 0; this.searchUntil = 0; return this.status(); }

  /* ---- searching hidden categories (needs the PIN; for as long as "keep open") ---- */
  searchHidden() { return this.hasPin() && Date.now() < this.searchUntil; }

  setSearchHidden(on, pin) {
    if (!on) { this.searchUntil = 0; return this.status(); }
    if (!this.hasPin()) { const e = new Error('Set a parental PIN first.'); e.code = 'PIN_NONE'; throw e; }
    if (!this.isUnlocked()) {
      if (pin == null) { const e = new Error('Searching hidden categories needs the parental PIN.'); e.code = 'PIN_NEEDED'; throw e; }
      this.verify(pin);
    }
    const m = this.cfg.unlockMinutes || 0;
    this.searchUntil = m ? Date.now() + m * 60000 : Infinity;
    return this.status();
  }

  /** Changes to parental settings: allowed with no PIN set, while unlocked, or with the PIN. */
  allowChange(pin) {
    if (!this.hasPin() || this.isUnlocked()) return true;
    if (pin == null) { const e = new Error('Enter the parental PIN to change this.'); e.code = 'PIN_NEEDED'; throw e; }
    return this.verify(pin);
  }

  setPin(newPin, currentPin) {
    Parental.checkFormat(newPin);
    if (this.hasPin()) this.allowChange(currentPin);
    const salt = crypto.randomBytes(16).toString('hex');
    this.store.setParental({ pinHash: Parental.hash(newPin, salt), pinSalt: salt });
    this.until = this.cfg.unlockMinutes ? Date.now() + this.cfg.unlockMinutes * 60000 : Infinity;
    return this.status();
  }

  removePin(currentPin) {
    this.allowChange(currentPin);
    this.store.setParental({ pinHash: '', pinSalt: '', lockSettings: false });
    this.until = 0;
    return this.status();
  }

  setOptions({ autoAdult, unlockMinutes, lockSettings }, pin) {
    this.allowChange(pin);
    const patch = {};
    if (typeof autoAdult === 'boolean') patch.autoAdult = autoAdult;
    if (typeof lockSettings === 'boolean') {
      if (lockSettings && !this.hasPin()) { const e = new Error('Set a parental PIN first.'); e.code = 'PIN_NONE'; throw e; }
      patch.lockSettings = lockSettings;
    }
    if ([0, 15, 60, 240].includes(Number(unlockMinutes))) patch.unlockMinutes = Number(unlockMinutes);
    this.store.setParental(patch);
    return this.status();
  }
}

module.exports = { Parental, isAdult, ADULT_RE };
