import crypto from 'node:crypto';
import { config } from './config.js';

const webcrypto = crypto.webcrypto;
const encoder = new TextEncoder();

function b64urlToBuf(value) {
  return Buffer.from(String(value), 'base64url');
}

function bufToB64url(value) {
  return Buffer.from(value).toString('base64url');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function hkdfExpand(prk, info, length) {
  const blocks = Math.ceil(length / 32);
  const chunks = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    previous = hmac(prk, Buffer.concat([previous, Buffer.from(info), Buffer.from([i])]));
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function vapidKeyPair() {
  if (!config.push.publicKey || !config.push.privateKey) return null;
  try {
    const pub = b64urlToBuf(config.push.publicKey);
    const d = b64urlToBuf(config.push.privateKey);
    if (pub.length !== 65 || pub[0] !== 0x04 || d.length !== 32) return null;
    const x = bufToB64url(pub.subarray(1, 33));
    const y = bufToB64url(pub.subarray(33, 65));
    const privateKey = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', x, y, d: bufToB64url(d) },
      format: 'jwk'
    });
    return {
      publicKey: config.push.publicKey,
      privateKey,
      publicRaw: pub
    };
  } catch {
    return null;
  }
}

let vapidCache;
function getVapid() {
  if (vapidCache === undefined) vapidCache = vapidKeyPair();
  return vapidCache;
}

function makeVapidJwt(audience) {
  const vapid = getVapid();
  if (!vapid) throw new Error('VAPID keys are not configured');
  const header = bufToB64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = bufToB64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: config.push.subject
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), {
    key: vapid.privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${unsigned}.${bufToB64url(signature)}`;
}

async function encryptPayload(subscription, payloadBuffer) {
  const uaPublicRaw = b64urlToBuf(subscription.p256dh);
  const authSecret = b64urlToBuf(subscription.auth);
  if (uaPublicRaw.length !== 65) throw new Error('Invalid push subscription key');

  const ephemeral = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const uaPublic = await webcrypto.subtle.importKey(
    'raw',
    uaPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = Buffer.from(await webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublic },
    ephemeral.privateKey,
    256
  ));
  const asPublicRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));

  // RFC 8291
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info'), Buffer.from([0]), uaPublicRaw, asPublicRaw
  ]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);
  asPublicRaw.copy(header, 21);

  const padded = Buffer.concat([payloadBuffer, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, encrypted]);
}

async function sendOne(subscription, payloadBuffer) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = makeVapidJwt(audience);
  const body = await encryptPayload(subscription, payloadBuffer);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'normal',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: `vapid t=${jwt},k=${config.push.publicKey}`
    },
    body
  });
  if (!res.ok && res.status !== 201) {
    const err = new Error(`Push endpoint rejected the message (${res.status})`);
    err.status = res.status;
    throw err;
  }
}

export function pushEnabled() {
  return Boolean(getVapid());
}

export function publicVapidKey() {
  return pushEnabled() ? config.push.publicKey : null;
}

/**
 * Push payloads are intentionally opaque: generic, encrypted, and small.
 * The push service learns only that *a message* exists. Notification text is
 * rendered by the service worker and never contains message content.
 */
export async function notifyUser(store, userId, { title = 'Duet', body = 'New message' } = {}) {
  if (!pushEnabled()) return { sent: 0 };
  const subscriptions = await store.listPushSubscriptions(userId);
  if (!subscriptions?.length) return { sent: 0 };

  // Keep the payload content-free. Title/body defaults are used by the worker.
  const payload = Buffer.from(JSON.stringify({ t: 'm', v: 1, n: title, b: body }), 'utf8');
  let sent = 0;
  await Promise.allSettled(subscriptions.map(async (sub) => {
    try {
      await sendOne(sub, payload);
      sent += 1;
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        await store.removePushSubscription(userId, sub.endpoint);
      } else {
        console.warn('push delivery failed', error.message);
      }
    }
  }));
  return { sent };
}
