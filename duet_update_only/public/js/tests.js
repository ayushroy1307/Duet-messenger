import {
  aeadOpen,
  aeadSeal,
  b64,
  decryptMedia,
  encryptMedia,
  generateIdentity,
  generateX25519,
  identityToX25519,
  importAesRaw,
  aesOpen,
  aesSeal,
  kdfChain,
  kdfRoot,
  normalizeRecoverySecret,
  randomBytes,
  signSessionInit,
  signSignedPreKey,
  utf8,
  verifySessionInit,
  verifySignedPreKey,
  x25519Shared,
  x3dhSecret
} from './crypto.js';
import { DuetEngine, createKeystore } from './engine.js';
import { api } from './api.js';

const tests = [];
const test = (name, fn, detail = '') => tests.push({ name, fn, detail });

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}

function equalBytes(a, b, message = 'byte arrays differ') {
  if (a.length !== b.length) throw new Error(`${message} (length ${a.length} vs ${b.length})`);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) throw new Error(`${message} at byte ${i}`);
  }
}

/* -------------------------------------------------------------------------- */
/* AEAD                                                                       */
/* -------------------------------------------------------------------------- */

test('AEAD: XChaCha20-Poly1305 round-trips text', () => {
  const key = b64(randomBytes(32));
  const plaintext = utf8('Duet keeps a conversation private, even from its own server.');
  const aad = utf8('duet-test-aad');
  const sealed = aeadSeal(key, plaintext, aad);
  const opened = aeadOpen(key, sealed.ciphertext, sealed.nonce, aad);
  equalBytes(opened, plaintext);
});

test('AEAD: a different AAD fails authentication', () => {
  const key = b64(randomBytes(32));
  const sealed = aeadSeal(key, utf8('secret'), utf8('aad-a'));
  let failed = false;
  try {
    aeadOpen(key, sealed.ciphertext, sealed.nonce, utf8('aad-b'));
  } catch {
    failed = true;
  }
  assert(failed, 'decryption with the wrong AAD should throw');
});

test('AEAD: a tampered ciphertext fails authentication', () => {
  const key = b64(randomBytes(32));
  const sealed = aeadSeal(key, utf8('secret'), utf8('aad'));
  const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
  bytes[0] ^= 0x01;
  let failed = false;
  try {
    aeadOpen(key, b64(bytes), sealed.nonce, utf8('aad'));
  } catch {
    failed = true;
  }
  assert(failed, 'a modified ciphertext should throw');
});

/* -------------------------------------------------------------------------- */
/* X3DH                                                                       */
/* -------------------------------------------------------------------------- */

test('X3DH: both parties derive the same shared secret', () => {
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const aliceX = identityToX25519(aliceIdentity);
  const bobX = identityToX25519(bobIdentity);
  const signedPreKey = generateX25519();
  const oneTimePreKey = generateX25519();
  const ephemeral = generateX25519();

  // Alice: EK_A × (IK_B, SPK_B, OPK_B), IK_A × SPK_B.
  const aliceParts = [
    x25519Shared(ephemeral.priv, bobX.pub),
    x25519Shared(aliceX.priv, signedPreKey.pub),
    x25519Shared(ephemeral.priv, signedPreKey.pub),
    x25519Shared(ephemeral.priv, oneTimePreKey.pub)
  ];
  // Bob: IK_B × EK_A, SPK_B × IK_A, SPK_B × EK_A, OPK_B × EK_A.
  const bobParts = [
    x25519Shared(bobX.priv, ephemeral.pub),
    x25519Shared(signedPreKey.priv, aliceX.pub),
    x25519Shared(signedPreKey.priv, ephemeral.pub),
    x25519Shared(oneTimePreKey.priv, ephemeral.pub)
  ];

  const aliceSecret = x3dhSecret(aliceParts);
  const bobSecret = x3dhSecret(bobParts);
  equalBytes(aliceSecret, bobSecret, 'X3DH outputs differ');
  assert(aliceSecret.length === 32, 'X3DH secret must be 32 bytes');
});

test('X3DH: signed prekey verifies and tampering is rejected', () => {
  const identity = generateIdentity();
  const preKey = { ...generateX25519(), id: 4242 };
  const signature = signSignedPreKey(identity, preKey);
  const signed = { id: preKey.id, publicKey: preKey.pub, signature };
  assert(verifySignedPreKey(identity.pub, signed), 'valid signed prekey should verify');

  const tampered = { ...signed, publicKey: generateX25519().pub };
  assert(!verifySignedPreKey(identity.pub, tampered), 'tampered signed prekey must not verify');
  assert(!verifySignedPreKey(generateIdentity().pub, signed), 'another identity must not verify');
});

test('X3DH: session initialisation signature binds the transcript', () => {
  const identity = generateIdentity();
  const x3dh = {
    generation: b64(randomBytes(16)),
    ephemeralPublicKey: generateX25519().pub,
    initiatorIdentityKey: identity.pub,
    signedPreKeyId: 11,
    usedOneTimePreKeyId: 22
  };
  x3dh.authTag = signSessionInit(identity, x3dh);
  assert(verifySessionInit(x3dh), 'session init signature should verify');

  const changed = { ...x3dh, ephemeralPublicKey: generateX25519().pub };
  assert(!verifySessionInit(changed), 'a changed ephemeral key must fail verification');
});

