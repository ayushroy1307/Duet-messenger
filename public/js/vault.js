import { api } from './api.js';
import * as db from './db.js';
import { diag } from './diag.js';
import {
  aesOpen, aesSeal, b64, unb64, b64url, unb64url, concat, deriveVaultKey,
  forgetDerivedKeys, fromUtf8, generateRecoverySecret, hkdfBytes, importAesRaw,
  normalizeRecoverySecret, randomBytes, RECOVERY_SCRYPT, PIN_SCRYPT,
  scryptKey, utf8
} from './crypto.js';
import { createKeystore } from './engine.js';

const PIN_AAD = 'duet:vault:pin:v1';
const RECOVERY_AAD = 'duet:vault:recovery:v1';
const BIOMETRIC_AAD = 'duet:vault:biometric:v1';
const KEYSTORE_AAD = 'duet:vault:keystore:v1';
const CACHE_AAD = 'duet:vault:cache:v1';
const MEDIA_AAD = 'duet:vault:media:v1';
const OUTBOX_AAD = 'duet:vault:outbox:v1';

export class VaultError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.extra = extra;
  }
}

const metaKey = (userId) => `vault:${userId}`;
const sealedKey = (userId) => `keystore:${userId}`;
const cacheKeyFor = (userId, messageId) => `cache:${userId}:${messageId}`;
const mediaKeyFor = (userId, mediaId) => `media:${userId}:${mediaId}`;
const outboxKey = (userId, clientId) => `outbox:${userId}:${clientId}`;

function validatePin(pin) {
  const value = String(pin || '');
  if (value.length < 6) throw new VaultError('weak_pin', 'Use at least 6 digits.');
  if (!/^\d+$/.test(value) && value.length < 8) {
    throw new VaultError('weak_pin', 'Use at least 8 characters, or a 6-digit PIN.');
  }
  if (value.length > 128) throw new VaultError('weak_pin', 'That passphrase is too long.');
  return value;
}

function prfResult(credential) {
  try {
    const extensions = credential.getClientExtensionResults?.() || {};
    const first = extensions.prf?.results?.first;
    if (!first) return null;
    return new Uint8Array(first);
  } catch {
    return null;
  }
}

export async function biometricAvailability() {
  try {
    if (!window.PublicKeyCredential) {
      return { available: false, reason: 'This browser does not support WebAuthn.' };
    }
    const platform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();
    if (!platform) {
      return { available: false, reason: 'No device biometrics or screen lock are available.' };
    }
    return { available: true, reason: null };
  } catch {
    return { available: false, reason: 'Biometric unlock is unavailable in this browser.' };
  }
}

export class Vault {
  constructor(userId) {
    this.userId = userId;
    this.meta = null;
    this.keystore = null;
    this.mk = null;
    this.keystoreKey = null;
    this.cacheKey = null;
    this.mediaKey = null;
    this.dirty = false;
    this.writing = false;
    this.backupTimer = null;
    this.lastSealed = null;
    this.lastBackupAt = null;
    this.lastBackupError = null;
    this.pendingRecovery = false;
    this.onLock = null;
  }

  static async inspect(userId) {
    const meta = await db.dbGet('kv', metaKey(userId));
    const sealed = meta ? await db.dbGet('sealed', sealedKey(userId)) : null;
    return { exists: Boolean(meta && sealed), meta: meta || null, hasSealed: Boolean(sealed) };
  }

  static async loadMeta(userId) {
    return db.dbGet('kv', metaKey(userId));
  }

  async loadMeta() {
    this.meta = await db.dbGet('kv', metaKey(this.userId));
    return this.meta;
  }

  get locked() {
    return !this.mk || !this.keystore;
  }

  get deviceId() {
    return this.meta?.deviceId || null;
  }

  async ensureDeviceId() {
    if (this.meta?.deviceId) return this.meta.deviceId;
    const existing = await db.dbGet('kv', `device:${this.userId}`);
    if (existing) return existing;
    const id = b64url(randomBytes(16));
    await db.dbPut('kv', `device:${this.userId}`, id);
    return id;
  }

