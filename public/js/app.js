// Duet client entry: auth phase + vault phase (orthogonal), screens before the main app, lifecycle.
import { S, api, actions, refreshSettings } from './state.js';
import { h, ic, btn, field, clear, avatar, toast, openSheet, closeAllSheets, confirmSheet } from './ui.js';
import { COUNTRIES, flag, defaultCountry, toE164 } from './countries.js';
import { VaultCore } from './vaultcore.js';
import { openStore, metaKV } from './store.js';
import { Engine } from './engine.js';
import { bioAvailable, createBioCredential, bioUnlockSecret } from './bio.js';
import { prepareAvatar } from './media.js';
import { applyTheme, getSettings } from './settings.js';
import { BUILD } from './build.js';
import { renderMain, startMain, stopMain, onSseEvent } from './main.js';

const root = () => document.getElementById('app');
const LAST_USER = 'duet.lastUser';

// ------------------------------------------------------------------ tracing
const diagBuf = []; let diagTimer = null;
function trace(event, fields = {}) {
  if (!getSettings().diagnostics) return; // client tracing is opt-in
  diagBuf.push({ e: event, ...fields });
  if (!diagTimer) diagTimer = setTimeout(async () => {
    diagTimer = null; const batch = diagBuf.splice(0, 50);
    try { await api.diag(BUILD, batch); } catch { /* diagnostics are best-effort */ }
  }, 2000);
}
actions.trace = trace;

// -------------------------------------------------------------------- phases
export function go(phase) { S.phase = phase; render(); }
actions.go = go;

function render() {
  const el = root(); clear(el);
  const screens = { booting: splash, welcome, phone: phoneScreen, otp: otpScreen, profile: profileScreen, 'vault-setup': vaultSetup, locked: lockScreen, unlocked: () => renderMain(el) };
  if (S.phase !== 'unlocked') stopMain();
  const node = (screens[S.phase] || splash)(el);
  if (node) el.append(node);
}
actions.render = render;

const logo = (size = 'hero') => h('div', { class: 'brand' }, ic(size), h('h1', {}, 'Duet'));
function splash() { return h('div', { class: 'splash' }, ic('xl')); }
const errBox = () => h('div', { class: 'err', role: 'alert' });
function busy(button, on) { button.disabled = on; button.style.opacity = on ? '0.6' : ''; }

function welcome() {
  return h('div', { class: 'screen fill' },
    logo(),
    h('p', { class: 'center muted' }, 'A private messenger for exactly two people. Messages are encrypted on your device; the server only ever relays ciphertext.'),
    S.pendingInvite ? h('div', { class: 'notice' }, "You've been invited to a conversation. Sign in to accept it.") : null,
    btn('Get started', { kind: 'primary', block: true, onClick: () => go('phone') }),
    h('p', { class: 'small muted center' }, S.health?.auth === 'otp' ? 'No email, username or password. Your phone number is your identity.' : 'No email needed. Your phone number is your sign-in name.'));
}

