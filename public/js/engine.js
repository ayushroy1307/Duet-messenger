// The client engine: key storage, session lifecycle, decode-once, outbox.
// This is the layer the spec calls critical; the numbered comments (7.x) map to spec section 7.
// Storage (`db`) and the network (`api`) are injected so the same code runs in the browser and in tests.
import { enc, dec, b64, unb64, randId, clone, CryptoError, KeyedLock, Persister, sleep } from './util.js';
import {
  createIdentity, createSignedPrekey, createOneTimePrekeys, buildBundle,
  x3dhInitiate, x3dhRespond, ratchetEncrypt, ratchetDecrypt, canSend,
  encryptBlob, decryptBlob, safetyNumber,
} from './crypto.js';

const OTK_BATCH = 20;
const OTK_LOW = 5;
const SPK_ROTATE_MS = 14 * 24 * 3600 * 1000;
const SPK_KEEP_MS = 60 * 24 * 3600 * 1000;

/** In-memory db with the same shape as the IndexedDB one (used by tests). */
export class MemoryDB {
  constructor() { this.b = new Map(); }
  _m(bucket) { if (!this.b.has(bucket)) this.b.set(bucket, new Map()); return this.b.get(bucket); }
  async get(bucket, key) { const v = this._m(bucket).get(key); return v === undefined ? undefined : JSON.parse(v); }
  async put(bucket, key, val) { this._m(bucket).set(key, JSON.stringify(val)); }
  async del(bucket, key) { this._m(bucket).delete(key); }
  async keys(bucket) { return [...this._m(bucket).keys()]; }
  async clear(bucket) { this._m(bucket).clear(); }
}

class Emitter {
  constructor() { this.h = new Set(); }
  on(fn) { this.h.add(fn); return () => this.h.delete(fn); }
  emit(ev) { for (const fn of this.h) { try { fn(ev); } catch { /* listener errors never reach the engine */ } } }
}

export class Engine extends Emitter {
  /**
   * @param {{selfId:string, db:object, sealer:object, api:object, trace?:Function, build?:string}} o
   */
  constructor(o) {
    super();
    this.selfId = o.selfId; this.db = o.db; this.sealer = o.sealer; this.api = o.api;
    this.build = o.build || 'dev';
    this._trace = o.trace || (() => {});
    this.keystore = null;
    this.convs = new Map();
    this.ksPersist = new Persister(() => clone(this.keystore), async (snap) => this.sput('keystore', 'ks', snap));
    this.destroyed = false;
  }
  trace(event, fields = {}) { try { this._trace(event, fields); } catch { /* tracing is best-effort */ } }

  // -- sealed storage helpers -------------------------------------------------
  async sget(bucket, key) {
    const rec = await this.db.get(bucket, key);
    if (!rec) return undefined;
    try { return await this.sealer.open(bucket, rec, bucket + ':' + key); } catch { return undefined; }
  }
  async sput(bucket, key, val) {
    if (this.destroyed) return;
    await this.db.put(bucket, key, await this.sealer.seal(bucket, val, bucket + ':' + key));
  }

  // -- keystore & bundle (7.11) -----------------------------------------------
  async init() {
    this.keystore = await this.sget('keystore', 'ks');
    if (!this.keystore) {
      const identity = await createIdentity();
      const spk = await createSignedPrekey(identity, 1);
      const otks = await createOneTimePrekeys(1, OTK_BATCH);
      this.keystore = { v: 1, identity, spks: [spk], otks, nextOtkId: OTK_BATCH + 1, nextSpkId: 2, createdAt: Date.now() };
      await this.ksPersist.mark();
      this.trace('keystore-created');
      this._freshOtks = otks;
    }
    // Rotate the signed prekey, keeping old private halves so late handshakes still work.
    const cur = this.keystore.spks[this.keystore.spks.length - 1];
    if (Date.now() - cur.createdAt > SPK_ROTATE_MS) {
      this.keystore.spks.push(await createSignedPrekey(this.keystore.identity, this.keystore.nextSpkId++));
      this.keystore.spks = this.keystore.spks.filter((s, i, a) => i === a.length - 1 || Date.now() - s.createdAt < SPK_KEEP_MS);
      await this.ksPersist.mark();
      this.trace('spk-rotated');
    }
    await this.publish();
    return this;
  }
  get identityPublic() { return { sign: this.keystore.identity.sign.pub, dh: this.keystore.identity.dh.pub }; }

