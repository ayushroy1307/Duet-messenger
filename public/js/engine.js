import { api } from './api.js';
import { diag } from './diag.js';
import {
  aeadOpen, aeadSeal, b64, concat, fromUtf8, generateIdentity, generateX25519,
  hkdfBytes, identityPubToX25519, identityToX25519, kdfChain, kdfRoot,
  randomBytes, readU32, signSessionInit, signSignedPreKey,
  unb64, utf8, verifySessionInit, verifySignedPreKey, x3dhAd, x3dhSecret,
  x25519Shared
} from './crypto.js';

export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.extra = extra;
  }
}

// Sessions created before this format carried a wrong initiator root key and
// can never decrypt replies. They are discarded and re-established on attach.
const SESSION_FORMAT = 2;

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

function randomPreKeyId(used = new Set()) {
  for (;;) {
    const id = (readU32(randomBytes(4)) % 2_147_483_646) + 1;
    if (!used.has(id)) return id;
  }
}

function makePreKey(used) {
  const key = generateX25519();
  return { id: randomPreKeyId(used), priv: key.priv, pub: key.pub, createdAt: now() };
}

export function createKeystore({ userId, deviceId }) {
  const identity = generateIdentity();
  const signed = makePreKey(new Set());
  const used = new Set([signed.id]);
  const oneTimePreKeys = Array.from({ length: 30 }, () => {
    const key = makePreKey(used);
    used.add(key.id);
    return key;
  });
  const signedPreKey = {
    ...signed,
    signature: signSignedPreKey(identity, signed)
  };
  return {
    version: 1,
    userId,
    deviceId,
    identity,
    signedPreKey,
    oneTimePreKeys,
    sessions: {},
    seen: {},
    retired: {},
    createdAt: now()
  };
}

function headerBytes(header) {
  const dh = unb64(header.dh);
  if (dh.length !== 32) throw new EngineError('bad_envelope', 'Malformed ratchet key.');
  return concat(dh, u32Local(header.n), u32Local(header.pn));
}