function phoneScreen() {
  if (S.health && S.health.auth === 'otp') return phoneOtpScreen();
  let mode = 'login'; // 'login' | 'register'
  const sel = h('select', { class: 'input', 'aria-label': 'Country' }, COUNTRIES.map((c) => h('option', { value: c[0] }, `${flag(c[0])} ${c[1]} (+${c[2]})`)));
  sel.value = defaultCountry();
  const num = h('input', { class: 'input', type: 'tel', inputMode: 'tel', autocomplete: 'username', placeholder: 'Phone number' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password', 'aria-label': 'Repeat password' });
  const code = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: 'Sign-up code', 'aria-label': 'Sign-up code' });
  const err = errBox(); const go1 = btn('Sign in', { kind: 'primary', block: true, type: 'submit' });
  const title = h('h2', {}); const sub = h('p', { class: 'muted small' }); const swap = btn('', { kind: 'quiet', block: true }); const extra = h('div', { class: 'stack' });
  const paint = () => {
    const reg = mode === 'register';
    title.textContent = reg ? 'Create your account' : 'Sign in';
    sub.textContent = reg ? 'Your phone number is your sign-in name. It is not verified by SMS, so choose a strong password and keep it private.' : 'Use the phone number and password you registered with.';
    go1.querySelector('.label').textContent = reg ? 'Create account' : 'Sign in';
    swap.querySelector('.label').textContent = reg ? 'I already have an account' : 'Create a new account';
    pw.autocomplete = reg ? 'new-password' : 'current-password'; err.textContent = '';
    clear(extra); if (reg) extra.append(pw2, ...(S.health?.signupCodeRequired ? [code] : []));
  };
  swap.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; paint(); });
  const form = h('form', { class: 'stack', on: { submit: async (e) => {
    e.preventDefault(); err.textContent = '';
    let phone; try { phone = toE164(sel.value, num.value); } catch (x) { err.textContent = x.message; return; }
    if (mode === 'register') { if (pw.value.length < 8) { err.textContent = 'Use a password of at least 8 characters.'; return; } if (pw.value !== pw2.value) { err.textContent = 'The two passwords do not match.'; return; } }
    busy(go1, true);
    try {
      const r = mode === 'register' ? await api.register(phone, pw.value, code.value.trim()) : await api.login(phone, pw.value);
      S.user = r.user; rememberUser(); await afterSignIn(r.isNew || r.user.needsProfile);
    } catch (x) { err.textContent = x.code === 'rate-limited' ? 'Too many attempts. Please wait a few minutes and try again.' : x.offline ? 'You appear to be offline.' : x.message; }
    finally { busy(go1, false); }
  } } }, h('div', { class: 'phone-row' }, sel, num), pw, extra, err, go1);
  paint();
  if (!S.health) api.health().then((hh) => { S.health = hh; if (S.phase === 'phone') go('phone'); }).catch(() => {});
  return h('div', { class: 'screen fill' }, h('div', { class: 'stack' }, title, sub), form, swap, btn('Back', { kind: 'quiet', onClick: () => go('welcome') }));
}

function phoneOtpScreen() {
  const sel = h('select', { class: 'input', 'aria-label': 'Country' }, COUNTRIES.map((c) => h('option', { value: c[0] }, `${flag(c[0])} ${c[1]} (+${c[2]})`)));
  sel.value = defaultCountry();
  const num = h('input', { class: 'input', type: 'tel', inputMode: 'tel', autocomplete: 'tel-national', placeholder: 'Phone number' });
  const err = errBox(); const go1 = btn('Send code', { kind: 'primary', block: true, type: 'submit' });
  const form = h('form', { class: 'stack', on: { submit: async (e) => {
    e.preventDefault(); err.textContent = '';
    let phone; try { phone = toE164(sel.value, num.value); } catch (x) { err.textContent = x.message; return; }
    busy(go1, true);
    try { const r = await api.sendOtp(phone); S.phoneDraft = phone; S.devCode = r.devCode || null; go('otp'); }
    catch (x) { err.textContent = x.code === 'rate-limited' ? 'Too many attempts. Please wait a little and try again.' : x.offline ? 'You appear to be offline.' : x.message; }
    finally { busy(go1, false); }
  } } },
    h('div', { class: 'phone-row' }, sel, num), err, go1);
  return h('div', { class: 'screen fill' }, h('div', { class: 'stack' }, h('h2', {}, 'What is your number?'), h('p', { class: 'muted small' }, "We'll text you a 6-digit code. Standard message rates may apply.")), form,
    btn('Back', { kind: 'quiet', onClick: () => go('welcome') }));
}

function otpScreen() {
  const code = h('input', { class: 'input code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '••••••', 'aria-label': '6-digit code' });
  const err = errBox(); const ok = btn('Verify', { kind: 'primary', block: true, type: 'submit' });
  const resend = btn('Resend code', { kind: 'quiet', small: true, disabled: true });
  let left = 30; const tick = setInterval(() => { left--; if (!resend.isConnected) return clearInterval(tick); if (left <= 0) { resend.disabled = false; resend.querySelector('.label').textContent = 'Resend code'; clearInterval(tick); } else resend.querySelector('.label').textContent = `Resend in ${left}s`; }, 1000);
  resend.addEventListener('click', async () => { try { const r = await api.sendOtp(S.phoneDraft); S.devCode = r.devCode || null; go('otp'); toast('A new code is on its way'); } catch (x) { err.textContent = x.message; } });
  const submit = async (e) => {
    e?.preventDefault(); err.textContent = ''; busy(ok, true);
    try {
      const r = await api.verifyOtp(S.phoneDraft, code.value.trim());
      S.user = r.user; S.devCode = null; rememberUser(); await afterSignIn(r.isNew || r.user.needsProfile);
    } catch (x) { err.textContent = x.message; code.select(); } finally { busy(ok, false); }
  };
  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, ''); if (code.value.length === 6) submit(); });
  return h('div', { class: 'screen fill' }, logo('lg'),
    h('div', { class: 'stack' }, h('h2', {}, 'Enter your code'), h('p', { class: 'muted small' }, `Sent to ${S.phoneDraft}`)),
    S.devCode ? h('div', { class: 'notice warn' }, h('b', {}, 'Development mode. '), `Your code is ${S.devCode}. `, btn('Fill it in', { small: true, kind: 'quiet', onClick: () => { code.value = S.devCode; submit(); } })) : null,
    h('form', { class: 'stack', on: { submit } }, code, err, ok), h('div', { class: 'row-flex' }, resend, h('span', { class: 'spacer' }), btn('Change number', { kind: 'quiet', small: true, onClick: () => go('phone') })));
}