  async saveMeta() {
    if (this.meta) await db.dbPut('kv', metaKey(this.userId), this.meta);
  }

  async deriveKeys(mk) {
    this.mk = mk;
    this.keystoreKey = await deriveVaultKey(mk, 'keystore:v1');
    this.cacheKey = await deriveVaultKey(mk, 'cache:v1');
    this.mediaKey = await deriveVaultKey(mk, 'media-cache:v1');
  }

  async sealKeystore(keystore = this.keystore) {
    if (!this.keystoreKey) throw new VaultError('locked', 'Unlock the vault first.');
    const blob = await aesSeal(
      this.keystoreKey,
      utf8(JSON.stringify(keystore)),
      KEYSTORE_AAD
    );
    this.lastSealed = blob;
    return blob;
  }

  async openKeystore(blob) {
    const bytes = await aesOpen(this.keystoreKey, blob, KEYSTORE_AAD);
    return JSON.parse(fromUtf8(bytes));
  }

  async loadKeystoreFromDisk() {
    const row = await db.dbGet('sealed', sealedKey(this.userId));
    if (!row?.blob) {
      throw new VaultError('keystore_missing',
        'This device is missing its encrypted keystore. Restore with your recovery key.');
    }
    this.keystore = await this.openKeystore(row.blob);
    this.lastSealed = row.blob;
    if (!this.keystore?.identity || !this.keystore?.signedPreKey) {
      throw new VaultError('keystore_corrupt',
        'The encrypted keystore is damaged. Restore with your recovery key.');
    }
  }

  async pinWrap(pin, params = PIN_SCRYPT) {
    const salt = randomBytes(16);
    const raw = await scryptKey(pin, salt, params);
    const key = await importAesRaw(raw);
    const wrapped = await aesSeal(key, this.mk, PIN_AAD);
    return {
      salt: b64(salt),
      N: params.N,
      r: params.r,
      p: params.p,
      dkLen: params.dkLen,
      wrapped
    };
  }

  async recoveryWrap(secret) {
    const salt = randomBytes(16);
    const params = RECOVERY_SCRYPT;
    const normalized = normalizeRecoverySecret(secret);
    const raw = await scryptKey(normalized, salt, params);
    const key = await importAesRaw(raw);
    const wrapped = await aesSeal(key, this.mk, RECOVERY_AAD);
    return {
      salt: b64(salt),
      N: params.N,
      r: params.r,
      p: params.p,
      dkLen: params.dkLen,
      wrapped
    };
  }

  async unwrapWithPin(pin, pinMeta) {
    const params = {
      N: pinMeta.N, r: pinMeta.r, p: pinMeta.p, dkLen: pinMeta.dkLen || 32, asyncTick: 10
    };
    const raw = await scryptKey(pin, unb64(pinMeta.salt), params);
    const key = await importAesRaw(raw);
    return aesOpen(key, pinMeta.wrapped, PIN_AAD);
  }

  async create({ pin, biometric = false, onState }) {
    validatePin(pin);
    const existing = await Vault.inspect(this.userId);
    if (existing.exists) throw new VaultError('exists', 'A vault already exists on this device.');
    const deviceId = await this.ensureDeviceId();
    const mk = randomBytes(32);
    await this.deriveKeys(mk);
    this.keystore = createKeystore({ userId: this.userId, deviceId });
    const recoverySecret = generateRecoverySecret();
    const pinMeta = await this.pinWrap(pin);
    const recoveryMeta = await this.recoveryWrap(recoverySecret);
    this.meta = {
      version: 1,
      userId: this.userId,
      deviceId,
      createdAt: new Date().toISOString(),
      pin: pinMeta,
      recovery: recoveryMeta,
      biometric: null,
      failedAttempts: 0,
      lockedUntil: 0,
      keyVersion: 1
    };
    const blob = await this.sealKeystore();
    await db.dbPut('sealed', sealedKey(this.userId), { blob, updatedAt: Date.now() });
    await this.saveMeta();
    this.pendingRecovery = false;

    let biometricError = null;
    if (biometric) {
      try {
        onState?.('enrolling biometrics');
        await this.enrollBiometric();
      } catch (error) {
        biometricError = error.message;
      }
    }

    const backupError = await this.backupNow().catch((error) => {
      this.lastBackupError = error.message;
      return error;
    });
    diag.event('vault_unlocked', { reason: 'created' });
    return {
      recoverySecret,
      biometricEnabled: Boolean(this.meta.biometric),
      biometricError,
      backupError: backupError instanceof Error ? backupError.message : null
    };
  }

