// Duet cryptography: X3DH key agreement + Double Ratchet, on WebCrypto only.
//
// Suite: X25519 (DH) · Ed25519 (identity signatures) · HKDF-SHA256 / HMAC-SHA256
//        · AES-256-GCM (message AEAD).
// Runs unchanged in browsers and in Node >= 20 (used by the test-suite).
import { enc, b64, unb64, concat, rand, ctEq, CryptoError, clone } from './util.js';

const subtle = globalThis.crypto.subtle;
const MAX_SKIP = 1000;
const MAX_SKIPPED_STORED = 2000;
const ZERO32 = new Uint8Array(32);

// ---------------------------------------------------------------- primitives
const keyCache = new Map();
export function clearCryptoCaches() { keyCache.clear(); }

async function importPriv(pkcs8B64, alg, usages) {
  const k = alg + ':' + pkcs8B64;
  let key = keyCache.get(k);
  if (!key) {
    key = await subtle.importKey('pkcs8', unb64(pkcs8B64), { name: alg }, false, usages);
    keyCache.set(k, key);
  }
  return key;
}
async function importPub(rawB64, alg) {
  const k = 'pub:' + alg + ':' + rawB64;
  let key = keyCache.get(k);
  if (!key) {
    key = await subtle.importKey('raw', unb64(rawB64), { name: alg }, true, alg === 'Ed25519' ? ['verify'] : []);
    keyCache.set(k, key);
  }
  return key;
}

export async function genX25519() {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    pub: b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))),
    priv: b64(new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))),
  };
}
export async function genEd25519() {
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    pub: b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))),
    priv: b64(new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))),
  };
}
async function dh(privB64, pubB64) {
  const priv = await importPriv(privB64, 'X25519', ['deriveBits']);
  const pub = await importPub(pubB64, 'X25519');
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256));
}
async function edSign(privB64, data) {
  const key = await importPriv(privB64, 'Ed25519', ['sign']);
  return new Uint8Array(await subtle.sign('Ed25519', key, data));
}
async function edVerify(pubB64, sig, data) {
  const key = await importPub(pubB64, 'Ed25519');
  return subtle.verify('Ed25519', key, sig, data); // resolves to a boolean
}
export async function hkdf(ikm, salt, info, len = 32) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? enc.encode(info) : info }, base, len * 8));
}
export async function hmac(keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}
export async function sha256(data) {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}
async function aeadKey(mk) {
  const raw = await hkdf(mk, ZERO32, 'duet-msg-key', 32);
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function aeadSeal(mk, plaintext, aad) {
  const nonce = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await aeadKey(mk), plaintext));
  return { nonce, ct };
}
async function aeadOpen(mk, nonce, ct, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await aeadKey(mk), ct));
}

// ------------------------------------------------------------- identity/keys
/** Identity = Ed25519 signing key + X25519 DH key (WebCrypto cannot convert between the two). */
export async function createIdentity() {
  return { sign: await genEd25519(), dh: await genX25519() };
}

const spkMessage = (spkPubB64, identityDhPubB64) => concat(enc.encode('duet-spk-v1'), unb64(spkPubB64), unb64(identityDhPubB64));

export async function createSignedPrekey(identity, id) {
  const kp = await genX25519();
  return { id, pub: kp.pub, priv: kp.priv, createdAt: Date.now() };
}
/** Signatures are deterministic and depend only on our own keys, so we can always regenerate (7.11). */
export async function signPrekey(identity, spk) {
  return b64(await edSign(identity.sign.priv, spkMessage(spk.pub, identity.dh.pub)));
}
export async function createOneTimePrekeys(startId, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ id: startId + i, ...(await genX25519()) });
  return out;
}

/** Public bundle: nothing secret. */
export async function buildBundle(identity, spk, otks) {
  return {
    identity: { sign: identity.sign.pub, dh: identity.dh.pub },
    spk: { id: spk.id, pub: spk.pub, sig: await signPrekey(identity, spk) },
    otks: (otks || []).map((o) => ({ id: o.id, pub: o.pub })),
  };
}
/** Always await: resolves to a boolean (the classic `if (!verify(...))` bug never ran). */
export async function verifyBundle(bundle) {
  try {
    if (!bundle || !bundle.identity || !bundle.spk || !bundle.spk.sig) return false;
    return (await edVerify(bundle.identity.sign, unb64(bundle.spk.sig), spkMessage(bundle.spk.pub, bundle.identity.dh))) === true;
  } catch { return false; }
}