/* -------------------------------------------------------------------------- */
/* Ratchet                                                                    */
/* -------------------------------------------------------------------------- */

test('Ratchet: chain keys advance and never repeat', () => {
  const start = b64(randomBytes(32));
  const first = kdfChain(start);
  const second = kdfChain(first.chainKey);
  assert(first.chainKey !== start, 'chain key did not advance');
  assert(second.chainKey !== first.chainKey, 'second chain key repeated');
  assert(first.messageKey !== second.messageKey, 'message keys repeated');
  const again = kdfChain(start);
  assert(again.chainKey === first.chainKey && again.messageKey === first.messageKey, 'KDF is not deterministic');
});

test('Ratchet: root KDF separates root and chain keys', () => {
  const root = b64(randomBytes(32));
  const dh = randomBytes(32);
  const out = kdfRoot(root, dh);
  assert(out.rootKey !== root, 'root key was not replaced');
  assert(out.rootKey !== out.chainKey, 'root and chain keys must differ');
  const repeat = kdfRoot(root, dh);
  assert(repeat.rootKey === out.rootKey && repeat.chainKey === out.chainKey, 'root KDF is not deterministic');
});

/* -------------------------------------------------------------------------- */
/* Media + vault primitives                                                   */
/* -------------------------------------------------------------------------- */

test('Media: encrypted attachment round-trips byte-for-byte', () => {
  const bytes = randomBytes(4096);
  const key = b64(randomBytes(32));
  const sealed = encryptMedia(bytes, key);
  const opened = decryptMedia(
    Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0)),
    key,
    sealed.nonce
  );
  equalBytes(opened, bytes);
});

test('Vault: AES-GCM seals and opens with bound AAD', async () => {
  const key = await importAesRaw(randomBytes(32));
  const plaintext = utf8('vault keystore');
  const sealed = await aesSeal(key, plaintext, 'duet:vault:keystore:v1');
  const opened = await aesOpen(key, sealed, 'duet:vault:keystore:v1');
  equalBytes(opened, plaintext);

  let failed = false;
  try {
    await aesOpen(key, sealed, 'duet:vault:cache:v1');
  } catch {
    failed = true;
  }
  assert(failed, 'wrong AAD should fail AES-GCM authentication');
});

test('Recovery keys: ambiguous characters normalise to one alphabet', () => {
  const normalized = normalizeRecoverySecret('abcd-efgh-ijkl-mnop-qrst-uvwx');
  assert(/^[0-9A-HJKMNP-TV-Z]{24}$/.test(normalized), 'recovery alphabet must exclude I, L, O, U');
  assert(normalizeRecoverySecret('OOOO') === '0000', 'O should normalise to zero');
  assert(normalizeRecoverySecret('iL1') === '111', 'I and L should normalise to one');
});

/* -------------------------------------------------------------------------- */
/* Engine idempotency                                                         */
/* -------------------------------------------------------------------------- */

function fakeEngine() {
  const keystore = createKeystore({ userId: 'user-test', deviceId: 'device-test' });
  const vault = {
    userId: 'user-test',
    keystore,
    async persist() {},
    async readCache() { return null; },
    async writeCache() {},
    async deleteCache() {}
  };
  const engine = new DuetEngine();
  engine.attach(vault);
  return { engine, keystore };
}

test('Engine: a duplicate decode reuses the recorded outcome', async () => {
  const { engine, keystore } = fakeEngine();
  const row = {
    id: 'message-1',
    conversationId: 'conversation-1',
    ciphertext: 'AAAA',
    envelope: { dh: b64(randomBytes(32)), n: 0, pn: 0 },
    createdAt: new Date().toISOString()
  };
  const first = await engine.decodeRow(row, { peerId: 'peer-1' });
  const second = await engine.decodeRow(row, { peerId: 'peer-1' });
  assert(first.status === 'damaged' && first.reason === 'no_session', `expected no_session, got ${first.reason}`);
  assert(second.cached === true, 'second decode should come from the seen cache');
  assert(second.reason === first.reason, 'cached reason differs from the first outcome');
  assert(keystore.seen['message-1'], 'seen entry was not recorded');
});

test('Engine: a dead row stays dead and is not retried', async () => {
  const { engine, keystore } = fakeEngine();
  keystore.seen['message-dead'] = {
    ok: false,
    reason: 'bad_signature',
    dead: true,
    retryable: false,
    at: Date.now(),
    convId: 'conversation-1'
  };
  const row = {
    id: 'message-dead',
    conversationId: 'conversation-1',
    ciphertext: 'AAAA',
    envelope: { dh: b64(randomBytes(32)), n: 0, pn: 0 },
    createdAt: new Date().toISOString()
  };
  const result = await engine.decodeRow(row, { peerId: 'peer-1' });
  assert(result.status === 'damaged', 'dead row must be damaged');
  assert(result.dead === true, 'dead row must remain flagged dead');
  assert(result.cached === true, 'dead row must be served from cache');
});