  /**
   * Re-publish on EVERY unlock with a freshly re-signed bundle so peers can start sessions
   * even if the server's registry was wiped. One-time prekeys are only sent when new.
   */
  async publish({ withOtks } = {}) {
    const ks = this.keystore;
    const spk = ks.spks[ks.spks.length - 1];
    const otks = withOtks || this._freshOtks || [];
    this._freshOtks = null;
    const bundle = await buildBundle(ks.identity, spk, otks);
    let res;
    try { res = await this.api.publishKeys(bundle); } catch (e) { this.trace('publish-failed', { code: e.code || 'net' }); return; }
    this.trace('bundle-published', { otks: otks.length });
    if (res && typeof res.otkRemaining === 'number' && res.otkRemaining < OTK_LOW) await this.topUpOtks();
  }
  async topUpOtks() {
    const ks = this.keystore;
    const fresh = await createOneTimePrekeys(ks.nextOtkId, OTK_BATCH);
    ks.nextOtkId += OTK_BATCH;
    ks.otks.push(...fresh);
    await this.ksPersist.mark();
    await this.publish({ withOtks: fresh });
  }
  async _persistKeystore() { await this.ksPersist.mark(); }

  // -- conversations ------------------------------------------------------------
  conv(convId, peerId) {
    let c = this.convs.get(convId);
    if (!c) { c = new ConvEngine(this, convId, peerId); this.convs.set(convId, c); }
    return c;
  }
  /** Drop every in-memory secret (called on lock). Persisted state stays sealed on disk. */
  async destroy() {
    for (const c of this.convs.values()) await c.persist.flush();
    await this.ksPersist.flush();
    this.destroyed = true;
    this.keystore = null;
    this.convs.clear();
    this.h.clear();
  }
}

export class ConvEngine extends Emitter {
  constructor(engine, convId, peerId) {
    super();
    this.e = engine; this.convId = convId; this.peerId = peerId; this.selfId = engine.selfId;
    this.lock = new KeyedLock();
    this.session = null;
    this.meta = { retired: [], peerIdentity: null, identityChanged: false };
    this.loaded = null;
    this.outcomes = new Map();
    this.inflight = new Map();
    this.pending = new Map();
    this.status = 'loading';
    this.lastRequest = 0; this.lastRepair = 0;
    this.flushing = null;
    this.persist = new Persister(() => ({ session: this.session ? clone(this.session) : null, meta: clone(this.meta) }), async (snap) => {
      if (snap.session) await this.e.sput('sessions', this.convId, snap.session);
      await this.e.sput('convmeta', this.convId, snap.meta);
    });
  }
  /** 7.1 — a deterministic rule decides who may create a session unsolicited. */
  get isInitiator() { return this.selfId < this.peerId; }
  emitChange(kind = 'change') { this.emit({ kind, convId: this.convId }); this.e.emit({ kind, convId: this.convId }); }
  setStatus(s) { if (this.status !== s) { this.status = s; this.emitChange('status'); } }

  load() {
    if (!this.loaded) this.loaded = (async () => {
      this.session = (await this.e.sget('sessions', this.convId)) || null;
      const m = await this.e.sget('convmeta', this.convId);
      if (m) this.meta = { retired: [], peerIdentity: null, identityChanged: false, ...m };
      this.setStatus(this._computeStatus());
    })();
    return this.loaded;
  }
  _computeStatus() {
    if (this.session) return canSend(this.session.ratchet) ? 'ready' : 'awaiting-first';
    return this.isInitiator ? 'setting-up' : 'waiting-handshake';
  }
  get ready() { return !!this.session && canSend(this.session.ratchet); }
  async safetyNumber() {
    if (!this.meta.peerIdentity) return null;
    return safetyNumber(this.e.identityPublic, this.meta.peerIdentity);
  }

