// Property tests for the rules in spec §7 / §11 (messages decrypt, sessions survive reload,
// no second session, re-handshake adopted, duplicates idempotent, dead rows never retried).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDB } from '../public/js/engine.js';
import { makeClient, newPair, decodeAll, texts } from './helpers.mjs';
import {
  createIdentity, createSignedPrekey, createOneTimePrekeys, buildBundle, verifyBundle,
  x3dhInitiate, x3dhRespond, ratchetEncrypt, ratchetDecrypt, encryptBlob, decryptBlob,
} from '../public/js/crypto.js';
import { enc, dec, Persister, sleep } from '../public/js/util.js';

const say = (c, body) => c.send({ t: 'text', body });

test('primitives: X3DH + Double Ratchet round trip, out-of-order, tamper', async () => {
  const bob = await createIdentity();
  const spk = await createSignedPrekey(bob, 1);
  const otks = await createOneTimePrekeys(1, 2);
  const bundle = await buildBundle(bob, spk, otks);
  assert.equal(await verifyBundle(bundle), true);
  const bad = structuredClone(bundle); bad.spk.pub = bundle.identity.dh;
  assert.equal(await verifyBundle(bad), false, 'tampered signed prekey must fail verification');

  const alice = await createIdentity();
  const init = await x3dhInitiate(alice, { ...bundle, otk: bundle.otks[0] });
  const ks = { identity: bob, spks: [spk], otks };
  const resp = await x3dhRespond(ks, init.envelope);

  const e1 = await ratchetEncrypt(init.ratchet, enc.encode('one'));
  const e2 = await ratchetEncrypt(init.ratchet, enc.encode('two'));
  const e3 = await ratchetEncrypt(init.ratchet, enc.encode('three'));
  let st = resp.ratchet;
  let r = await ratchetDecrypt(st, e3); st = r.state; assert.equal(dec.decode(r.plaintext), 'three'); // out of order
  r = await ratchetDecrypt(st, e1); st = r.state; assert.equal(dec.decode(r.plaintext), 'one');
  r = await ratchetDecrypt(st, e2); st = r.state; assert.equal(dec.decode(r.plaintext), 'two');
  await assert.rejects(ratchetDecrypt(st, e1), 'a used message key must not decrypt again');
  const reply = await ratchetEncrypt(st, enc.encode('back'));
  r = await ratchetDecrypt(init.ratchet, reply); assert.equal(dec.decode(r.plaintext), 'back');
  const tampered = { ...e1, ciphertext: e1.ciphertext.slice(0, -4) + 'AAAA' };
  await assert.rejects(ratchetDecrypt(r.state, tampered));
});

test('3-DH works when the one-time pool is empty (7.11)', async () => {
  const bob = await createIdentity(); const spk = await createSignedPrekey(bob, 1);
  const bundle = await buildBundle(bob, spk, []);
  const alice = await createIdentity();
  const init = await x3dhInitiate(alice, { ...bundle, otk: null });
  const resp = await x3dhRespond({ identity: bob, spks: [spk], otks: [] }, init.envelope);
  const m = await ratchetEncrypt(init.ratchet, enc.encode('hi'));
  assert.equal(dec.decode((await ratchetDecrypt(resp.ratchet, m)).plaintext), 'hi');
});

test('media blobs round-trip and the server copy is opaque', async () => {
  const data = enc.encode('pretend this is a jpeg');
  const { key, blob } = await encryptBlob(data);
  assert.ok(!dec.decode(blob).includes('jpeg'));
  assert.equal(dec.decode(await decryptBlob(key, blob)), 'pretend this is a jpeg');
});

test('first message of a conversation is readable in both directions', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap();
  await say(A.conv, 'first from A');
  await A.conv.flush();
  const dB = await decodeAll(B.conv, server);
  assert.deepEqual(texts(dB), ['first from A']);
  assert.equal(B.conv.status, 'ready');
  await say(B.conv, 'reply from B'); await B.conv.flush();
  const dA = await decodeAll(A.conv, server);
  assert.deepEqual(texts(dA, 'b-user'), ['reply from B']);
  assert.ok(dA.concat(dB).every((d) => d.o.state === 'ok'), 'no damaged rows anywhere');
});

