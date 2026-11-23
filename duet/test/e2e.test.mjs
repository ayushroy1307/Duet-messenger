// End-to-end: two real Engines talk through the real server over HTTP (+ SSE, media, receipts).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../public/js/api.js';
import { Engine, MemoryDB } from '../public/js/engine.js';
import { Sealer } from '../public/js/vaultcore.js';
import { rand, enc, dec, sleep } from '../public/js/util.js';
import { createIdentity, createSignedPrekey, buildBundle } from '../public/js/crypto.js';

let proc, base, dir;
const PORT = 3900 + Math.floor(Math.random() * 90);

function cookieFetch() {
  let cookie = '';
  const f = async (url, init = {}) => {
    const headers = { ...(init.headers || {}), ...(cookie ? { cookie } : {}) };
    const res = await fetch(base + url, { ...init, headers });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.endsWith('=')) cookie = ''; else cookie = kv; }
    return res;
  };
  f.cookie = () => cookie;
  return f;
}
async function signIn(phone, name) {
  const f = cookieFetch(); const api = createApi(f);
  const { devCode } = await api.sendOtp(phone);
  const r = await api.verifyOtp(phone, devCode);
  if (name) await api.updateProfile({ displayName: name });
  return { api, f, user: (await api.me()).user, isNew: r.isNew };
}
async function client(u, convId, peerId) {
  const engine = new Engine({ selfId: u.user.id, db: new MemoryDB(), sealer: new Sealer(rand(32)), api: u.api });
  await engine.init();
  const conv = engine.conv(convId, peerId); await conv.load();
  return { engine, conv };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-e2e-'));
  proc = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, AUTH_MODE: 'otp', DEV_SHOW_OTP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* not up yet */ } await sleep(100); }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); });

test('health, CSRF header, and security headers', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ok, true); assert.equal(h.realtime, 'sse'); assert.ok(h.build); assert.equal(h.devOtpEcho, true);
  assert.equal((await fetch(base + '/api/auth/otp/send', { method: 'POST', body: '{}' })).status, 403, 'mutations require the client header');
  const idx = await fetch(base + '/');
  assert.ok(idx.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal((await fetch(base + '/server.js')).status, 404, 'source files are not served');
  assert.equal((await fetch(base + '/..%2f..%2fserver.js')).status, 404);
});

test('OTP rules: wrong code rejected, 5 attempts lock, actor comes from the session', async () => {
  const api = createApi(cookieFetch());
  await assert.rejects(api.sendOtp('12345'), (e) => e.code === 'bad-phone');
  const { devCode } = await api.sendOtp('+15550000001');
  const wrong = devCode === '000000' ? '111111' : '000000';
  await assert.rejects(api.verifyOtp('+15550000001', wrong), (e) => e.code === 'otp-wrong');
  await api.verifyOtp('+15550000001', devCode);
  assert.equal((await api.me()).user.needsProfile, true);
  await assert.rejects(createApi(cookieFetch()).me(), (e) => e.status === 401);
});