function profileScreen() {
  let avatarData = S.user.avatar || null;
  const name = h('input', { class: 'input', value: S.user.displayName || '', maxLength: 40, autocomplete: 'name', placeholder: 'Your name' });
  const prev = h('div', {}, avatar({ displayName: name.value || '?', avatar: avatarData }, 'lg'));
  const file = h('input', { type: 'file', accept: 'image/*', class: 'sr', on: { change: async () => { try { avatarData = await prepareAvatar(file.files[0]); clear(prev).append(avatar({ avatar: avatarData }, 'lg')); } catch { toast('Could not use that picture'); } } } });
  name.addEventListener('input', () => { if (!avatarData) clear(prev).append(avatar({ displayName: name.value || '?' }, 'lg')); });
  const err = errBox(); const save = btn('Continue', { kind: 'primary', block: true, type: 'submit' });
  return h('div', { class: 'screen fill' }, h('h2', {}, 'Set up your profile'), h('p', { class: 'muted small' }, 'This is what the other person sees. You can change it later.'),
    h('div', { class: 'row-flex' }, prev, h('label', { class: 'btn btn-sm' }, h('span', { class: 'label' }, 'Choose picture (optional)'), file)),
    h('form', { class: 'stack', on: { submit: async (e) => {
      e.preventDefault(); err.textContent = ''; busy(save, true);
      try { const r = await api.updateProfile({ displayName: name.value, ...(avatarData !== S.user.avatar ? { avatar: avatarData } : {}) }); S.user = r.user; rememberUser(); await afterSignIn(false); }
      catch (x) { err.textContent = x.message; } finally { busy(save, false); }
    } } }, field('Display name', name), err, save));
}

// ---------------------------------------------------------------- vault flow
function rememberUser() { try { localStorage.setItem(LAST_USER, JSON.stringify({ id: S.user.id, displayName: S.user.displayName, avatar: S.user.avatar })); } catch { /* ignore */ } }
async function openUserStore() {
  if (S.store) return;
  S.store = await openStore('duet-' + S.user.id);
  S.vault = new VaultCore(metaKV(S.store));
}
async function afterSignIn(needsProfile) {
  if (needsProfile) return go('profile');
  await openUserStore();
  go((await S.vault.exists()) ? 'locked' : 'vault-setup');
}