  async unlockWithPin(pin) {
    await this.loadMeta();
    if (!this.meta) throw new VaultError('no_vault', 'There is no vault on this device.');
    if (this.meta.lockedUntil && this.meta.lockedUntil > Date.now()) {
      throw new VaultError('throttled',
        'Too many attempts. Wait before trying again.',
        { retryAfter: Math.ceil((this.meta.lockedUntil - Date.now()) / 1000) });
    }
    try {
      const mk = await this.unwrapWithPin(pin, this.meta.pin);
      await this.deriveKeys(mk);
      await this.loadKeystoreFromDisk();
    } catch (error) {
      await this.recordFailure();
      if (error instanceof VaultError) throw error;
      throw new VaultError('wrong_pin', 'That PIN or passphrase is not correct.',
        { attemptsRemaining: Math.max(0, 5 - (this.meta.failedAttempts || 0)) });
    }
    await this.recordSuccess();
    diag.event('vault_unlocked', { reason: 'pin' });
    return this.keystore;
  }

  async recordFailure() {
    if (!this.meta) return;
    this.meta.failedAttempts = (this.meta.failedAttempts || 0) + 1;
    if (this.meta.failedAttempts >= 5) {
      const delaySeconds = Math.min(900, 30 * 2 ** (this.meta.failedAttempts - 5));
      this.meta.lockedUntil = Date.now() + delaySeconds * 1000;
    }
    await this.saveMeta();
  }

  async recordSuccess() {
    if (!this.meta) return;
    this.meta.failedAttempts = 0;
    this.meta.lockedUntil = 0;
    this.meta.lastUnlockedAt = new Date().toISOString();
    await this.saveMeta();
  }