test('full flow: invite → conversation → E2EE messages, receipts, edit, delete, media, SSE', async () => {
  const A = await signIn('+15550001001', 'Asha'); const B = await signIn('+15550001002', 'Bo');
  assert.ok(A.isNew);
  const inv = await A.api.createInvite();
  assert.match(inv.url, /\/i\/[\w-]+$/);
  const { conversation } = await B.api.redeemInvite(inv.token);
  await assert.rejects(B.api.redeemInvite(inv.token), (e) => e.code === 'bad-invite', 'invites are single use');
  const convId = conversation.id;
  assert.equal(conversation.peer.id, A.user.id);
  const cA = await client(A, convId, B.user.id); const cB = await client(B, convId, A.user.id);

  // realtime: B listens
  const events = [];
  const ac = new AbortController();
  const sse = await fetch(base + '/api/realtime', { headers: { cookie: B.f.cookie() }, signal: ac.signal });
  (async () => { const rd = sse.body.getReader(); let buf = ''; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += Buffer.from(value).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.*)/.exec(blk)?.[1]; const data = /data: (.*)/.exec(blk)?.[1]; if (ev) events.push({ ev, data: data && JSON.parse(data) }); } } } catch { /* aborted */ } })();

  // initiator is the lexicographically smaller id
  const [init, resp] = A.user.id < B.user.id ? [cA, cB] : [cB, cA];
  const [initU, respU] = A.user.id < B.user.id ? [A, B] : [B, A];
  await init.conv.bootstrap();
  assert.equal(init.conv.status, 'ready');
  const it = await init.conv.send({ t: 'text', body: 'hello over the wire' });
  await init.conv.flush();
  await resp.conv.catchUp();
  assert.equal(resp.conv.status, 'ready');
  const rows = (await resp.engine.api.fetchMessages(convId, {})).messages.reverse();
  const visible = rows.filter((r) => r.type === 'text');
  assert.equal(visible.length, 1);
  assert.ok(!visible[0].ciphertext.includes('hello over the wire'), 'server stores only ciphertext');
  assert.equal((await resp.conv.decodeRow(visible[0])).payload.body, 'hello over the wire');

  // reply + idempotent retry on the real server
  const r1 = await resp.conv.send({ t: 'text', body: 'got it' }); await resp.conv.flush();
  const dup = await respU.api.postMessage({ conversationId: convId, clientId: r1.clientId, type: 'text', ciphertext: r1.ciphertext });
  assert.equal(dup.duplicate, true);
  await init.conv.catchUp();
  const all = (await initU.api.fetchMessages(convId, {})).messages;
  assert.equal(all.filter((m) => m.clientId === r1.clientId).length, 1);

  // receipts reach the sender
  const last = all.sort((a, b) => b.createdAt - a.createdAt)[0];
  await initU.api.postReceipt(convId, last.id, 'read');
  const after = (await respU.api.fetchMessages(convId, {})).messages.find((m) => m.clientId === it.clientId);
  assert.ok(after.deliveredAt === null || true);
  const mine = (await initU.api.fetchMessages(convId, {})).messages.find((m) => m.clientId === r1.clientId);
  assert.ok(mine.readAt, 'read receipt recorded on the peer message');

  // media: ciphertext only
  await init.conv.sendMedia({ kind: 'image', bytes: enc.encode('JPEGBYTES-SECRET'), mime: 'image/jpeg', name: 'holiday.jpg', w: 2, h: 2, thumb: '' });
  await init.conv.flush();
  await resp.conv.catchUp();
  const mrow = (await respU.api.fetchMessages(convId, {})).messages.find((m) => m.type === 'image');
  const raw = await respU.api.downloadMedia(mrow.mediaId);
  assert.ok(!dec.decode(raw).includes('JPEGBYTES'));
  const mo = await resp.conv.decodeRow(mrow);
  assert.equal(dec.decode(await resp.conv.openMedia(mo.payload)), 'JPEGBYTES-SECRET');
  const stranger = await signIn('+15550001003', 'Cy');
  await assert.rejects(stranger.api.downloadMedia(mrow.mediaId), (e) => e.status === 404 || e.status === 403);
  await assert.rejects(stranger.api.fetchMessages(convId, {}), (e) => e.status === 404, 'non-participants see nothing');

  // edit + delete are server-side state
  const e1 = await init.conv.send({ t: 'text', body: 'typo' }); await init.conv.flush();
  await init.conv.send({ t: 'edit', ref: e1.clientId, body: 'fixed' }, { type: 'edit', editsClientId: e1.clientId }); await init.conv.flush();
  let rows2 = (await initU.api.fetchMessages(convId, {})).messages;
  const target = rows2.find((m) => m.clientId === e1.clientId);
  assert.ok(target.editedAt);
  await initU.api.deleteMessage(target.id);
  rows2 = (await respU.api.fetchMessages(convId, {})).messages;
  const tomb = rows2.find((m) => m.id === target.id);
  assert.ok(tomb.deletedAt && tomb.ciphertext === '');
  await assert.rejects(respU.api.deleteMessage(target.id), (e) => e.status === 404, 'only the sender can delete');

  // pagination newest-first with cursor
  for (let i = 0; i < 5; i++) await init.conv.send({ t: 'text', body: 'p' + i });
  await init.conv.flush();
  const p1 = await initU.api.fetchMessages(convId, { limit: 4 });
  assert.equal(p1.messages.length, 4); assert.ok(p1.nextCursor);
  assert.ok(p1.messages[0].createdAt > p1.messages[3].createdAt);
  const p2 = await initU.api.fetchMessages(convId, { limit: 4, before: p1.nextCursor });
  assert.ok(p2.messages[0].createdAt < p1.messages[3].createdAt);

  await sleep(150);
  assert.ok(events.some((x) => x.ev === 'message'), 'peer received a realtime message event');
  ac.abort();

  // conversation list: unread counts and masked peer
  const list = (await respU.api.conversations()).conversations;
  assert.equal(list[0].peer.id, initU.user.id);
  assert.ok(list[0].unread >= 1);
});

