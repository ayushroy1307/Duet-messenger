// Runs the REAL server against a fake Supabase (PostgREST + Storage emulator) and proves that
// accounts, sessions, keys, messages and media survive a restart, and that RLS-style key checks hold.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApi } from '../public/js/api.js';
import { sleep } from '../public/js/util.js';

const KEY = 'service-role-test-key';
const tables = new Map(); const objects = new Map(); const buckets = new Set(); const log = [];
function rows(t) { if (!tables.has(t)) tables.set(t, new Map()); return tables.get(t); }
const fake = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks);
  const send = (st, body, h = {}) => { res.writeHead(st, { 'content-type': 'application/json', ...h }); res.end(body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (req.headers.apikey !== KEY || req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: 'bad key' });
  log.push(`${req.method} ${u.pathname}`);
  let m;
  if ((m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname))) {
    const t = rows(m[1]);
    if (req.method === 'GET') { const lim = Number(u.searchParams.get('limit')); const off = Number(u.searchParams.get('offset')); return send(200, [...t.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(off, off + lim).map((r) => ({ id: r.id, data: r.data }))); }
    if (req.method === 'POST') { for (const r of JSON.parse(raw)) { if (typeof r.id !== 'string' || r.data === undefined) return send(400, { message: 'bad row' }); t.set(r.id, r); } return send(201); }
    if (req.method === 'DELETE') { const ids = [...u.searchParams.get('id').matchAll(/"([^"]+)"/g)].map((x) => x[1]); for (const i of ids) t.delete(i); return send(204); }
  }
  if (u.pathname === '/storage/v1/bucket' && req.method === 'POST') { const b = JSON.parse(raw); if (buckets.has(b.id)) return send(409, { message: 'Duplicate' }); buckets.add(b.id); return send(200, { name: b.id }); }
  if ((m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(u.pathname))) {
    const k = m[1] + '/' + decodeURIComponent(m[2]);
    if (req.method === 'POST') { objects.set(k, raw); return send(200, { Key: k }); }
    if (req.method === 'GET') return objects.has(k) ? send(200, objects.get(k), { 'content-type': 'application/octet-stream' }) : send(404, { message: 'not found' });
    if (req.method === 'DELETE') { objects.delete(k); return send(200, {}); }
  }
  send(404, { message: 'unhandled ' + req.method + ' ' + u.pathname });
});

let fakeUrl, proc, base; const PORT = 4100 + Math.floor(Math.random() * 80);
async function startServer() {
  proc = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), AUTH_MODE: 'otp', DEV_SHOW_OTP: '1', SUPABASE_URL: fakeUrl, SUPABASE_SERVICE_ROLE_KEY: KEY, SUPABASE_BUCKET: 'duet-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* starting */ } await sleep(100); }
  throw new Error('server did not start');
}
async function stopServer() { const exited = new Promise((r) => proc.once('exit', r)); proc.kill('SIGTERM'); await exited; } // graceful: must flush to "Supabase"
function cookieFetch() { let cookie = ''; const f = async (url, init = {}) => { const res = await fetch(base + url, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } }); for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0]; return res; }; f.cookie = () => cookie; f.set = (c) => { cookie = c; }; return f; }
async function signIn(phone, name) { const f = cookieFetch(); const api = createApi(f); const { devCode } = await api.sendOtp(phone); await api.verifyOtp(phone, devCode); await api.updateProfile({ displayName: name }); return { api, f, user: (await api.me()).user }; }

before(async () => { await new Promise((r) => fake.listen(0, '127.0.0.1', r)); fakeUrl = `http://127.0.0.1:${fake.address().port}`; await startServer(); });
after(async () => { try { proc.kill(); } catch { /* gone */ } fake.close(); });

test('server boots on Supabase, creates the bucket, reports the backend', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.store, 'supabase-postgres'); assert.equal(h.media, 'supabase-storage'); assert.equal(h.storeHealth.ok, true);
  assert.ok(buckets.has('duet-test'));
  assert.ok(rows('duet_meta').has('secret'), 'session secret persisted on first boot');
});

