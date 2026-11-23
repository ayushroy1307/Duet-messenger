// Password sign-in (the default, no SMS provider needed) against the real server.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../public/js/api.js';
import { sleep } from '../public/js/util.js';

let proc, base, dir; const PORT = 4300 + Math.floor(Math.random() * 90);
function cookieFetch() { let cookie = ''; const f = async (url, init = {}) => { const res = await fetch(base + url, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } }); for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; } return res; }; return f; }
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-pw-'));
  proc = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, SIGNUP_CODE: 'family-only', NODE_ENV: 'production', COOKIE_SECURE: '', DEV_SHOW_OTP: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* starting */ } await sleep(100); }
  throw new Error('server did not start');
});
after(() => proc?.kill());

test('defaults to password mode, no SMS, and says so in /api/health', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.auth, 'password'); assert.equal(h.signupCodeRequired, true); assert.equal(h.sms, 'off'); assert.equal(h.devOtpEcho, false);
  assert.ok(!h.warnings.some((w) => /SMS|SIGNUP_CODE|DEV_SHOW_OTP/.test(w)), 'no scary warnings for a correctly configured password server: ' + h.warnings);
});
test('code sign-in endpoints are switched off in password mode', async () => {
  const api = createApi(cookieFetch());
  await assert.rejects(api.sendOtp('+15550009999'), (e) => e.status === 404 && e.code === 'auth-mode');
  await assert.rejects(api.verifyOtp('+15550009999', '123456'), (e) => e.status === 404);
});
test('register needs the sign-up code, a decent password, and a new number', async () => {
  const api = createApi(cookieFetch());
  await assert.rejects(api.register('+15550008001', 'longenough1', ''), (e) => e.code === 'bad-signup-code');
  await assert.rejects(api.register('+15550008001', 'longenough1', 'wrong'), (e) => e.code === 'bad-signup-code');
  await assert.rejects(api.register('+15550008001', 'short', 'family-only'), (e) => e.code === 'weak-password');
  await assert.rejects(api.register('12345', 'longenough1', 'family-only'), (e) => e.code === 'bad-phone');
  const r = await api.register('+15550008001', 'longenough1', 'family-only');
  assert.equal(r.isNew, true); assert.equal((await api.me()).user.needsProfile, true);
  assert.ok(!JSON.stringify(r).includes('hash') && !JSON.stringify(r).includes('longenough1'), 'no password material in responses');
  await assert.rejects(createApi(cookieFetch()).register('+15550008001', 'anotherpass9', 'family-only'), (e) => e.code === 'exists');
});
test('login: right password works, wrong or unknown fail identically', async () => {
  const ok = createApi(cookieFetch()); const r = await ok.login('+15550008001', 'longenough1'); assert.equal(r.isNew, false); assert.ok((await ok.me()).user.id);
  const e1 = await createApi(cookieFetch()).login('+15550008001', 'wrongwrong').catch((e) => e);
  const e2 = await createApi(cookieFetch()).login('+15550008777', 'longenough1').catch((e) => e);
  assert.equal(e1.status, 401); assert.equal(e1.code, 'bad-credentials'); assert.equal(e1.message, e2.message, 'unknown number is indistinguishable');
});
test('passwords are hashed at rest (scrypt) and never stored in plain text', async () => {
  await sleep(400);
  const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.ok(!raw.includes('longenough1')); assert.ok(raw.includes('"pw":{"salt"'));
});
test('change password signs out other devices and the old password stops working', async () => {
  const d1 = createApi(cookieFetch()); const d2 = createApi(cookieFetch());
  await d1.login('+15550008001', 'longenough1'); await d2.login('+15550008001', 'longenough1');
  await assert.rejects(d1.changePassword('nope-nope', 'brandnewpass1'), (e) => e.code === 'bad-credentials');
  await assert.rejects(d1.changePassword('longenough1', 'short'), (e) => e.code === 'weak-password');
  await d1.changePassword('longenough1', 'brandnewpass1');
  assert.ok((await d1.me()).user.id, 'this device stays signed in');
  await assert.rejects(d2.me(), (e) => e.status === 401);
  await assert.rejects(createApi(cookieFetch()).login('+15550008001', 'longenough1'), (e) => e.code === 'bad-credentials');
  await createApi(cookieFetch()).login('+15550008001', 'brandnewpass1');
});
test('login attempts are rate limited per number', async () => {
  const api = createApi(cookieFetch()); let limited = false;
  for (let i = 0; i < 12; i++) { try { await api.login('+15550008001', 'guess-' + i); } catch (e) { if (e.code === 'rate-limited') { limited = true; break; } } }
  assert.ok(limited);
});