test('7.1: the non-initiating side never mints a session; it asks instead', async () => {
  const { server, convId } = newPair();
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await B.conv.bootstrap();
  assert.equal(B.conv.session, null);
  assert.equal(B.count('session-created'), 0);
  assert.equal(B.conv.status, 'waiting-handshake');
  assert.ok(server.signals.some((s) => s.kind === 'session' && s.to === 'a-user'));
});

test('7.1/7.12: both sides opening at once yields ONE chain and a readable chat', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await Promise.all([A.conv.bootstrap(), B.conv.bootstrap()]);
  await A.conv.onSessionRequest(); // A reacts to B's request
  for (const s of server.signals.splice(0)) assert.equal(s.to, 'a-user');
  const dB = await decodeAll(B.conv, server);
  assert.equal(B.conv.session.gen, A.conv.session.gen, 'exactly one generation exists');
  await say(B.conv, 'b1'); await say(A.conv, 'a1'); await say(B.conv, 'b2'); await say(A.conv, 'a2');
  await A.conv.flush(); await B.conv.flush();
  const all = [...(await decodeAll(A.conv, server)), ...(await decodeAll(B.conv, server))];
  assert.ok(all.every((d) => d.o.state === 'ok'), JSON.stringify(all.filter((d) => d.o.state !== 'ok').map((d) => d.o)));
  assert.equal(dB.length >= 1, true);
});

test('7.2: a session is never rebuilt unless forced', async () => {
  const { server, convId } = newPair();
  await makeClient(server, 'b-user', convId, 'a-user'); // B publishes its bundle first
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  await A.conv.bootstrap();
  const gen = A.conv.session.gen;
  await A.conv.bootstrap(); await A.conv.bootstrap(); await A.conv._createAsInitiator({ force: false });
  assert.equal(A.conv.session.gen, gen);
  assert.equal(A.count('session-created'), 1);
});

test('7.3/7.5: a burst before the peer reads carries one handshake; duplicates are idempotent', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap();
  for (let i = 1; i <= 6; i++) await say(A.conv, 'burst ' + i);
  await A.conv.flush();
  const gens = new Set(server.messages.map((m) => JSON.parse(m.ciphertext).x3dh?.generation));
  assert.equal(gens.size, 1, 'every message carries the same generation id');
  assert.equal(A.count('session-created'), 1, 'no new session per message');
  const dB = await decodeAll(B.conv, server);
  assert.deepEqual(texts(dB), [1, 2, 3, 4, 5, 6].map((i) => 'burst ' + i));
  assert.equal(B.count('session-adopted'), 1);
  assert.ok(B.count('session-replay-ignored') >= 5, 'duplicate envelopes recognised by generation id');
  assert.equal(B.count('session-refused'), 0, 'a consumed one-time prekey is never re-run');
});

test('7.8: decrypting the same row twice (realtime + history) works and is idempotent', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); await say(A.conv, 'once'); await A.conv.flush();
  const row = server.messages.find((m) => JSON.parse(m.ciphertext).header && m.type === 'text');
  const outs = await Promise.all([B.conv.decodeRow(row), B.conv.decodeRow(row), B.conv.decodeRow(row)]);
  assert.ok(outs.every((o) => o.state === 'ok' && o.payload.body === 'once'));
  assert.equal((await B.conv.decodeRow(row)).payload.body, 'once');
});