function vaultSetup() {
  const wrap = h('div', { class: 'screen fill' });
  const step1 = () => {
    const pin = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 6 characters', 'aria-label': 'New PIN or passphrase' });
    const pin2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repeat it', 'aria-label': 'Repeat PIN or passphrase' });
    const err = errBox(); const go1 = btn('Create vault', { kind: 'primary', block: true, type: 'submit' });
    clear(wrap).append(h('h2', {}, 'Protect Duet on this device'),
      h('p', { class: 'muted small' }, 'A PIN or passphrase locks your keys and messages on this device. It is never stored or sent anywhere. A longer passphrase is stronger than a short PIN.'),
      h('form', { class: 'stack', on: { submit: async (e) => {
        e.preventDefault(); err.textContent = '';
        if (pin.value.length < 6) { err.textContent = 'Use at least 6 characters.'; return; }
        if (pin.value !== pin2.value) { err.textContent = 'The two entries do not match.'; return; }
        busy(go1, true);
        try { const r = await S.vault.setup(pin.value); step2(r.recoveryCode); } catch (x) { err.textContent = x.message; busy(go1, false); }
      } } }, field('PIN or passphrase', pin), field('Confirm', pin2), err, go1));
    pin.focus();
  };
  const step2 = (code) => {
    const sure = h('input', { type: 'checkbox' }); const next = btn('Continue', { kind: 'primary', block: true, disabled: true });
    sure.addEventListener('change', () => { next.disabled = !sure.checked; });
    next.addEventListener('click', () => step3());
    clear(wrap).append(h('h2', {}, 'Save your recovery code'),
      h('div', { class: 'code-box', 'aria-label': 'Recovery code' }, code),
      h('div', { class: 'notice warn' }, h('b', {}, 'Read this carefully. '), 'If you forget your PIN, this code is the only way back in on this device. If you lose both the PIN and this code, your keys and message history on this device are unrecoverable, and no one, including us, can restore them. Messages are not backed up to any server.'),
      btn('Copy code', { block: true, onClick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied'); } catch { toast('Select the code and copy it manually'); } } }),
      h('label', { class: 'check' }, sure, h('span', {}, 'I have saved my recovery code somewhere safe.')), next);
  };
  const step3 = async () => {
    if (!(await bioAvailable())) return finish();
    const err = errBox();
    clear(wrap).append(h('h2', {}, 'Unlock with biometrics?'), h('p', { class: 'muted small' }, 'Use your fingerprint or face to unlock. This uses a hardware-backed secret (WebAuthn PRF) that wraps your key a second time. Your PIN keeps working.'),
      err, btn('Enable biometrics', { kind: 'primary', block: true, onClick: async () => { try { await enableBio(); finish(); } catch (x) { err.textContent = x.message === 'unsupported' ? 'This device or browser cannot protect keys with biometrics, so Duet will use your PIN only.' : 'Biometric setup was cancelled.'; } } }),
      btn('Not now', { kind: 'quiet', block: true, onClick: finish }));
  };
  const finish = () => unlocked();
  step1();
  return wrap;
}

async function enableBio() {
  const r = await createBioCredential(S.user.id, S.user.displayName || 'Duet');
  await S.vault.enableBio(r.prf, r.credentialId);
  r.prf.fill(0);
}
actions.enableBio = enableBio;

function lockScreen() {
  const pin = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'PIN or passphrase', 'aria-label': 'PIN or passphrase' });
  const err = errBox(); const ok = btn('Unlock', { kind: 'primary', block: true, type: 'submit' });
  const wrap = h('div', { class: 'screen fill' });
  const who = h('div', { class: 'lock-user' }, avatar(S.user, 'lg'), h('h2', {}, S.user.displayName || 'Welcome back'), h('p', { class: 'small muted' }, 'Duet is locked'));
  const done = async (fn) => {
    err.textContent = ''; busy(ok, true);
    try { await fn(); await unlocked(); }
    catch (x) {
      err.textContent = x.code === 'throttled' ? `Too many wrong attempts. Try again in ${x.message}s.` : x.code === 'bad-secret' ? 'That is not right.' : x.name === 'NotAllowedError' ? '' : x.message;
      pin.select();
    } finally { busy(ok, false); }
  };
  const bioBtn = btn('Unlock with biometrics', { block: true, onClick: () => done(async () => S.vault.unlockBio(await bioUnlockSecret((await S.store.get('meta', 'vault')).bio.credentialId))) });
  const showBio = async () => { const v = await S.store.get('meta', 'vault'); if (v?.bio && (await bioAvailable())) { wrap.insertBefore(bioBtn, wrap.querySelector('.sec-alt')); } };
  const recover = () => openSheet('Recover with your code', (body, s) => {
    const rc = h('input', { class: 'input', placeholder: 'XXXX-XXXX-…', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Recovery code' });
    const np = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 6 characters', 'aria-label': 'New PIN' });
    const e2 = errBox(); const go1 = btn('Reset PIN and unlock', { kind: 'primary', block: true, type: 'submit' });
    body.append(h('form', { class: 'stack', on: { submit: async (e) => {
      e.preventDefault(); e2.textContent = '';
      if (np.value.length < 6) { e2.textContent = 'Use at least 6 characters.'; return; }
      busy(go1, true);
      try { await S.vault.unlockRecovery(rc.value, np.value); s.close(); await unlocked(); }
      catch (x) { e2.textContent = x.code === 'bad-secret' ? 'That recovery code is not right.' : x.code === 'throttled' ? `Try again in ${x.message}s.` : x.message; busy(go1, false); }
    } } }, field('Recovery code', rc), field('New PIN or passphrase', np), e2, go1));
  });
  wrap.append(who, h('form', { class: 'stack', on: { submit: (e) => { e.preventDefault(); done(() => S.vault.unlockPin(pin.value)); } } }, pin, err, ok),
    h('div', { class: 'sec-alt stack' }, btn('Forgot PIN? Use recovery code', { kind: 'quiet', block: true, onClick: recover }), btn('Sign out', { kind: 'quiet', block: true, onClick: signOut })));
  showBio(); setTimeout(() => pin.focus(), 50);
  return wrap;
}

// ------------------------------------------------------------- unlocked state
async function unlocked() {
  S.engine = new Engine({ selfId: S.user.id, db: S.store, sealer: S.vault.sealer, api, trace, build: BUILD });
  await S.engine.init();
  trace('unlock');
  S.phase = 'unlocked'; render();
  startMain(); armAutoLock();
}
actions.unlocked = unlocked;

export async function lockNow(reason) {
  if (S.phase !== 'unlocked') return;
  trace('lock', { reason: reason || 'manual' });
  closeAllSheets(); document.getElementById('overlay').replaceChildren();
  stopMain();
  try { await S.engine?.destroy(); } catch { /* best effort */ }
  S.engine = null; S.chat = null; S.convs = [];
  S.vault.lock(); // zeroes the master key and every derived key
  go('locked');
}
actions.lock = lockNow;

async function signOut() {
  try { await api.logout(false); } catch { /* offline */ }
  if (S.vault?.unlocked) S.vault.lock();
  stopMain(); S.user = null; S.engine = null;
  try { await S.store?.db.close(); } catch { /* ignore */ }
  S.store = null; S.vault = null; localStorage.removeItem(LAST_USER);
  go('welcome');
}
actions.signOut = signOut;
actions.eraseDevice = async () => {
  const sure = await confirmSheet('Erase this device?', 'This deletes your keys and message history from this device and signs you out. Your contact will need to re-pair with you. This cannot be undone.', 'Erase', { danger: true });
  if (!sure) return;
  try { await api.logout(false); } catch { /* offline */ }
  stopMain(); S.vault?.lock(); await S.store?.destroy(); S.store = null; S.vault = null; S.engine = null; S.user = null;
  localStorage.removeItem(LAST_USER); closeAllSheets(); go('welcome');
};

// --------------------------------------------------------------- auto-lock
let idleAt = Date.now(), hiddenAt = 0, lockTimer = null;
const bump = () => { idleAt = Date.now(); };
function armAutoLock() {
  clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    if (S.phase !== 'unlocked') return clearInterval(lockTimer);
    const mins = getSettings().autolock;
    if (mins > 0 && Date.now() - idleAt > mins * 60000) lockNow('idle');
  }, 5000);
}
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'scroll']) window.addEventListener(ev, bump, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (S.phase !== 'unlocked') return;
  const mins = getSettings().autolock;
  if (document.hidden) { hiddenAt = Date.now(); if (mins === 0) setTimeout(() => { if (document.hidden) lockNow('background'); }, 400); }
  else { if (mins > 0 && hiddenAt && Date.now() - hiddenAt > mins * 60000) lockNow('background'); else { bump(); onSseEvent('resume', {}); } hiddenAt = 0; }
});
window.addEventListener('online', () => { S.online = true; onSseEvent('online', {}); });
window.addEventListener('offline', () => { S.online = false; onSseEvent('offline', {}); });