let A, B, convId, msgId, mediaId, bundle;
test('data written through the API reaches Postgres tables (ciphertext only)', async () => {
  A = await signIn('+15550007001', 'Asha'); B = await signIn('+15550007002', 'Bo');
  const { conversation } = await B.api.redeemInvite((await A.api.createInvite()).token); convId = conversation.id;
  const { createIdentity, createSignedPrekey, buildBundle } = await import('../public/js/crypto.js');
  const id = await createIdentity(); const spk = await createSignedPrekey(id, 1); bundle = await buildBundle(id, spk, [{ id: 1, pub: spk.pub }]);
  await A.api.publishKeys(bundle);
  const secretText = 'TOP-SECRET-PLAINTEXT';
  const row = await A.api.postMessage({ conversationId: convId, clientId: 'client-id-0001', type: 'text', ciphertext: JSON.stringify({ v: 1, ciphertext: 'b3BhcXVl' }) });
  msgId = row.id;
  mediaId = (await A.api.uploadMedia(convId, new Uint8Array([1, 2, 3, 4, 5]), 'image')).id;
  await sleep(1200); // write-behind
  assert.equal(rows('duet_users').size, 2); assert.equal(rows('duet_conversations').size, 1);
  assert.equal(rows('duet_prekeys').size, 1); assert.equal(rows('duet_sessions').size, 2);
  const m = rows('duet_messages').get(msgId);
  assert.equal(m.conversation_id, convId); assert.equal(m.client_id, 'client-id-0001'); assert.equal(typeof m.created_at, 'number');
  assert.ok(!JSON.stringify([...tables.values()].map((t) => [...t.values()])).includes(secretText));
  assert.equal(objects.get(`duet-test/${mediaId}`).length, 5, 'media blob lives in Storage');
});

test('everything survives a restart (SIGTERM flushes, boot reloads)', async () => {
  const cookie = A.f.cookie();
  await stopServer(); await startServer();
  const f = cookieFetch(); f.set(cookie); const api = createApi(f);
  assert.equal((await api.me()).user.id, A.user.id, 'login session survived');
  const page = await api.fetchMessages(convId, {});
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].clientId, 'client-id-0001');
  assert.deepEqual([...(await api.downloadMedia(mediaId))], [1, 2, 3, 4, 5]);
  const dup = await api.postMessage({ conversationId: convId, clientId: 'client-id-0001', type: 'text', ciphertext: '{"v":1}' });
  assert.equal(dup.duplicate, true, 'idempotency survives a restart');
  const bApi = createApi((() => { const g = cookieFetch(); g.set(B.f.cookie()); return g; })());
  const k = await bApi.getPeerBundle(convId);
  assert.equal(k.identity.dh, bundle.identity.dh); assert.ok(k.spk.sig, 'prekey bundle (with signature) persisted');
  assert.equal(k.otk.id, 1);
});

test('deletes and consumed one-time prekeys are written through too', async () => {
  const f = cookieFetch(); f.set(A.f.cookie()); const api = createApi(f);
  await api.deleteMessage(msgId);
  await stopServer(); // flush
  assert.ok(rows('duet_messages').get(msgId).data.deletedAt, 'tombstone persisted');
  assert.equal(rows('duet_messages').get(msgId).data.ciphertext, '');
  assert.ok(objects.has(`duet-test/${mediaId}`), 'an unreferenced upload is untouched by deleting an unrelated message');
  const consumed = rows('duet_prekeys').get(A.user.id).data.consumed;
  assert.deepEqual(consumed, [1]);
});

test('a wrong service key is rejected by the backend (server refuses to boot)', async () => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT + 1), SUPABASE_URL: fakeUrl, SUPABASE_SERVICE_ROLE_KEY: 'wrong' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await new Promise((r) => p.once('exit', r));
  assert.notEqual(code, 0);
});