test('sessions survive a reload (force-close and reopen) with no decrypt errors', async () => {
  const { server, convId } = newPair();
  let A = await makeClient(server, 'a-user', convId, 'b-user');
  let B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); await say(A.conv, 'm1'); await A.conv.flush();
  await decodeAll(B.conv, server);
  await say(B.conv, 'm2'); await B.conv.flush(); await decodeAll(A.conv, server);
  await A.conv.persist.flush(); await B.conv.persist.flush(); await A.engine.ksPersist.flush(); await B.engine.ksPersist.flush();
  // "force close": new engines on the same db + master key
  A = await makeClient(server, 'a-user', convId, 'b-user', { db: A.db, mk: A.mk });
  B = await makeClient(server, 'b-user', convId, 'a-user', { db: B.db, mk: B.mk });
  assert.equal(A.conv.session.role, 'initiator', 'session origin survives reload');
  await say(A.conv, 'm3'); await say(B.conv, 'm4'); await A.conv.flush(); await B.conv.flush();
  const all = [...(await decodeAll(A.conv, server)), ...(await decodeAll(B.conv, server))];
  assert.ok(all.every((d) => d.o.state === 'ok'));
  assert.equal(A.count('session-created') + B.count('session-created'), 0, 'nothing was recreated after reload');
  assert.deepEqual(texts(await decodeAll(B.conv, server), 'a-user'), ['m1', 'm3']);
});

test('7.6: the message that carries the handshake decrypts (adopt BEFORE decrypt)', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); await A.conv.flush();
  const hello = server.messages[0];
  const o = await B.conv.decodeRow(hello);
  assert.equal(o.state, 'ok');
});

test('7.7/14.4: a peer that reinstalls (wiped vault) re-pairs and chat continues without clearing data', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  let B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); await say(A.conv, 'before'); await A.conv.flush(); await decodeAll(B.conv, server);
  await say(B.conv, 'ack'); await B.conv.flush(); await decodeAll(A.conv, server); // A's handshake acked
  // B reinstalls: brand-new db, brand-new keys, same user id
  B = await makeClient(server, 'b-user', convId, 'a-user');
  await B.conv.bootstrap();
  assert.equal(B.conv.session, null);
  const req = server.signals.splice(0).filter((s) => s.kind === 'session' && s.to === 'a-user');
  assert.ok(req.length >= 1);
  await A.conv.onSessionRequest(); // A force re-pairs (peer lost its session)
  assert.equal(A.count('session-repaired'), 1);
  const dB = await decodeAll(B.conv, server);
  assert.equal(B.conv.status, 'ready');
  await say(B.conv, 'hello again'); await say(A.conv, 'welcome back'); await A.conv.flush(); await B.conv.flush();
  const dA = await decodeAll(A.conv, server); const dB2 = await decodeAll(B.conv, server);
  assert.deepEqual(texts(dA, 'b-user').slice(-1), ['hello again']);
  assert.deepEqual(texts(dB2, 'a-user').slice(-1), ['welcome back']);
  // Old rows are calm dead history, never a crash, and never block live traffic.
  const states = dB2.map((d) => d.o.state);
  assert.ok(states.every((s) => ['ok', 'dead', 'failed'].includes(s)), states.join());
  assert.equal(dB.length > 0, true);
});

test('7.9: a handshake naming a one-time prekey we no longer hold is retired once and never retried', async () => {
  const { server, convId } = newPair();
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  await A.conv.bootstrap(); await say(A.conv, 'doomed'); await A.conv.flush();
  // Simulate B having lost its prekey secrets by dropping every held one-time prekey.
  B.engine.keystore.otks = [];
  const rows = server.messages.filter((m) => JSON.parse(m.ciphertext).x3dh?.usedOneTimePreKeyId != null);
  assert.ok(rows.length > 0, 'initiator consumed a one-time prekey');
  const before = B.events.length;
  const o1 = await B.conv.decodeRow(rows[0]);
  assert.equal(o1.state, 'dead'); assert.equal(o1.reason, 'otk-missing');
  const afterFirst = B.events.length;
  for (let i = 0; i < 5; i++) assert.equal((await B.conv.decodeRow(rows[0])).state, 'dead');
  assert.equal(B.events.length, afterFirst, 'no work, no x3dh, no trace noise on retry');
  assert.ok(afterFirst > before);
  // ...and it persisted across a reload
  await B.engine.ksPersist.flush();
  const B2 = await makeClient(server, 'b-user', convId, 'a-user', { db: B.db, mk: B.mk });
  assert.equal((await B2.conv.decodeRow(rows[0])).reason, 'otk-missing');
});