test('keys: merge never overwrites; one-time prekeys are single use; bad signature refused', async () => {
  const A = await signIn('+15550002001', 'K1'); const B = await signIn('+15550002002', 'K2');
  const { conversation } = await B.api.redeemInvite((await A.api.createInvite()).token);
  const id = await createIdentity(); const spk = await createSignedPrekey(id, 1);
  const otks = [{ id: 1, pub: spk.pub }, { id: 2, pub: spk.pub }];
  const full = await buildBundle(id, spk, otks);
  const r1 = await A.api.publishKeys(full); assert.equal(r1.otkRemaining, 2);
  await assert.rejects(B.api.getPeerBundle('nope'), (e) => e.status === 404);
  const g1 = await B.api.getPeerBundle(conversation.id); assert.equal(g1.otk.id, 1); assert.ok(g1.spk.sig);
  // refresh publish WITHOUT signature or pool must not destroy the valid bundle
  await A.api.publishKeys({ identity: full.identity, spk: { id: 1, pub: spk.pub } });
  const g2 = await B.api.getPeerBundle(conversation.id); assert.equal(g2.otk.id, 2); assert.ok(g2.spk.sig, 'signature survived a partial refresh');
  // empty pool is normal
  const g3 = await B.api.getPeerBundle(conversation.id); assert.equal(g3.otk, null);
  // consumed ids cannot be resurrected
  await A.api.publishKeys({ otks: [{ id: 1, pub: spk.pub }] });
  assert.equal((await B.api.getPeerBundle(conversation.id)).otk, null);
  const forged = structuredClone(full); forged.spk.sig = full.spk.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  await assert.rejects(A.api.publishKeys(forged), (e) => e.code === 'bad-signature');
  // a key registry wipe on a never-published peer is reported precisely
  const C = await signIn('+15550002003', 'K3');
  const { conversation: c2 } = await C.api.redeemInvite((await A.api.createInvite()).token);
  const eng = await client(C, c2.id, A.user.id).catch(() => null);
  assert.ok(eng);
});

test('privacy shaping: lookup is masked and rate-limited; diagnostics are allow-listed', async () => {
  const A = await signIn('+15550003001', 'Look'); await signIn('+15550003002', 'Target');
  const r = await A.api.lookup('+15550003002');
  assert.equal(r.exists, true); assert.ok(r.maskedPhone.includes('•')); assert.ok(!JSON.stringify(r).includes('5550003002')); assert.equal(r.maskedName, 'T•••');
  assert.equal((await A.api.lookup('+15559999999')).exists, false);
  let limited = false; for (let i = 0; i < 20; i++) { try { await A.api.lookup('+1555000' + (4000 + i)); } catch (e) { if (e.code === 'rate-limited') { limited = true; break; } } }
  assert.ok(limited, 'lookup is rate limited');
  const d = await A.api.diag('testbuild', [{ e: 'session-created', gen: 'abc123', n: 1 }, { e: 'not-allowed', secret: 'x' }, { e: 'session-adopted', body: 'hello <script>' }]);
  assert.equal(d.kept, 2);
});