  async unlockWithBiometric() {
    await this.loadMeta();
    if (!this.meta?.biometric) {
      throw new VaultError('not_enrolled', 'Biometric unlock is not set up on this device.');
    }
    if (this.meta.lockedUntil && this.meta.lockedUntil > Date.now()) {
      throw new VaultError('throttled', 'Too many attempts. Wait before trying again.', {
        retryAfter: Math.ceil((this.meta.lockedUntil - Date.now()) / 1000)
      });
    }
    const biometric = this.meta.biometric;
    let assertion;
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          rpId: location.hostname,
          timeout: 60_000,
          userVerification: 'required',
          allowCredentials: [{
            type: 'public-key',
            id: unb64url(biometric.credentialId)
          }],
          extensions: {
            prf: { eval: { first: unb64(biometric.salt) } }
          }
        }
      });
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        throw new VaultError('cancelled', 'Biometric unlock was cancelled.');
      }
      throw new VaultError('biometric_failed', 'Biometric unlock did not work. Use your PIN.');
    }
    const prf = prfResult(assertion);
    if (!prf) {
      throw new VaultError('prf_unsupported',
        'This browser did not return a PRF secret. Use your PIN, or set up biometrics again.');
    }
    try {
      const kekBytes = hkdfBytes(
        prf,
        unb64(biometric.salt),
        utf8('duet:biometric-kek:v1'),
        32
      );
      const kek = await importAesRaw(kekBytes);
      const mk = await aesOpen(kek, biometric.wrapped, BIOMETRIC_AAD);
      await this.deriveKeys(mk);
      await this.loadKeystoreFromDisk();
      await this.recordSuccess();
      diag.event('vault_unlocked', { reason: 'biometric' });
      return this.keystore;
    } catch {
      await this.recordFailure();
      throw new VaultError('biometric_failed', 'Biometric unlock did not work. Use your PIN.');
    }
  }

  async enrollBiometric() {
    if (!this.mk) throw new VaultError('locked', 'Unlock the vault first.');
    const support = await biometricAvailability();
    if (!support.available) throw new VaultError('biometric_unavailable', support.reason);

    const salt = randomBytes(32);
    let credential;
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: randomBytes(32),
          rp: { name: 'Duet', id: location.hostname },
          user: {
            id: randomBytes(16),
            name: this.userId,
            displayName: 'Duet'
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          timeout: 60_000,
          attestation: 'none',
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'preferred',
            userVerification: 'required'
          },
          extensions: { prf: {} }
        }
      });
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        throw new VaultError('cancelled', 'Biometric setup was cancelled.');
      }
      throw new VaultError('biometric_failed', 'Biometric setup did not work on this device.');
    }
    if (!credential) throw new VaultError('biometric_failed', 'No biometric credential was created.');

    const credentialId = b64url(new Uint8Array(credential.rawId));
    let assertion;
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          rpId: location.hostname,
          timeout: 60_000,
          userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: new Uint8Array(credential.rawId) }],
          extensions: { prf: { eval: { first: salt } } }
        }
      });
    } catch {
      throw new VaultError('cancelled', 'Biometric setup was cancelled.');
    }
    const prf = prfResult(assertion);
    if (!prf) {
      throw new VaultError('prf_unsupported',
        'This browser does not expose the WebAuthn PRF extension, so biometrics cannot protect the vault. Your PIN still works.');
    }
    const kekBytes = hkdfBytes(prf, salt, utf8('duet:biometric-kek:v1'), 32);
    const kek = await importAesRaw(kekBytes);
    const wrapped = await aesSeal(kek, this.mk, BIOMETRIC_AAD);
    this.meta.biometric = {
      credentialId,
      salt: b64(salt),
      wrapped,
      createdAt: new Date().toISOString()
    };
    await this.saveMeta();
    return true;
  }

  async disableBiometric() {
    if (!this.meta) return;
    this.meta.biometric = null;
    await this.saveMeta();
  }

  async changePin(pin) {
    validatePin(pin);
    if (this.locked) throw new VaultError('locked', 'Unlock the vault first.');
    this.meta.pin = await this.pinWrap(pin);
    await this.saveMeta();
  }

  async regenerateRecovery() {
    if (this.locked) throw new VaultError('locked', 'Unlock the vault first.');
    const secret = generateRecoverySecret();
    this.meta.recovery = await this.recoveryWrap(secret);
    await this.saveMeta();
    await this.persist();
    await this.backupNow();
    return secret;
  }

  async persist() {
    if (!this.keystore || !this.keystoreKey) return;
    this.dirty = true;
    if (this.writing) return;
    this.writing = true;
    try {
      // Set dirty *before* awaiting. If a mutation lands mid-write, the loop
      // runs again instead of silently dropping the newest ratchet state (7.10).
      while (this.dirty) {
        this.dirty = false;
        const blob = await this.sealKeystore();
        await db.dbPut('sealed', sealedKey(this.userId), { blob, updatedAt: Date.now() });
        if (this.meta) {
          this.meta.keystoreUpdatedAt = Date.now();
          await this.saveMeta();
        }
        this.scheduleBackup();
      }
    } finally {
      this.writing = false;
      if (this.dirty) void this.persist();
    }
  }

  scheduleBackup() {
    clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      void this.backupNow().catch(() => {});
    }, 2500);
  }

  async backupNow() {
    if (!this.meta?.recovery || !this.lastSealed) return;
    clearTimeout(this.backupTimer);
    const payload = {
      deviceId: this.meta.deviceId,
      recoverySalt: this.meta.recovery.salt,
      wrappedMk: this.meta.recovery.wrapped,
      keystoreBlob: this.lastSealed,
      keyVersion: 1
    };
    try {
      await api.putVault(payload);
      this.lastBackupAt = Date.now();
      this.lastBackupError = null;
      this.meta.lastBackupAt = new Date().toISOString();
      await this.saveMeta();
    } catch (error) {
      this.lastBackupError = error.message;
      throw error;
    }
  }

  async recover(secret, backup) {
    const normalized = normalizeRecoverySecret(secret);
    if (normalized.length !== 24) {
      throw new VaultError('bad_recovery', 'Recovery keys contain 24 letters and numbers.');
    }
    if (!backup?.recoverySalt || !backup?.wrappedMk || !backup?.keystoreBlob) {
      throw new VaultError('no_backup', 'This account has no encrypted backup to restore.');
    }
    let mk;
    try {
      const params = RECOVERY_SCRYPT;
      const raw = await scryptKey(normalized, unb64(backup.recoverySalt), params);
      const kek = await importAesRaw(raw);
      mk = await aesOpen(kek, backup.wrappedMk, RECOVERY_AAD);
    } catch {
      throw new VaultError('bad_recovery', 'That recovery key does not open this backup.');
    }
    await this.deriveKeys(mk);
    let keystore;
    try {
      keystore = await this.openKeystore(backup.keystoreBlob);
    } catch {
      throw new VaultError('corrupt_backup', 'The encrypted backup is damaged.');
    }
    if (!keystore?.identity || keystore.userId !== this.userId) {
      throw new VaultError('corrupt_backup', 'The backup does not belong to this account.');
    }
    const deviceId = await this.ensureDeviceId();
    keystore.deviceId = deviceId;
    this.keystore = keystore;
    this.lastSealed = backup.keystoreBlob;
    this.meta = {
      version: 1,
      userId: this.userId,
      deviceId,
      createdAt: new Date().toISOString(),
      recoveredAt: new Date().toISOString(),
      pin: null,
      recovery: {
        salt: backup.recoverySalt,
        N: RECOVERY_SCRYPT.N,
        r: RECOVERY_SCRYPT.r,
        p: RECOVERY_SCRYPT.p,
        dkLen: RECOVERY_SCRYPT.dkLen,
        wrapped: backup.wrappedMk
      },
      biometric: null,
      failedAttempts: 0,
      lockedUntil: 0,
      keyVersion: backup.keyVersion || 1
    };
    this.pendingRecovery = true;
    await this.persist();
    diag.event('vault_recovered', { reason: 'recovery_key' });
    return this.keystore;
  }

  async finishRecovery(pin, { biometric = false } = {}) {
    if (this.locked || !this.pendingRecovery) {
      throw new VaultError('not_recovering', 'There is no recovery in progress.');
    }
    validatePin(pin);
    this.meta.pin = await this.pinWrap(pin);
    this.pendingRecovery = false;
    let biometricError = null;
    if (biometric) {
      try {
        await this.enrollBiometric();
      } catch (error) {
        biometricError = error.message;
      }
    }
    await this.saveMeta();
    await this.persist();
    const backupError = await this.backupNow().catch((error) => error.message);
    return {
      biometricEnabled: Boolean(this.meta.biometric),
      biometricError,
      backupError
    };
  }

  async writeCache(messageId, payload) {
    if (!this.cacheKey) return;
    try {
      const sealed = await aesSeal(
        this.cacheKey,
        utf8(JSON.stringify(payload)),
        CACHE_AAD
      );
      await db.dbPut('cache', cacheKeyFor(this.userId, messageId), {
        blob: sealed, at: Date.now()
      });
    } catch {
      // The cache is an optimisation; never let it break a message.
    }
  }

  async readCache(messageId) {
    if (!this.cacheKey) return null;
    try {
      const row = await db.dbGet('cache', cacheKeyFor(this.userId, messageId));
      if (!row?.blob) return null;
      const bytes = await aesOpen(this.cacheKey, row.blob, CACHE_AAD);
      return JSON.parse(fromUtf8(bytes));
    } catch {
      return null;
    }
  }

  async deleteCache(messageId) {
    await db.dbDelete('cache', cacheKeyFor(this.userId, messageId));
  }

  async clearMessageCache() {
    await db.dbDeletePrefix('cache', `cache:${this.userId}:`);
  }

  async writeOutbox(clientId, payload) {
    if (!this.cacheKey) return;
    const sealed = await aesSeal(
      this.cacheKey,
      utf8(JSON.stringify(payload)),
      OUTBOX_AAD
    );
    await db.dbPut('kv', outboxKey(this.userId, clientId), {
      blob: sealed, at: Date.now()
    });
  }

  async listOutbox() {
    if (!this.cacheKey) return [];
    const entries = await db.dbEntries('kv', `outbox:${this.userId}:`);
    const out = [];
    for (const [key, row] of entries) {
      try {
        const bytes = await aesOpen(this.cacheKey, row.blob, OUTBOX_AAD);
        const parsed = JSON.parse(fromUtf8(bytes));
        if (parsed?.row?.clientId) out.push(parsed);
        else await db.dbDelete('kv', key);
      } catch {
        await db.dbDelete('kv', key);
      }
    }
    return out.sort((a, b) =>
      String(a.row.createdAt || '').localeCompare(String(b.row.createdAt || '')));
  }

  async deleteOutbox(clientId) {
    await db.dbDelete('kv', outboxKey(this.userId, clientId));
  }

  async clearOutbox() {
    await db.dbDeletePrefix('kv', `outbox:${this.userId}:`);
  }

  async writeMediaCache(mediaId, bytes, mime) {
    if (!this.mediaKey) return;
    if (bytes.length > 8 * 1024 * 1024) return;
    try {
      const sealed = await aesSeal(this.mediaKey, bytes, MEDIA_AAD);
      await db.dbPut('media', mediaKeyFor(this.userId, mediaId), {
        blob: sealed, mime, size: bytes.length, at: Date.now()
      });
    } catch { /* optional */ }
  }

  async readMediaCache(mediaId) {
    if (!this.mediaKey) return null;
    try {
      const row = await db.dbGet('media', mediaKeyFor(this.userId, mediaId));
      if (!row?.blob) return null;
      const bytes = await aesOpen(this.mediaKey, row.blob, MEDIA_AAD);
      return { bytes, mime: row.mime || 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async clearMediaCache() {
    await db.dbDeletePrefix('media', `media:${this.userId}:`);
  }

  async lock() {
    if (this.keystore) {
      try { await this.persist(); } catch { /* best effort */ }
      if (this.lastSealed && this.meta?.recovery) {
        try { await this.backupNow(); } catch { /* offline is normal */ }
      }
    }
    if (this.mk) this.mk.fill(0);
    this.mk = null;
    this.keystoreKey = null;
    this.cacheKey = null;
    this.mediaKey = null;
    this.keystore = null;
    forgetDerivedKeys();
    try { diag.event('vault_locked', {}); } catch { /* ignore */ }
    this.onLock?.();
  }

  async destroyLocal() {
    this.lock();
    await db.dbDelete('kv', metaKey(this.userId));
    await db.dbDelete('kv', `device:${this.userId}`);
    await db.dbDelete('sealed', sealedKey(this.userId));
    await db.dbDeletePrefix('cache', `cache:${this.userId}:`);
    await db.dbDeletePrefix('media', `media:${this.userId}:`);
    await db.dbDeletePrefix('kv', `outbox:${this.userId}:`);
  }
}

export { normalizeRecoverySecret, concat };