function u32Local(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function skippedCount(session) {
  let count = 0;
  for (const keys of Object.values(session.skipped || {})) count += Object.keys(keys).length;
  return count;
}

function storeSkipped(session, dh, n, key) {
  if (!session.skipped[dh]) session.skipped[dh] = {};
  session.skipped[dh][n] = key;
  if (skippedCount(session) > 2000) {
    throw new EngineError('too_many_skipped', 'Too many skipped messages in this session.');
  }
}

function skipMessageKeys(session, until) {
  if (until <= session.nr) return;
  if (!session.ckRecv) throw new EngineError('missing_chain', 'The receiving chain is not ready.');
  if (until - session.nr > 2000) {
    throw new EngineError('too_many_skipped', 'This message is too far out of order.');
  }
  while (session.nr < until) {
    const step = kdfChain(session.ckRecv);
    storeSkipped(session, session.dhRemotePub, session.nr, step.messageKey);
    session.ckRecv = step.chainKey;
    session.nr += 1;
  }
}

function dhRatchet(session, remoteDh) {
  if (session.dhRemotePub) {
    session.remoteHistory = [...(session.remoteHistory || []), session.dhRemotePub].slice(-20);
  }
  session.pn = session.ns;
  session.ns = 0;
  session.nr = 0;
  session.dhRemotePub = remoteDh;

  let step = kdfRoot(session.rootKey, x25519Shared(session.dhSelfPriv, remoteDh));
  session.rootKey = step.rootKey;
  session.ckRecv = step.chainKey;

  const fresh = generateX25519();
  session.dhSelfPriv = fresh.priv;
  session.dhSelfPub = fresh.pub;
  step = kdfRoot(session.rootKey, x25519Shared(fresh.priv, remoteDh));
  session.rootKey = step.rootKey;
  session.ckSend = step.chainKey;
}

function openWithKey(session, header, messageKey, envelope) {
  const aad = concat(unb64(session.ad), headerBytes(header));
  return aeadOpen(messageKey, envelope.ciphertext, envelope.nonce, aad);
}

function decryptWithSession(session, envelope) {
  const header = envelope?.header;
  if (!header || !Number.isInteger(header.n) || !Number.isInteger(header.pn) || !header.dh) {
    throw new EngineError('bad_envelope', 'The message header is malformed.');
  }

  // A delayed message from a chain we have already skipped past.
  if (header.dh !== session.dhRemotePub) {
    const bucket = session.skipped?.[header.dh];
    if (bucket && bucket[header.n] !== undefined) {
      const key = bucket[header.n];
      delete bucket[header.n];
      return openWithKey(session, header, key, envelope);
    }
    if ((session.remoteHistory || []).includes(header.dh)) {
      throw new EngineError('old_chain', 'This message belongs to an older chain.');
    }
    skipMessageKeys(session, header.pn);
    dhRatchet(session, header.dh);
  }

  if (header.n < session.nr) {
    const bucket = session.skipped?.[session.dhRemotePub];
    const key = bucket?.[header.n];
    if (key === undefined) throw new EngineError('missing_key', 'This message key was already used.');
    delete bucket[header.n];
    return openWithKey(session, header, key, envelope);
  }

  skipMessageKeys(session, header.n);
  if (!session.ckRecv) throw new EngineError('missing_chain', 'The receiving chain is not ready.');
  const step = kdfChain(session.ckRecv);
  session.ckRecv = step.chainKey;
  session.nr += 1;
  return openWithKey(session, header, step.messageKey, envelope);
}

export class DuetEngine {
  constructor() {
    this.vault = null;
    this.userId = null;
    this.locks = new Map();
    this.workQueues = new Map();
    this.publishing = null;
  }

  attach(vault) {
    this.vault = vault;
    this.userId = vault.userId;
    this.locks = new Map();
    this.workQueues = new Map();
    this.migrateLegacySessions();
  }

  /**
   * Initiator sessions made by the old buggy build (no `v`) are unusable:
   * the peer's replies never decrypt and the chat sits on "Securing...".
   * Drop them so the next time the chat opens a fresh handshake is sent.
   */
  migrateLegacySessions() {
    const ks = this.keystore;
    if (!ks?.sessions) return;
    let changed = false;
    for (const [conversationId, session] of Object.entries(ks.sessions)) {
      if (session?.initiator && session.v !== SESSION_FORMAT) {
        this.retire(conversationId, session.generation);
        delete ks.sessions[conversationId];
        changed = true;
        diag.event('session_reset', { conversationId, reason: 'legacy_format' });
      }
    }
    if (changed) void this.persist().catch(() => {});
  }

  detach() {
    this.vault = null;
    this.userId = null;
    this.locks = new Map();
    this.workQueues = new Map();
    this.publishing = null;
  }

  /**
   * Serialize every ratchet operation for a conversation. Two views (history,
   * realtime, a preview fetch) may decode the same message at once; without
   * this, both would clone the same state and one advance would be lost.
   */
  runExclusive(conversationId, task) {
    const previous = this.workQueues.get(conversationId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.workQueues.set(conversationId, next.catch(() => {}));
    return next;
  }

  get keystore() {
    return this.vault?.keystore || null;
  }

  get ready() {
    return Boolean(this.keystore && this.vault?.mk);
  }

  async persist() {
    await this.vault?.persist();
  }

  sessionInfo(conversationId) {
    const session = this.keystore?.sessions?.[conversationId];
    if (!session) return { exists: false, pending: false, generation: null };
    return {
      exists: true,
      pending: Boolean(session.pendingX3DH),
      generation: session.generation,
      initiator: Boolean(session.initiator)
    };
  }

  retire(conversationId, generation) {
    if (!generation) return;
    const list = this.keystore.retired[conversationId] || [];
    if (!list.includes(generation)) list.push(generation);
    this.keystore.retired[conversationId] = list.slice(-20);
  }

  async publishKeys() {
    if (!this.ready) throw new EngineError('locked', 'Unlock the vault first.');
    if (this.publishing) return this.publishing;
    this.publishing = (async () => {
      const identity = this.keystore.identity;
      // Re-sign on every publish: the bundle must be complete even if the
      // server lost the previous signature (7.11).
      this.keystore.signedPreKey.signature =
        signSignedPreKey(identity, this.keystore.signedPreKey);
      const used = new Set(this.keystore.oneTimePreKeys.map((key) => key.id));
      while (this.keystore.oneTimePreKeys.length < 30) {
        const key = makePreKey(used);
        used.add(key.id);
        this.keystore.oneTimePreKeys.push(key);
      }
      const bundle = {
        deviceId: this.keystore.deviceId,
        identityKey: identity.pub,
        signedPreKey: {
          id: this.keystore.signedPreKey.id,
          publicKey: this.keystore.signedPreKey.pub,
          signature: this.keystore.signedPreKey.signature,
          createdAt: this.keystore.signedPreKey.createdAt
        },
        oneTimePreKeys: this.keystore.oneTimePreKeys.map((key) => ({
          id: key.id,
          publicKey: key.pub
        }))
      };
      try {
        const result = await api.publishKeys(bundle);
        diag.event('prekeys_published', {
          pool: Number(result?.pool || 0),
          count: this.keystore.oneTimePreKeys.length
        });
        await this.persist();
        return result;
      } catch (error) {
        diag.event('prekeys_missing', { reason: error.code || 'publish_failed' });
        throw error;
      }
    })();
    try {
      return await this.publishing;
    } finally {
      this.publishing = null;
    }
  }

  async initiateSession(conversationId, peerId) {
    let peerBundle;
    try {
      const result = await api.consumeKeys(conversationId);
      peerBundle = result?.bundle;
    } catch (error) {
      if (error.code === 'keys_unavailable') {
        throw new EngineError('keys_unavailable',
          'Their encryption keys are not on the server yet.');
      }
      throw error;
    }
    if (!peerBundle?.identityKey || !peerBundle?.signedPreKey) {
      throw new EngineError('keys_unavailable', 'Their encryption keys are not available.');
    }
    const signedPreKey = {
      id: peerBundle.signedPreKey.id,
      publicKey: peerBundle.signedPreKey.publicKey,
      signature: peerBundle.signedPreKey.signature
    };
    if (!verifySignedPreKey(peerBundle.identityKey, signedPreKey)) {
      diag.event('session_refused', { reason: 'bad_signature', peerId });
      throw new EngineError('bad_signature',
        'Their published key signature is invalid. Ask them to open Duet and try again.');
    }

    const identityX = identityToX25519(this.keystore.identity);
    const peerIdentityX = identityPubToX25519(peerBundle.identityKey);
    const ephemeral = generateX25519();
    const oneTime = peerBundle.oneTimePreKey;
    const parts = [
      x25519Shared(identityX.priv, signedPreKey.publicKey),
      x25519Shared(ephemeral.priv, peerIdentityX),
      x25519Shared(ephemeral.priv, signedPreKey.publicKey),
      ...(oneTime ? [x25519Shared(ephemeral.priv, oneTime.publicKey)] : [])
    ];
    const sk = x3dhSecret(parts);
    const generation = b64(randomBytes(16));
    const x3dh = {
      generation,
      ephemeralPublicKey: ephemeral.pub,
      initiatorIdentityKey: this.keystore.identity.pub,
      signedPreKeyId: signedPreKey.id,
      usedOneTimePreKeyId: oneTime?.id || 0,
      authTag: ''
    };
    x3dh.authTag = signSessionInit(this.keystore.identity, x3dh);
    const ad = x3dhAd(this.keystore.identity.pub, peerBundle.identityKey, generation);
    const dhSelf = generateX25519();
    const step = kdfRoot(b64(sk), x25519Shared(dhSelf.priv, signedPreKey.publicKey));

    const session = {
      generation,
      peerId,
      v: SESSION_FORMAT,
      initiator: true,
      ad,
      rootKey: step.rootKey,
      dhSelfPriv: dhSelf.priv,
      dhSelfPub: dhSelf.pub,
      dhRemotePub: signedPreKey.publicKey,
      ckSend: step.chainKey,
      ckRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: {},
      remoteHistory: [],
      pendingX3DH: x3dh,
      createdAt: now()
    };
    this.keystore.sessions[conversationId] = session;
    this.retire(conversationId, null);
    await this.persist();
    diag.event('session_created', { peerId, generation, pool: peerBundle.pool });
    return session;
  }

  async ensureSession(conversationId, peerId) {
    if (!this.ready) throw new EngineError('locked', 'Unlock the vault first.');
    if (this.locks.has(conversationId)) return this.locks.get(conversationId);
    const task = this.runExclusive(conversationId, async () => {
      const existing = this.keystore.sessions[conversationId];
      if (existing) {
        diag.event('session_reused', {
          generation: existing.generation,
          peerId,
          count: existing.pendingX3DH ? 1 : 0
        });
        return existing;
      }
      // Exactly one side may mint a session unsolicited (7.1).
      if (String(this.userId) > String(peerId)) {
        return { needsPeer: true, reason: 'wait_for_peer' };
      }
      return this.initiateSession(conversationId, peerId);
    });
    this.locks.set(conversationId, task);
    try {
      return await task;
    } finally {
      this.locks.delete(conversationId);
    }
  }

  async resetSession(conversationId, peerId) {
    if (!this.ready) throw new EngineError('locked', 'Unlock the vault first.');
    if (String(this.userId) > String(peerId)) {
      await api.repair(conversationId);
      diag.event('session_repair_requested', { peerId });
      return { needsPeer: true, reason: 'requested' };
    }
    const existing = this.keystore.sessions[conversationId];
    if (existing) this.retire(conversationId, existing.generation);
    delete this.keystore.sessions[conversationId];
    await this.persist();
    diag.event('session_reset', { peerId, reason: 'forced' });
    return this.runExclusive(conversationId,
      () => this.initiateSession(conversationId, peerId));
  }

  async adoptHandshake(conversationId, peerId, envelope) {
    const x3dh = envelope?.x3dh;
    if (!x3dh) throw new EngineError('no_handshake', 'No session handshake found.');
    const current = this.keystore.sessions[conversationId];
    if (current?.generation === x3dh.generation) {
      diag.event('session_replayed', { generation: x3dh.generation, peerId });
      return current;
    }
    if ((this.keystore.retired[conversationId] || []).includes(x3dh.generation)) {
      throw new EngineError('retired_generation',
        'This message belongs to a retired secure session.');
    }

    let peerBundle = null;
    try {
      const result = await api.keys(conversationId);
      peerBundle = result?.bundle || null;
    } catch (error) {
      if (error.code === 'offline' || error.code === 'timeout') {
        throw new EngineError('offline', 'Reconnect to verify this secure session.');
      }
      throw error;
    }
    // If peer bundle not available yet (cold start race), wait once and retry.
    // This handles the case where the initiator's publishKeys() hasn't completed
    // by the time the handshake message arrives at the recipient.
    if (!peerBundle?.identityKey) {
      await new Promise(r => setTimeout(r, 1500));
      const retry = await api.keys(conversationId);
      peerBundle = retry?.bundle || null;
    }
    // Pin the peer's identity. X3DH authenticates the initiator, and the
    // handshake must also match the identity the server publishes for them.
    if (!peerBundle?.identityKey || peerBundle.identityKey !== x3dh.initiatorIdentityKey) {
      diag.event('session_refused', {
        reason: 'identity_mismatch',
        generation: x3dh.generation,
        peerId
      });
      throw new EngineError('identity_mismatch',
        'The secure session did not match this contact\'s identity key.');
    }
    if (!verifySessionInit(x3dh)) {
      diag.event('session_refused', {
        reason: 'bad_auth_tag',
        generation: x3dh.generation,
        peerId
      });
      throw new EngineError('bad_signature', 'The secure session handshake is not authentic.');
    }

    const signed = this.keystore.signedPreKey;
    if (!signed || Number(signed.id) !== Number(x3dh.signedPreKeyId)) {
      throw new EngineError('spk_gone', 'The signed prekey for this session is gone.');
    }
    let oneTime = null;
    if (Number(x3dh.usedOneTimePreKeyId) > 0) {
      oneTime = this.keystore.oneTimePreKeys.find((key) =>
        Number(key.id) === Number(x3dh.usedOneTimePreKeyId));
      if (!oneTime) {
        // DH4 is unrecoverable. This row and every row in that generation are
        // permanently dead and must never be retried (7.9).
        throw new EngineError('prekey_gone',
          'This message used a one-time key this device no longer has.');
      }
    }

    const identityX = identityToX25519(this.keystore.identity);
    const peerIdentityX = identityPubToX25519(x3dh.initiatorIdentityKey);
    const parts = [
      x25519Shared(signed.priv, peerIdentityX),
      x25519Shared(identityX.priv, x3dh.ephemeralPublicKey),
      x25519Shared(signed.priv, x3dh.ephemeralPublicKey),
      ...(oneTime ? [x25519Shared(oneTime.priv, x3dh.ephemeralPublicKey)] : [])
    ];
    const sk = x3dhSecret(parts);
    const ad = x3dhAd(x3dh.initiatorIdentityKey, this.keystore.identity.pub, x3dh.generation);

    if (oneTime) {
      this.keystore.oneTimePreKeys = this.keystore.oneTimePreKeys.filter((key) => key !== oneTime);
    }
    if (current) this.retire(conversationId, current.generation);

    const session = {
      generation: x3dh.generation,
      peerId,
      v: SESSION_FORMAT,
      initiator: false,
      ad,
      rootKey: b64(sk),
      dhSelfPriv: signed.priv,
      dhSelfPub: signed.pub,
      dhRemotePub: null,
      ckSend: null,
      ckRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: {},
      remoteHistory: [],
      pendingX3DH: null,
      createdAt: now()
    };
    this.keystore.sessions[conversationId] = session;
    this.clearRetryableFailures(conversationId);
    await this.persist();
    diag.event('session_adopted', {
      generation: x3dh.generation,
      peerId,
      pool: this.keystore.oneTimePreKeys.length
    });
    return session;
  }

  encryptPayload(conversationId, payload) {
    return this.runExclusive(conversationId, () => this.encryptPayloadLocked(conversationId, payload));
  }

  async encryptPayloadLocked(conversationId, payload) {
    if (!this.ready) throw new EngineError('locked', 'Unlock the vault first.');
    const session = this.keystore.sessions[conversationId];
    if (!session) throw new EngineError('no_session', 'The secure session is not ready yet.');
    if (!session.ckSend) throw new EngineError('no_send_chain', 'The sending chain is not ready yet.');

    const step = kdfChain(session.ckSend);
    session.ckSend = step.chainKey;
    const header = { dh: session.dhSelfPub, n: session.ns, pn: session.pn };
    session.ns += 1;
    const aad = concat(unb64(session.ad), headerBytes(header));
    const sealed = aeadSeal(step.messageKey, utf8(JSON.stringify(payload)), aad);
    const envelope = {
      header,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      ...(session.pendingX3DH ? { x3dh: clone(session.pendingX3DH) } : {})
    };
    // The server stores the ciphertext twice (column + envelope) so the wire
    // format matches the spec. Both copies are identical.
    await this.persist();
    return {
      ciphertext: sealed.ciphertext,
      envelope,
      handshakePending: Boolean(session.pendingX3DH)
    };
  }

  decodeRow(row, { peerId, variant = null } = {}) {
    const conversationId = row.conversationId || row.conversation_id;
    if (!conversationId) return this.decodeRowLocked(row, { peerId, variant });
    return this.runExclusive(conversationId,
      () => this.decodeRowLocked(row, { peerId, variant }));
  }

  async decodeRowLocked(row, { peerId, variant = null } = {}) {
    if (row.deletedAt || row.deleted_at) return { status: 'deleted' };
    const messageId = row.id;
    const conversationId = row.conversationId || row.conversation_id;
    const cacheKey = variant ? `${messageId}#${variant}` : messageId;
    const envelope = row.envelope;
    if (!envelope || !row.ciphertext) return { status: 'damaged', reason: 'missing_ciphertext' };

    const seen = this.keystore.seen[cacheKey];
    if (seen) {
      if (seen.dead) return { status: 'damaged', reason: seen.reason, dead: true, cached: true };
      if (seen.ok) {
        const cached = await this.vault.readCache(cacheKey);
        if (cached) return { status: 'ok', payload: cached, cached: true };
        return { status: 'damaged', reason: 'local_copy_missing', cached: true };
      }
      if (!envelope.x3dh) {
        return { status: 'damaged', reason: seen.reason, cached: true };
      }
      // A handshake may have arrived since the failure; fall through and retry.
    }

    try {
      let session = this.keystore.sessions[conversationId];
      if (envelope.x3dh) {
        if (!session || session.generation !== envelope.x3dh.generation) {
          // Adopt *before* decrypting the message that carries the handshake (7.6).
          session = await this.adoptHandshake(conversationId, peerId, envelope);
          delete this.keystore.seen[cacheKey];
        } else {
          diag.event('session_replayed', {
            generation: session.generation, peerId
          });
        }
      }
      if (!session) {
        throw new EngineError('no_session', 'The secure session is not established yet.');
      }

      const working = clone(session);
      const plaintext = decryptWithSession(working, envelope);
      const payload = JSON.parse(fromUtf8(plaintext));
      if (!payload || typeof payload !== 'object' || typeof payload.kind !== 'string') {
        throw new EngineError('bad_payload', 'The decrypted message is malformed.');
      }
      if (working.pendingX3DH) {
        // Any authenticated inbound message proves the peer adopted our chain.
        working.pendingX3DH = null;
      }
      this.keystore.sessions[conversationId] = working;
      await this.vault.writeCache(cacheKey, payload);
      this.keystore.seen[cacheKey] = {
        ok: true, at: now(), convId: conversationId
      };
      this.pruneSeen();
      await this.persist();
      diag.event('decrypt_ok', { messageId, conversationId, peerId });
      return { status: 'ok', payload, cached: false };
    } catch (error) {
      const reason = error?.code || 'decrypt_failed';
      const transient = ['offline', 'timeout', 'store_unreachable', 'keys_unavailable'].includes(reason);
      // keys_unavailable is now retryable (not dead) - peer may be publishing keys
      const dead = [
        'prekey_gone', 'spk_gone', 'retired_generation', 'identity_mismatch',
        'bad_signature', 'bad_payload', 'missing_key', 'old_chain'
      ].includes(reason);
      this.keystore.seen[cacheKey] = {
        ok: false,
        reason,
        dead,
        retryable: transient || reason === 'no_session',
        at: now(),
        convId: conversationId
      };
      try { await this.persist(); } catch { /* ignore persistence failure */ }
      diag.event(dead ? 'dead_row' : 'decrypt_failed', {
        messageId, conversationId, reason, dead
      });
      return {
        status: 'damaged',
        reason,
        dead,
        retryable: transient || reason === 'no_session'
      };
    }
  }

  clearRetryableFailures(conversationId) {
    for (const [id, entry] of Object.entries(this.keystore.seen)) {
      if (!entry.ok && entry.retryable && entry.convId === conversationId) {
        delete this.keystore.seen[id];
      }
    }
  }

  async rememberOwn(messageId, conversationId, payload, { variant = null } = {}) {
    const key = variant ? `${messageId}#${variant}` : messageId;
    await this.vault.writeCache(key, payload);
    this.keystore.seen[key] = {
      ok: true, at: now(), convId: conversationId, own: true
    };
    this.pruneSeen();
    await this.persist();
  }

  async readCached(messageId, { variant = null } = {}) {
    const key = variant ? `${messageId}#${variant}` : messageId;
    return this.vault.readCache(key);
  }

  forgetMessage(messageId) {
    for (const key of Object.keys(this.keystore.seen)) {
      if (key === messageId || key.startsWith(`${messageId}#`)) {
        delete this.keystore.seen[key];
        void this.vault.deleteCache(key);
      }
    }
    void this.vault.deleteCache(messageId);
  }

  clearConversation(conversationId) {
    for (const [key, entry] of Object.entries(this.keystore.seen)) {
      if (entry.convId === conversationId) {
        delete this.keystore.seen[key];
        void this.vault.deleteCache(key);
      }
    }
  }

  pruneSeen() {
    const entries = Object.entries(this.keystore.seen);
    if (entries.length <= 7000) return;
    const dead = entries.filter(([, entry]) => entry.dead);
    const live = entries
      .filter(([, entry]) => !entry.dead)
      .sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)))
      .slice(-4000);
    this.keystore.seen = Object.fromEntries([...dead.slice(-2000), ...live]);
  }

  async requestRepair(conversationId) {
    await api.repair(conversationId);
    diag.event('session_repair_requested', { conversationId });
  }
}

export const engine = new DuetEngine();