export async function fingerprint(identity) {
  const h = await sha256(concat(unb64(identity.sign), unb64(identity.dh)));
  return Array.from(h.subarray(0, 15), (x) => x.toString(16).padStart(2, '0')).join('').match(/.{1,5}/g).join(' ');
}
/** Same string on both devices once both hold each other's identity. */
export async function safetyNumber(a, b) {
  const [x, y] = [a.sign + a.dh, b.sign + b.dh].sort();
  const h = await sha256(enc.encode('duet-safety|' + x + '|' + y));
  let digits = '';
  for (let i = 0; i < 12; i++) digits += String((h[i * 2] * 256 + h[i * 2 + 1]) % 100000).padStart(5, '0');
  return digits.match(/.{1,5}/g).join(' ');
}

// -------------------------------------------------------------------- X3DH
const F = new Uint8Array(32).fill(0xff);

/**
 * Initiator side. Consumes (at most) one one-time prekey, verifies the bundle.
 * Returns the ratchet state and the SessionInit envelope to attach to a message.
 */
export async function x3dhInitiate(selfIdentity, peerBundle) {
  if (!(await verifyBundle(peerBundle))) throw new CryptoError('bad-bundle', 'Peer bundle signature did not verify');
  const ek = await genX25519();
  const spkPub = peerBundle.spk.pub;
  const otk = peerBundle.otk || null; // empty pool is normal: degrade to 3-DH
  const parts = [F,
    await dh(selfIdentity.dh.priv, spkPub),
    await dh(ek.priv, peerBundle.identity.dh),
    await dh(ek.priv, spkPub)];
  if (otk) parts.push(await dh(ek.priv, otk.pub));
  const sk = await hkdf(concat(...parts), ZERO32, 'duet-x3dh-v1', 32);
  const generation = b64(rand(12));
  const ad = concat(unb64(selfIdentity.dh.pub), unb64(peerBundle.identity.dh));
  const authTag = b64(await hmac(sk, enc.encode('duet-auth|' + generation + '|' + ek.pub)));
  const ratchet = await initRatchetInitiator(sk, spkPub, ad);
  return {
    ratchet, generation,
    peerIdentity: peerBundle.identity,
    envelope: {
      generation,
      ephemeralPublicKey: ek.pub,
      initiatorIdentityKey: { sign: selfIdentity.sign.pub, dh: selfIdentity.dh.pub },
      signedPreKeyId: peerBundle.spk.id,
      usedOneTimePreKeyId: otk ? otk.id : null,
      authTag,
    },
  };
}

/**
 * Responder side. Pure: does not mutate the keystore; returns which OTK to retire.
 * Throws CryptoError('otk-missing') when the named one-time prekey is gone (7.5/7.9):
 * never silently skipped, because the initiator folded it into its transcript.
 */
export async function x3dhRespond(keystore, env) {
  const spk = (keystore.spks || []).find((s) => s.id === env.signedPreKeyId) || keystore.spks?.[keystore.spks.length - 1];
  if (!spk) throw new CryptoError('spk-missing', 'No signed prekey');
  let otk = null;
  if (env.usedOneTimePreKeyId !== null && env.usedOneTimePreKeyId !== undefined) {
    otk = (keystore.otks || []).find((o) => o.id === env.usedOneTimePreKeyId);
    if (!otk) throw new CryptoError('otk-missing', 'One-time prekey ' + env.usedOneTimePreKeyId + ' is no longer held');
  }
  const ik = keystore.identity;
  const parts = [F,
    await dh(spk.priv, env.initiatorIdentityKey.dh),
    await dh(ik.dh.priv, env.ephemeralPublicKey),
    await dh(spk.priv, env.ephemeralPublicKey)];
  if (otk) parts.push(await dh(otk.priv, env.ephemeralPublicKey));
  const sk = await hkdf(concat(...parts), ZERO32, 'duet-x3dh-v1', 32);
  const expect = await hmac(sk, enc.encode('duet-auth|' + env.generation + '|' + env.ephemeralPublicKey));
  if (!ctEq(expect, unb64(env.authTag))) throw new CryptoError('auth-failed', 'Handshake authentication tag mismatch');
  const ad = concat(unb64(env.initiatorIdentityKey.dh), unb64(ik.dh.pub));
  return {
    ratchet: initRatchetResponder(sk, spk, ad),
    consumedOtkId: otk ? otk.id : null,
    peerIdentity: env.initiatorIdentityKey,
  };
}