  // -- session creation (7.1, 7.2, 7.3, 7.12) ----------------------------------------
  /** Idempotent entry point: create/ask for a session when none exists. Never rebuilds one (7.2). */
  async bootstrap() {
    await this.load();
    if (this.session) { this.e.trace('session-reused'); this.setStatus(this._computeStatus()); return; }
    if (!this.isInitiator) { this.setStatus('waiting-handshake'); await this.requestSession(); return; } // never mint (7.1)
    await this._createAsInitiator({ force: false });
  }
  async requestSession() {
    if (Date.now() - this.lastRequest < 20000) return;
    this.lastRequest = Date.now();
    this.e.trace('session-requested');
    try { await this.e.api.requestRepair(this.convId, 'session'); } catch { /* retried on next open */ }
  }
  /** The peer asked for a session (7.12). Only the designated initiator reacts. */
  async onSessionRequest() {
    await this.load();
    if (!this.isInitiator) return;
    if (this.session && this.session.initEnv && !this.session.acked) { // handshake still owed: resend it
      this.e.trace('session-handshake-resent');
      await this.sendControl('hello');
      return;
    }
    // The peer asked although our handshake was acknowledged => it lost its session (reinstall, cleared vault).
    await this._createAsInitiator({ force: true });
  }
  /** Deliberate re-pair from the UI. */
  async repair() { await this.load(); if (this.isInitiator) await this._createAsInitiator({ force: true }); else { this.lastRequest = 0; await this.requestSession(); } }

  async _createAsInitiator({ force }) {
    const created = await this.lock.run(this.convId, async () => {
      if (this.session && !force) return false; // 7.2: reuse unless explicitly forced
      this.setStatus('setting-up');
      let bundle;
      try { bundle = await this.e.api.getPeerBundle(this.convId); } catch (err) {
        const registryLost = !!this.meta.peerIdentity;
        this.setStatus(registryLost ? 'registry-lost' : 'waiting-peer-keys');
        this.e.trace('peer-bundle-unavailable', { code: err.code || 'net', known: registryLost });
        try { await this.e.api.requestRepair(this.convId, 'bundle'); } catch { /* best effort */ }
        return false;
      }
      let r;
      try { r = await x3dhInitiate(this.e.keystore.identity, bundle); } catch (err) {
        this.setStatus('error'); this.error = err.code || 'x3dh-failed';
        this.e.trace('session-refused', { code: err.code || 'x3dh-failed' });
        return false;
      }
      if (this.session) { this._retire(this.session.gen); }
      const changed = this.meta.peerIdentity && this.meta.peerIdentity.dh !== r.peerIdentity.dh;
      this.meta.peerIdentity = r.peerIdentity;
      if (changed) this.meta.identityChanged = true;
      this.session = { convId: this.convId, gen: r.generation, role: 'initiator', ratchet: r.ratchet, initEnv: r.envelope, acked: false, sent: [], createdAt: Date.now() };
      this.lastRepair = Date.now();
      await this.persist.mark();
      this.e.trace(force ? 'session-repaired' : 'session-created', { gen: r.generation.slice(0, 6) });
      this.setStatus('ready');
      return true;
    });
    if (created) { await this.retryPending(); await this.sendControl('hello'); }
    return created;
  }
  _retire(gen) { if (!this.meta.retired.includes(gen)) this.meta.retired.push(gen); this.meta.retired = this.meta.retired.slice(-50); }

  // -- sending (7.3, 7.10) -----------------------------------------------------------
  async sendControl(k) { return this.send({ t: 'ctl', k }, { type: 'ctl' }); }

  async send(payload, { type = 'text', mediaId = null, mediaMeta = null, editsClientId = null } = {}) {
    await this.load();
    const item = await this.lock.run(this.convId, async () => {
      if (!this.session || !canSend(this.session.ratchet)) throw new CryptoError('not-ready', this.status);
      const clientId = randId(12);
      const env = await ratchetEncrypt(this.session.ratchet, enc.encode(JSON.stringify(payload)));
      // 7.3: the handshake rides on messages until the peer acknowledges it. Same envelope, same generation.
      if (this.session.initEnv && !this.session.acked) env.x3dh = this.session.initEnv;
      this.session.sent.push(clientId); this.session.sent = this.session.sent.slice(-60);
      // 7.10: persist the advanced ratchet BEFORE the message can leave the device.
      await this.persist.mark();
      const it = { clientId, convId: this.convId, type, ciphertext: JSON.stringify(env), mediaId, mediaMeta, editsClientId, payload, gen: this.session.gen, createdAt: Date.now() };
      await this.e.sput('outbox', clientId, it);
      await this.e.sput('plain', 'c:' + clientId, { state: 'ok', payload });
      this.outcomes.set('c:' + clientId, { state: 'ok', payload });
      return it;
    });
    this.emitChange('outbox');
    this.flush();
    return item;
  }