test('7.13: failure to adopt is one damaged row, never an exception', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); await say(A.conv, 'x'); await A.conv.flush();
  const garbage = { id: 'g1', senderId: 'a-user', createdAt: 99999, ciphertext: '{not json', clientId: 'g' };
  assert.equal((await B.conv.decodeRow(garbage)).state, 'failed');
  const evil = JSON.parse(server.messages[0].ciphertext); evil.x3dh.authTag = 'AAAA';
  const o = await B.conv.decodeRow({ id: 'g2', senderId: 'a-user', createdAt: 99998, ciphertext: JSON.stringify(evil), clientId: 'h' });
  assert.equal(o.state, 'dead');
  const good = await decodeAll(B.conv, server);
  assert.ok(good.some((d) => d.o.state === 'ok'), 'conversation still readable after a forged handshake');
});

test('7.11: registry wipe self-heals: re-publish on unlock restores a usable bundle', async () => {
  const { server, convId } = newPair();
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  server.wipeRegistry();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  await A.conv.bootstrap();
  assert.equal(A.conv.status, 'waiting-peer-keys');
  assert.ok(server.signals.some((s) => s.kind === 'bundle' && s.to === 'b-user'));
  await B.engine.publish(); // what B does on unlock / on a repair signal
  await A.conv.bootstrap();
  assert.equal(A.conv.status, 'ready');
  await say(A.conv, 'works without otks'); await A.conv.flush();
  assert.deepEqual(texts(await decodeAll(B.conv, server)), ['works without otks']);
});

test('registry loss after contact is reported precisely (not "waiting for your contact")', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); await A.conv.flush(); await decodeAll(B.conv, server);
  server.wipeRegistry();
  await A.conv._createAsInitiator({ force: true });
  assert.equal(A.conv.status, 'registry-lost');
});

test('7.10: the persister never loses a mutation that lands during a write', async () => {
  let state = { n: 0 }; const written = [];
  const p = new Persister(() => ({ ...state }), async (snap) => { await sleep(15); written.push(snap.n); });
  state.n = 1; p.mark();
  await sleep(5); state.n = 2; p.mark(); // lands while the first write is in flight
  await p.flush();
  assert.equal(written[written.length - 1], 2);
});

test('edits are ordinary encrypted messages; retries resend the same ciphertext', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap();
  const it = await say(A.conv, 'original'); await A.conv.flush();
  // simulate a lost response: item already stored by the server, client retries with the same clientId
  const dup = await server.api('a-user').postMessage({ conversationId: convId, clientId: it.clientId, type: 'text', ciphertext: it.ciphertext });
  assert.equal(server.messages.filter((m) => m.clientId === it.clientId).length, 1);
  assert.ok(dup.id);
  await A.conv.send({ t: 'edit', ref: it.clientId, body: 'edited' }, { type: 'edit', editsClientId: it.clientId }); await A.conv.flush();
  const dB = await decodeAll(B.conv, server);
  assert.ok(dB.some((d) => d.o.payload?.t === 'edit' && d.o.payload.body === 'edited'));
});

test('media message carries the file key inside the E2EE payload only', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  const B = await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap();
  await A.conv.sendMedia({ kind: 'image', bytes: enc.encode('PNGDATA'), mime: 'image/png', name: 'secret-name.png', w: 1, h: 1, thumb: '' });
  await A.conv.flush();
  const row = server.messages.find((m) => m.type === 'image');
  assert.ok(!row.ciphertext.includes('secret-name'), 'filename is not visible to the server');
  const d = await decodeAll(B.conv, server);
  const img = d.find((x) => x.o.payload?.t === 'image');
  assert.equal(img.o.payload.name, 'secret-name.png');
  assert.equal(dec.decode(await B.conv.openMedia(img.o.payload)), 'PNGDATA');
});

test('a message queued while a flush is already running is still delivered', async () => {
  const { server, convId } = newPair();
  const A = await makeClient(server, 'a-user', convId, 'b-user');
  await makeClient(server, 'b-user', convId, 'a-user');
  await A.conv.bootstrap(); // queues and starts flushing the hello
  await say(A.conv, 'queued during flush');
  await A.conv.flush();
  assert.ok(server.messages.some((m) => m.type === 'text'), 'text reached the server');
  assert.equal((await A.conv.pendingOutbox()).length, 0);
});
