import {
  ed25519, x25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub
} from '/vendor/noble/curves/ed25519.js';
import { xchacha20poly1305 } from '/vendor/noble/ciphers/chacha.js';
import { scryptAsync } from '/vendor/noble/hashes/scrypt.js';
import { hkdf } from '/vendor/noble/hashes/hkdf.js';
import { hmac } from '/vendor/noble/hashes/hmac.js';
import { sha256 } from '/vendor/noble/hashes/sha2.js';

export const PIN_SCRYPT = { N: 16384, r: 8, p: 1, dkLen: 32, asyncTick: 10 };
export const RECOVERY_SCRYPT = { N: 32768, r: 8, p: 1, dkLen: 32, asyncTick: 10 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value) { return encoder.encode(String(value)); }
export function fromUtf8(bytes) { return decoder.decode(bytes); }

export function randomBytes(length) {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function concat(...parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function b64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function unb64(value) {
  const binary = atob(String(value));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return unb64(padded + '='.repeat((4 - padded.length % 4) % 4));
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function unhex(value) {
  const text = String(value);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

export function readU32(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export function sha256Bytes(bytes) {
  return sha256(bytes);
}

export function hmacSha256(key, data) {
  return hmac(sha256, key, data);
}

export function hkdfBytes(ikm, salt, info, length = 32) {
  return hkdf(sha256, ikm, salt, info, length);
}

export async function scryptKey(password, salt, params = PIN_SCRYPT) {
  return scryptAsync(utf8(password), salt, params);
}

/* ---- identity + X3DH primitives ----------------------------------------- */

export function generateIdentity() {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv: hex(priv), pub: b64(pub) };
}

export function generateX25519() {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { priv: b64(priv), pub: b64(pub) };
}

export function x25519Shared(privB64, pubB64) {
  return x25519.getSharedSecret(unb64(privB64), unb64(pubB64));
}

export function identityToX25519(identity) {
  return {
    priv: b64(edwardsToMontgomeryPriv(unhex(identity.priv))),
    pub: b64(edwardsToMontgomeryPub(unb64(identity.pub)))
  };
}

export function identityPubToX25519(identityKeyB64) {
  return b64(edwardsToMontgomeryPub(unb64(identityKeyB64)));
}

export function signedPreKeyMessage(preKey) {
  return concat(utf8('duet-signed-prekey-v1'), unb64(preKey.pub), u32(preKey.id));
}

export function signSignedPreKey(identity, preKey) {
  return b64(ed25519.sign(signedPreKeyMessage(preKey), unhex(identity.priv)));
}

export function verifySignedPreKey(identityKeyB64, signedPreKey) {
  try {
    return ed25519.verify(
      unb64(signedPreKey.signature),
      signedPreKeyMessage({
        id: signedPreKey.id,
        pub: signedPreKey.publicKey
      }),
      unb64(identityKeyB64)
    );
  } catch {
    return false;
  }
}

export function sessionInitAuthMessage(x3dh) {
  return concat(
    utf8('duet-x3dh-auth-v1'),
    unb64(x3dh.generation),
    unb64(x3dh.ephemeralPublicKey),
    unb64(x3dh.initiatorIdentityKey),
    u32(x3dh.signedPreKeyId >>> 0),
    u32((x3dh.usedOneTimePreKeyId || 0) >>> 0)
  );
}

export function signSessionInit(identity, x3dh) {
  return b64(ed25519.sign(sessionInitAuthMessage(x3dh), unhex(identity.priv)));
}

export function verifySessionInit(x3dh) {
  try {
    return ed25519.verify(
      unb64(x3dh.authTag),
      sessionInitAuthMessage(x3dh),
      unb64(x3dh.initiatorIdentityKey)
    );
  } catch {
    return false;
  }
}

export function x3dhSecret(parts) {
  return hkdfBytes(
    concat(new Uint8Array(32).fill(0xff), ...parts),
    new Uint8Array(32),
    utf8('DuetX3DHv1'),
    32
  );
}

export function x3dhAd(initiatorEd, responderEd, generationB64) {
  return b64(concat(
    utf8('DuetX3DH-ad-v1'),
    unb64(initiatorEd),
    unb64(responderEd),
    unb64(generationB64)
  ));
}

/* ---- ratchet KDFs -------------------------------------------------------- */

export function kdfRoot(rootKeyB64, dhOut) {
  const out = hkdfBytes(dhOut, unb64(rootKeyB64), utf8('DuetRatchetRoot'), 64);
  return {
    rootKey: b64(out.slice(0, 32)),
    chainKey: b64(out.slice(32, 64))
  };
}

export function kdfChain(chainKeyB64) {
  const chain = unb64(chainKeyB64);
  return {
    messageKey: b64(hmacSha256(chain, Uint8Array.of(1))),
    chainKey: b64(hmacSha256(chain, Uint8Array.of(2)))
  };
}

/* ---- AEAD ---------------------------------------------------------------- */

export function aeadSeal(keyB64, plaintextBytes, aadBytes) {
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(unb64(keyB64), nonce, aadBytes);
  const ciphertext = cipher.encrypt(plaintextBytes);
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
}

export function aeadOpen(keyB64, ciphertextB64, nonceB64, aadBytes) {
  const cipher = xchacha20poly1305(unb64(keyB64), unb64(nonceB64), aadBytes);
  return cipher.decrypt(unb64(ciphertextB64));
}

export function encryptMedia(bytes, keyB64) {
  return aeadSeal(keyB64, bytes, utf8('duet-media-v1'));
}

export function decryptMedia(ciphertextBytes, keyB64, nonceB64) {
  const cipher = xchacha20poly1305(unb64(keyB64), unb64(nonceB64), utf8('duet-media-v1'));
  return cipher.decrypt(ciphertextBytes);
}

/* ---- WebCrypto AES-GCM for the vault and local cache --------------------- */

let cryptoKeyCache = new Map();

async function importAes(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function importAesRaw(rawKey) {
  return importAes(rawKey);
}

export async function deriveVaultKey(mk, info) {
  const raw = hkdfBytes(mk, utf8('duet-v1'), utf8(info), 32);
  const cacheKey = `${info}:${b64(raw)}`;
  let key = cryptoKeyCache.get(cacheKey);
  if (!key) {
    key = await importAes(raw);
    cryptoKeyCache.set(cacheKey, key);
  }
  return key;
}

export async function aesSeal(key, plaintextBytes, aad) {
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 },
    key,
    plaintextBytes
  ));
  return b64(concat(iv, ciphertext));
}

export async function aesOpen(key, sealedB64, aad) {
  const sealed = unb64(sealedB64);
  if (sealed.length < 13) throw new Error('sealed value too short');
  const iv = sealed.slice(0, 12);
  const ciphertext = sealed.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

export function forgetDerivedKeys() {
  cryptoKeyCache = new Map();
}

/* ---- recovery secrets ---------------------------------------------------- */

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoverySecret() {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += BASE32[bytes[i] % 32];
  return out.match(/.{1,4}/g).join('-');
}

export function normalizeRecoverySecret(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function recoveryGroups(secret) {
  return normalizeRecoverySecret(secret).match(/.{1,4}/g)?.join('-') || '';
}
