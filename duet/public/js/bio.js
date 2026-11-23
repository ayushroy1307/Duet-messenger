// Biometric unlock through the WebAuthn PRF extension. Biometrics alone prove presence and give the
// app no secret; the PRF output is a stable per-credential secret that becomes the biometric KEK.
import { enc, rand } from './util.js';

const PRF_SALT = enc.encode('duet-vault-prf-v1');
const rpId = () => location.hostname;

export async function bioAvailable() {
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

async function prfGet(credId) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), rpId: rpId(), userVerification: 'required', timeout: 60000,
    allowCredentials: credId ? [{ type: 'public-key', id: credId }] : [],
    extensions: { prf: { eval: { first: PRF_SALT } } },
  } });
  const first = a.getClientExtensionResults().prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/** Returns { credentialId, prf } or throws Error('unsupported'|...). */
export async function createBioCredential(userId, label) {
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Duet', id: rpId() },
    user: { id: enc.encode(userId.slice(0, 32)), name: label || 'Duet vault', displayName: 'Duet vault' },
    challenge: rand(32), timeout: 60000,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    extensions: { prf: { eval: { first: PRF_SALT } } },
  } });
  const ext = cred.getClientExtensionResults();
  if (!ext.prf || (!ext.prf.enabled && !ext.prf.results)) throw new Error('unsupported');
  let prf = ext.prf.results?.first ? new Uint8Array(ext.prf.results.first) : null;
  if (!prf) prf = await prfGet(cred.rawId); // many authenticators only return the secret on get()
  if (!prf) throw new Error('unsupported');
  return { credentialId: btoa(String.fromCharCode(...new Uint8Array(cred.rawId))), prf };
}
export async function bioUnlockSecret(credentialIdB64) {
  const id = Uint8Array.from(atob(credentialIdB64), (c) => c.charCodeAt(0));
  const prf = await prfGet(id);
  if (!prf) throw new Error('unsupported');
  return prf;
}