// ----------------------------------------------------------- Double Ratchet
async function kdfRK(rk, dhOut) {
  const out = await hkdf(dhOut, rk, 'duet-rk', 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}
async function kdfCK(ck) {
  return [await hmac(ck, new Uint8Array([2])), await hmac(ck, new Uint8Array([1]))]; // [nextCK, messageKey]
}

async function initRatchetInitiator(sk, peerSpkPub, ad) {
  const dhs = await genX25519();
  const [rk, cks] = await kdfRK(sk, await dh(dhs.priv, peerSpkPub));
  return { dhs, dhr: peerSpkPub, rk: b64(rk), cks: b64(cks), ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad: b64(ad) };
}
function initRatchetResponder(sk, spk, ad) {
  return { dhs: { pub: spk.pub, priv: spk.priv }, dhr: null, rk: b64(sk), cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: {}, ad: b64(ad) };
}
export function canSend(state) { return !!state.cks; }

/** Mutates `state` (a plain JSON object) and returns the wire envelope (without x3dh). */
export async function ratchetEncrypt(state, plaintext) {
  if (!state.cks) throw new CryptoError('no-send-chain', 'Waiting for the first message from the peer');
  const [ck, mk] = await kdfCK(unb64(state.cks));
  state.cks = b64(ck);
  const header = { dh: state.dhs.pub, n: state.ns, pn: state.pn };
  state.ns += 1;
  const aad = concat(unb64(state.ad), enc.encode(JSON.stringify(header)));
  const { nonce, ct } = await aeadSeal(mk, plaintext, aad);
  return { v: 1, header, ciphertext: b64(ct), nonce: b64(nonce) };
}

async function skipKeys(state, until) {
  if (!state.ckr) return;
  if (until - state.nr > MAX_SKIP) throw new CryptoError('too-many-skipped', 'Too many skipped messages');
  let ck = unb64(state.ckr);
  while (state.nr < until) {
    const [next, mk] = await kdfCK(ck);
    state.skipped[state.dhr + ':' + state.nr] = b64(mk);
    ck = next;
    state.nr += 1;
  }
  state.ckr = b64(ck);
  const keys = Object.keys(state.skipped);
  if (keys.length > MAX_SKIPPED_STORED) for (const k of keys.slice(0, keys.length - MAX_SKIPPED_STORED)) delete state.skipped[k];
}

/**
 * Decrypts on a COPY of the state and returns { plaintext, state } — a failed
 * decrypt must never advance or corrupt the live chain.
 */
export async function ratchetDecrypt(live, envelope) {
  const state = clone(live);
  const { header } = envelope;
  const aad = concat(unb64(state.ad), enc.encode(JSON.stringify(header)));
  const nonce = unb64(envelope.nonce);
  const ct = unb64(envelope.ciphertext);
  const skKey = header.dh + ':' + header.n;
  if (state.skipped[skKey]) {
    const mk = unb64(state.skipped[skKey]);
    const plaintext = await aeadOpen(mk, nonce, ct, aad);
    delete state.skipped[skKey];
    return { plaintext, state };
  }
  if (header.dh !== state.dhr) {
    await skipKeys(state, header.pn);
    state.pn = state.ns; state.ns = 0; state.nr = 0;
    state.dhr = header.dh;
    const [rk1, ckr] = await kdfRK(unb64(state.rk), await dh(state.dhs.priv, state.dhr));
    state.ckr = b64(ckr);
    state.dhs = await genX25519();
    const [rk2, cks] = await kdfRK(rk1, await dh(state.dhs.priv, state.dhr));
    state.rk = b64(rk2); state.cks = b64(cks);
  }
  await skipKeys(state, header.n);
  const [ck, mk] = await kdfCK(unb64(state.ckr));
  state.ckr = b64(ck); state.nr += 1;
  const plaintext = await aeadOpen(mk, nonce, ct, aad);
  return { plaintext, state };
}

// ------------------------------------------------------------- media crypto
/** Per-file key; blob = iv(12) || AES-GCM ciphertext. The key travels inside an E2EE message. */
export async function encryptBlob(bytes) {
  const raw = rand(32);
  const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { key: b64(raw), blob: concat(iv, ct) };
}
export async function decryptBlob(keyB64, blob) {
  const key = await subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, key, blob.subarray(12)));
}
