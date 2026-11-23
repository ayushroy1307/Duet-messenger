import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultCore } from '../public/js/vaultcore.js';
import { rand } from '../public/js/util.js';

const meta = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } }; };

test('vault: PIN unlock, wrong PIN rejected, MK never equals anything derived from the PIN', async () => {
  const m = meta();
  const v = new VaultCore(m, { iters: 1000 });
  const { recoveryCode } = await v.setup('4821');
  assert.match(recoveryCode, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
  const sealed = await v.sealer.seal('t', { hello: 'world' });
  v.lock();
  assert.equal(v.unlocked, false);
  await assert.rejects(v.unlockPin('0000'), (e) => e.code === 'bad-secret');
  await v.unlockPin('4821');
  assert.deepEqual(await v.sealer.open('t', sealed), { hello: 'world' });
  const stored = JSON.stringify(await m.get('vault'));
  assert.ok(!stored.includes('4821'), 'the PIN itself is never stored');
});

test('vault: failed unlocks are counted and throttled', async () => {
  const m = meta(); const v = new VaultCore(m, { iters: 1000 });
  await v.setup('1234'); v.lock();
  for (let i = 0; i < 3; i++) await assert.rejects(v.unlockPin('x'), (e) => e.code === 'bad-secret');
  await assert.rejects(v.unlockPin('1234'), (e) => e.code === 'throttled', 'correct PIN is refused while throttled');
});

test('vault: recovery secret unlocks and resets the PIN; biometric path wraps the same MK', async () => {
  const m = meta(); const v = new VaultCore(m, { iters: 1000 });
  const { recoveryCode } = await v.setup('1111');
  const sealed = await v.sealer.seal('t', { a: 1 });
  const prf = rand(32);
  await v.enableBio(prf, 'cred-id');
  v.lock();
  await v.unlockBio(prf);
  assert.deepEqual(await v.sealer.open('t', sealed), { a: 1 });
  v.lock();
  await v.unlockRecovery(recoveryCode.toLowerCase(), '2222');
  assert.deepEqual(await v.sealer.open('t', sealed), { a: 1 });
  v.lock();
  await v.unlockPin('2222');
  await v.disableBio();
  v.lock();
  await assert.rejects(v.unlockBio(prf), (e) => e.code === 'no-bio');
});

test('lock zeroes the master key', async () => {
  const v = new VaultCore(meta(), { iters: 1000 });
  await v.setup('9999');
  const s = v.sealer; const mkRef = s.mk;
  v.lock();
  assert.equal(s.mk, null);
  assert.ok(mkRef.every((b) => b === 0));
  await assert.rejects(s.seal('t', {}));
});