// --------------------------------------------------------------------- boot
async function boot() {
  applyTheme(); refreshSettings();
  const m = /^\/i\/([\w-]+)$/.exec(location.pathname);
  if (m) { try { sessionStorage.setItem('duet.invite', m[1]); } catch { /* ignore */ } history.replaceState({}, '', '/'); }
  try { S.pendingInvite = sessionStorage.getItem('duet.invite'); } catch { S.pendingInvite = null; }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { S.health = await api.health(); } catch { /* offline */ }
  try {
    const r = await api.me(); S.user = r.user; rememberUser();
    if (r.user.needsProfile) return go('profile');
    await openUserStore();
    go((await S.vault.exists()) ? 'locked' : 'vault-setup');
  } catch (x) {
    if (x.offline) { // offline: the shell and the vault still work from local data
      try { const u = JSON.parse(localStorage.getItem(LAST_USER) || 'null'); if (u) { S.user = u; await openUserStore(); if (await S.vault.exists()) return go('locked'); } } catch { /* fall through */ }
    }
    go('welcome');
  }
  trace('app-boot');
}
actions.sessionLost = async () => { // the server session ended: lock the vault, send the user to sign in again
  if (S.phase === 'unlocked') { await lockNow('session'); }
  S.vault?.lock(); go('phone'); toast('Your session ended. Please sign in again.');
};
boot();