test('Engine: deleted rows are tombstoned without touching keys', async () => {
  const { engine } = fakeEngine();
  const result = await engine.decodeRow({
    id: 'message-deleted',
    conversationId: 'conversation-1',
    ciphertext: 'AAAA',
    envelope: null,
    deletedAt: new Date().toISOString()
  });
  assert(result.status === 'deleted', 'deleted row should be a tombstone');
});

test('Engine: two devices can exchange messages in both directions', async () => {
  const make = (userId) => {
    const keystore = createKeystore({ userId, deviceId: `device-${userId}` });
    const cache = {};
    const engine = new DuetEngine();
    engine.attach({
      userId, keystore, mk: true,
      async persist() {},
      async readCache(key) { return cache[key] || null; },
      async writeCache(key, value) { cache[key] = value; },
      async deleteCache() {}
    });
    return engine;
  };
  const alice = make('1');
  const bob = make('2');
  const original = { consumeKeys: api.consumeKeys, keys: api.keys };
  api.consumeKeys = async () => ({
    bundle: {
      identityKey: bob.keystore.identity.pub,
      signedPreKey: {
        id: bob.keystore.signedPreKey.id,
        publicKey: bob.keystore.signedPreKey.pub,
        signature: bob.keystore.signedPreKey.signature
      },
      oneTimePreKey: {
        id: bob.keystore.oneTimePreKeys[0].id,
        publicKey: bob.keystore.oneTimePreKeys[0].pub
      },
      pool: 29
    }
  });
  api.keys = async () => ({ bundle: { identityKey: alice.keystore.identity.pub } });
  try {
    await alice.ensureSession('conv', '2');
    let counter = 0;
    const roundTrip = async (from, to, peerId, text) => {
      const sealed = await from.encryptPayload('conv', { kind: 'text', text });
      const result = await to.decodeRow({
        id: `rt-${counter += 1}`, conversationId: 'conv',
        ciphertext: sealed.ciphertext, envelope: sealed.envelope
      }, { peerId });
      assert(result.status === 'ok', `"${text}" failed: ${result.reason}`);
      assert(result.payload.text === text, 'decrypted text differs');
    };
    await roundTrip(alice, bob, '1', 'hello bob');
    await roundTrip(bob, alice, '2', 'hello alice');
    await roundTrip(bob, alice, '2', 'second reply');
    await roundTrip(alice, bob, '1', 'and back again');
  } finally {
    api.consumeKeys = original.consumeKeys;
    api.keys = original.keys;
  }
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderResults(results) {
  const root = document.getElementById('tests');
  if (!root) return;
  root.textContent = '';

  const passed = results.filter((item) => item.pass).length;
  const failed = results.length - passed;

  const head = el('div', 'stack-10');
  head.appendChild(el('h1', 'h1', 'Duet crypto property tests'));
  head.appendChild(el(
    'p',
    'muted',
    'These asserts cover confidentiality, authentication, session setup, ratchet progression and engine idempotency. They run entirely in this browser.'
  ));
  root.appendChild(head);

  const summary = el('div', `test-summary ${failed ? 'fail' : 'pass'}`);
  summary.appendChild(el('span', failed ? 'chip warn' : 'chip ok', failed ? `${failed} failed` : 'All passed'));
  summary.appendChild(el('span', 'strong', `${passed} of ${results.length} passed`));
  summary.appendChild(el('span', 'faint', new Date().toLocaleString()));
  root.appendChild(summary);

  for (const item of results) {
    const row = el('div', `test-row ${item.pass ? 'pass' : 'fail'}`);
    row.appendChild(el('span', 'test-mark', item.pass ? '✓' : '✕'));
    const body = el('div', 'grow');
    body.appendChild(el('p', 'strong', item.name));
    if (item.detail) body.appendChild(el('p', 'test-detail', item.detail));
    if (!item.pass) body.appendChild(el('p', 'test-detail', item.error));
    row.appendChild(body);
    root.appendChild(row);
  }

  const foot = el('p', 'hint mt-20');
  foot.textContent = 'Build tag: checking /api/health is optional. These tests do not contact the server.';
  root.appendChild(foot);
}

async function run() {
  const results = [];
  for (const entry of tests) {
    const started = performance.now();
    try {
      await entry.fn();
      results.push({
        ...entry,
        pass: true,
        detail: entry.detail || `${Math.round(performance.now() - started)} ms`
      });
    } catch (error) {
      results.push({
        ...entry,
        pass: false,
        error: error?.message || String(error)
      });
    }
  }
  renderResults(results);
}

run().catch((error) => {
  const root = document.getElementById('tests');
  if (root) {
    root.textContent = '';
    root.appendChild(el('h1', 'h1', 'Tests could not run'));
    root.appendChild(el('p', 'error-text', error?.message || String(error)));
  }
});