  /** Posts queued messages in order; retries send the SAME ciphertext + clientId (server dedupes). */
  flush() {
    // Anything queued while a pass is running must still go out: ask the running loop for another pass.
    if (this.flushing) { this.flushAgain = true; return this.flushing; }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          const items = await this.pendingOutbox();
          let stalled = false;
          for (const it of items) {
            try {
              const row = await this.e.api.postMessage({ conversationId: this.convId, clientId: it.clientId, type: it.type, ciphertext: it.ciphertext, mediaId: it.mediaId, mediaMeta: it.mediaMeta, editsClientId: it.editsClientId });
              await this.e.sput('plain', 'm:' + row.id, { state: 'ok', payload: it.payload });
              this.outcomes.set(row.id, { state: 'ok', payload: it.payload });
              await this.e.db.del('outbox', it.clientId);
              this.emit({ kind: 'sent', convId: this.convId, clientId: it.clientId, row });
              this.e.emit({ kind: 'sent', convId: this.convId, clientId: it.clientId, row });
            } catch (err) {
              if (err.permanent) { await this.e.db.del('outbox', it.clientId); this.emitChange('send-failed'); continue; }
              this.e.trace('send-deferred', { code: err.code || 'net' });
              stalled = true; break; // keep order: stop at the first transient failure
            }
          }
          if (stalled) break;
        } while (this.flushAgain);
      } finally { this.flushing = null; this.flushAgain = false; }
    })();
    return this.flushing;
  }
  async pendingOutbox() {
    const out = [];
    for (const k of await this.e.db.keys('outbox')) { const it = await this.e.sget('outbox', k); if (it && it.convId === this.convId) out.push(it); }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Delivered receipts prove the peer holds our session: stop attaching the handshake. */
  async onReceipt(ids) {
    await this.load();
    if (this.session && this.session.initEnv && !this.session.acked && ids.some((id) => this.session.sent.includes(id))) { /* ids here are clientIds */
      this._ack();
    }
  }
  _ack() {
    if (!this.session || !this.session.initEnv) return;
    this.session.initEnv = null; this.session.acked = true;
    this.persist.mark();
    this.e.trace('handshake-acked');
  }

  // -- receiving (7.4–7.9, 7.13) ---------------------------------------------------------
  async _loadOutcome(key) {
    let o = this.outcomes.get(key);
    if (o) return o;
    o = await this.e.sget('plain', key.startsWith('c:') ? key : 'm:' + key);
    if (o) this.outcomes.set(key, o);
    return o;
  }
  async _setOutcome(rowId, o) {
    this.outcomes.set(rowId, o);
    await this.e.sput('plain', 'm:' + rowId, o);
    return o;
  }

  /** Decrypt exactly once per row (7.8). Never throws (7.13). */
  async decodeRow(row) {
    try {
      await this.load();
      if (row.deletedAt) return { state: 'deleted' };
      const cached = await this._loadOutcome(row.id);
      if (cached) return cached; // 7.9: dead rows end here, before any work
      if (row.senderId === this.selfId) {
        const mine = row.clientId ? await this._loadOutcome('c:' + row.clientId) : null;
        if (mine) { await this._setOutcome(row.id, mine); return mine; }
        return this._setOutcome(row.id, { state: 'dead', reason: 'own-unavailable' });
      }
      if (this.inflight.has(row.id)) return this.inflight.get(row.id);
      const p = this.lock.run(this.convId, () => this._decodeLocked(row)).finally(() => this.inflight.delete(row.id));
      this.inflight.set(row.id, p);
      return await p;
    } catch (err) {
      this.e.trace('decode-error', { code: err.code || 'unknown' });
      return { state: 'failed', reason: 'internal' };
    }
  }

  async _decodeLocked(row) {
    const again = await this._loadOutcome(row.id);
    if (again) return again;
    let envelope;
    try { envelope = JSON.parse(row.ciphertext); } catch { return this._setOutcome(row.id, { state: 'failed', reason: 'malformed' }); }
    try {
      if (envelope.x3dh) {
        const gen = envelope.x3dh.generation;
        if (this.session && this.session.gen === gen) {
          this.e.trace('session-replay-ignored'); // 7.4/7.5: same generation id => same envelope again
        } else if (this.meta.retired.includes(gen)) {
          this.e.trace('session-superseded');
          return this._setOutcome(row.id, { state: 'dead', reason: 'superseded' });
        } else {
          // 7.6/7.7: detect envelope → establish session → clear cached failure → decrypt.
          const stale = this.outcomes.get(row.id);
          if (stale && stale.state === 'failed') { this.outcomes.delete(row.id); await this.e.db.del('plain', 'm:' + row.id); }
          await this._adopt(envelope.x3dh);
        }
      }
      if (!this.session) {
        this.pending.set(row.id, row); // not a permanent failure: do not memoise
        this.setStatus('waiting-handshake');
        this.requestSession();
        return { state: 'pending', reason: 'no-session' };
      }
      const { plaintext, state } = await ratchetDecrypt(this.session.ratchet, envelope);
      this.session.ratchet = state;
      if (this.session.initEnv) this._ack(); // a message that decrypts proves the peer has our session
      await this.persist.mark();
      this.pending.delete(row.id);
      const payload = JSON.parse(dec.decode(plaintext));
      this.setStatus(this._computeStatus());
      return this._setOutcome(row.id, { state: 'ok', payload });
    } catch (err) {
      if (err.code === 'otk-missing') { this.e.trace('session-refused', { code: 'otk-missing' }); return this._setOutcome(row.id, { state: 'dead', reason: 'otk-missing' }); } // 7.9
      if (err.code === 'auth-failed' || err.code === 'spk-missing') { this.e.trace('session-refused', { code: err.code }); return this._setOutcome(row.id, { state: 'dead', reason: 'handshake-rejected' }); }
      this.pending.delete(row.id);
      this.e.trace('decrypt-failed', { code: err.code || 'aead' });
      const reason = this.meta.retired.length ? 'previous-pairing' : 'decrypt-failed';
      return this._setOutcome(row.id, { state: 'failed', reason });
    }
  }

  async _adopt(x) {
    const r = await x3dhRespond(this.e.keystore, x); // may throw otk-missing: nothing has changed yet
    if (r.consumedOtkId !== null) {
      this.e.keystore.otks = this.e.keystore.otks.filter((o) => o.id !== r.consumedOtkId);
      await this.e._persistKeystore();
    }
    const replaced = !!this.session;
    if (this.session) this._retire(this.session.gen);
    const changed = this.meta.peerIdentity && this.meta.peerIdentity.dh !== r.peerIdentity.dh;
    this.meta.peerIdentity = r.peerIdentity;
    if (changed) { this.meta.identityChanged = true; this.e.trace('peer-identity-changed'); }
    this.session = { convId: this.convId, gen: x.generation, role: 'responder', ratchet: r.ratchet, initEnv: null, acked: true, sent: [], createdAt: Date.now() };
    await this.persist.mark();
    this.e.trace('session-adopted', { replaced });
    this.emitChange('session');
  }

  /** After a session appears, rows that were waiting for it get another (single) chance, oldest first. */
  async retryPending() {
    const rows = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    this.pending.clear();
    for (const r of rows) await this.decodeRow(r);
  }

  /**
   * Fetch newest-first pages until we reach rows we have already decoded, then decode the
   * uncached ones oldest → newest so the chain advances in order.
   */
  async catchUp(maxPages = 20) {
    await this.load();
    const collected = [];
    let before = null;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.e.api.fetchMessages(this.convId, { before, limit: 50 });
      let sawCached = false;
      for (const row of page.messages) {
        if (!row.deletedAt && (await this._loadOutcome(row.id))) { sawCached = true; continue; }
        collected.push(row);
      }
      if (sawCached || !page.nextCursor) break;
      before = page.nextCursor;
    }
    collected.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const hadSession = !!this.session;
    for (const row of collected) await this.decodeRow(row);
    if (!hadSession && this.session) await this.retryPending();
    this.e.trace('catch-up', { n: collected.length });
    return collected; // rows decoded this pass, oldest first
  }

  // -- media -----------------------------------------------------------------------------
  async sendMedia({ kind, bytes, mime, name, w, h, thumb, caption, duration, wave }) {
    await this.load();
    if (!this.ready) throw new CryptoError('not-ready', this.status);
    const { key, blob } = await encryptBlob(bytes);
    const { id } = await this.e.api.uploadMedia(this.convId, blob, kind);
    const payload = { t: kind, mediaId: id, key, mime, name, size: bytes.length, w, h, thumb, caption: caption || '', duration: duration || 0, ...(wave ? { wave } : {}) };
    return this.send(payload, { type: kind, mediaId: id, mediaMeta: { size: blob.length } });
  }
  async openMedia(payload) {
    const blob = await this.e.api.downloadMedia(payload.mediaId);
    return decryptBlob(payload.key, blob);
  }
}

export { sleep };
