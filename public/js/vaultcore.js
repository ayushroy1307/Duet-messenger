// Vault primitives: a random master key (MK) wrapped independently by a PIN-derived KEK,
// an optional biometric (WebAuthn PRF) KEK and a recovery secret. Storage-agnostic.
//
// Deviation from the spec, stated plainly: WebCrypto has no scrypt, so the PIN KEK uses
// PBKDF2-HMAC-SHA256 with a high iteration count (default 600,000), salted per device.
import { enc, dec, b64, unb64, rand, concat, CryptoError } from './util.js';
import { hkdf, clearCryptoCaches } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const ZERO = new Uint8Array(32);
export const PBKDF2_ITERS = 600000;

export async function pinKek(pin, salt, iters = PBKDF2_ITERS) {
  const base = await subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, base, 256));
}
export async function bioKek(prfOutput, salt) {
  return hkdf(new Uint8Array(prfOutput), salt, 'duet-kek-bio', 32);
}
export async function recoveryKek(code, salt) {
  const clean = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
  return hkdf(enc.encode(clean), salt, 'duet-kek-recovery', 32);
}

async function wrapKey(kek, label) {
  const raw = await hkdf(kek, ZERO, 'duet-wrap-' + label, 32);
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function wrapMK(kek, mk, label) {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(kek, label), mk));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function unwrapMK(kek, wrapped, label) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrapped.iv) }, await wrapKey(kek, label), unb64(wrapped.ct)));
  } catch { throw new CryptoError('bad-secret', 'Wrong PIN or secret'); }
}

/** Base32 (RFC 4648 alphabet) recovery code, 160 bits, shown in groups of 4. */
export function newRecoveryCode() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = rand(20);
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{1,4}/g).join('-');
}

/** Sealing helpers bound to an unlocked MK (label-separated subkeys). */
export class Sealer {
  constructor(mk) {
    this.mk = new Uint8Array(mk);
    this.keys = new Map();
  }
  async key(label) {
    if (!this.mk) throw new CryptoError('locked', 'Vault is locked');
    let k = this.keys.get(label);
    if (!k) {
      const raw = await hkdf(this.mk, ZERO, 'duet-seal-' + label, 32);
      k = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      this.keys.set(label, k);
    }
    return k;
  }
  async seal(label, obj, aad = '') {
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await this.key(label), enc.encode(JSON.stringify(obj))));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async open(label, rec, aad = '') {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: enc.encode(aad) }, await this.key(label), unb64(rec.ct));
    return JSON.parse(dec.decode(pt));
  }
  /** Zero the master key and drop every derived key and cached CryptoKey. */
  destroy() {
    if (this.mk) this.mk.fill(0);
    this.mk = null;
    this.keys.clear();
    clearCryptoCaches();
  }
}

/** Pure vault logic over a tiny async KV `meta` (get/put). */
export class VaultCore {
  constructor(meta, opts = {}) {
    this.meta = meta;
    this.iters = opts.iters || PBKDF2_ITERS;
    this.sealer = null;
  }
  async exists() { return !!(await this.meta.get('vault')); }
  get unlocked() { return !!this.sealer; }

  async setup(pin) {
    if (this.sealer) this.lock();
    const mk = rand(32);
    const salt = rand(16);
    const rsalt = rand(16);
    const code = newRecoveryCode();
    const vault = {
      v: 1,
      pin: { salt: b64(salt), iters: this.iters, wrapped: await wrapMK(await pinKek(pin, salt, this.iters), mk, 'pin') },
      bio: null,
      rec: { salt: b64(rsalt), wrapped: await wrapMK(await recoveryKek(code, rsalt), mk, 'rec') },
    };
    await this.meta.put('vault', vault);
    await this.meta.put('throttle', { fails: 0, until: 0 });
    this.sealer = new Sealer(mk);
    mk.fill(0);
    return { recoveryCode: code };
  }

  async _throttleCheck() {
    const t = (await this.meta.get('throttle')) || { fails: 0, until: 0 };
    if (t.until > Date.now()) throw new CryptoError('throttled', String(Math.ceil((t.until - Date.now()) / 1000)));
    return t;
  }
  async _fail(t) {
    t.fails += 1;
    t.until = t.fails >= 3 ? Date.now() + Math.min(5 * 60_000, 2 ** (t.fails - 2) * 1000) : 0;
    await this.meta.put('throttle', t);
  }
  async _ok() { await this.meta.put('throttle', { fails: 0, until: 0 }); }

  async unlockPin(pin) {
    const t = await this._throttleCheck();
    const v = await this.meta.get('vault');
    if (!v) throw new CryptoError('no-vault', 'No vault on this device');
    try {
      const mk = await unwrapMK(await pinKek(pin, unb64(v.pin.salt), v.pin.iters), v.pin.wrapped, 'pin');
      this.sealer = new Sealer(mk); mk.fill(0);
      await this._ok();
    } catch (e) { if (e.code === 'bad-secret') await this._fail(t); throw e; }
  }
  async unlockRecovery(code, newPin) {
    const t = await this._throttleCheck();
    const v = await this.meta.get('vault');
    try {
      const mk = await unwrapMK(await recoveryKek(code, unb64(v.rec.salt)), v.rec.wrapped, 'rec');
      // Re-wrap with a fresh PIN so the user is never locked out.
      const salt = rand(16);
      v.pin = { salt: b64(salt), iters: this.iters, wrapped: await wrapMK(await pinKek(newPin, salt, this.iters), mk, 'pin') };
      await this.meta.put('vault', v);
      this.sealer = new Sealer(mk); mk.fill(0);
      await this._ok();
    } catch (e) { if (e.code === 'bad-secret') await this._fail(t); throw e; }
  }
  /** Called by the browser layer with the PRF output obtained from WebAuthn. */
  async enableBio(prfOutput, credentialId) {
    if (!this.sealer) throw new CryptoError('locked', 'Unlock first');
    const v = await this.meta.get('vault');
    const salt = rand(16);
    v.bio = { credentialId, salt: b64(salt), wrapped: await wrapMK(await bioKek(prfOutput, salt), this.sealer.mk, 'bio') };
    await this.meta.put('vault', v);
  }
  async disableBio() {
    const v = await this.meta.get('vault');
    v.bio = null;
    await this.meta.put('vault', v);
  }
  async unlockBio(prfOutput) {
    const v = await this.meta.get('vault');
    if (!v || !v.bio) throw new CryptoError('no-bio', 'Biometric unlock is not set up');
    const mk = await unwrapMK(await bioKek(prfOutput, unb64(v.bio.salt)), v.bio.wrapped, 'bio');
    this.sealer = new Sealer(mk); mk.fill(0);
    await this._ok();
  }
  lock() {
    if (this.sealer) this.sealer.destroy();
    this.sealer = null;
  }
}
