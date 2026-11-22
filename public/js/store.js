import { useState, useEffect } from './preact.js';
import { api, ApiError } from './api.js';
import { Vault, VaultError, biometricAvailability, normalizeRecoverySecret } from './vault.js';
import { engine, EngineError } from './engine.js';
import { diag } from './diag.js';
import { dbEstimate, requestPersistence } from './db.js';
import { enablePush, disablePush, pushSupportStatus } from './push.js';
import { uid, truncate, isOnline } from './util.js';
import {
  b64, encryptMedia, randomBytes, unb64
} from './crypto.js';

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEY = 'duet:settings:v1';
const INVITE_KEY = 'duet:pending-invite:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  hidePreviews: false,
  autoLockMinutes: 5,
  notifications: true,
  presenceVisible: true,
  confirmDelete: true,
  diagnostics: false,
  enterToSend: true
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function emptyActive() {
  return {
    id: null,
    peer: null,
    messages: [],
    loading: false,
    loadingOlder: false,
    hasMore: false,
    cursor: null,
    error: null,
    session: { exists: false, pending: false, generation: null },
    sendError: null,
    uploading: null
  };
}

const initialSettings = loadSettings();

export const state = {
  phase: 'booting',
  build: 'client',
  offline: !isOnline(),
  busy: false,
  auth: {
    user: null,
    hasVault: false,
    isNew: false,
    vapidKey: null,
    maxUploadBytes: 25 * 1024 * 1024
  },
  vault: {
    exists: false,
    unlocked: false,
    biometric: false,
    deviceId: null,
    lastBackupAt: null,
    backupError: null,
    keyError: null
  },
  settings: initialSettings,
  profile: { name: '', color: 0 },
  recovery: { secret: null, ready: false, mode: 'restore' },
  conversations: [],
  requests: { incoming: [], outgoing: [] },
  previews: {},
  active: emptyActive(),
  sheets: { name: null, message: null },
  mediaViewer: null,
  toasts: [],
  canInstall: false,
  pendingInvite: null,
  lock: { error: null, retryAfter: 0, busy: false },
  setup: { status: '', biometric: false, error: null },
  presence: { at: 0 },
  sessions: [],
  storage: { usage: 0, quota: 0 },
  diagnosticsEnabled: false,
  resume: null
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit() {
  for (const listener of listeners) {
    try { listener(state); } catch (error) { console.error(error); }
  }
}

export function setState(patch) {
  if (typeof patch === 'function') patch(state);
  else Object.assign(state, patch);
  emit();
}

export function mutate(fn) {
  fn(state);
  emit();
}

export function useApp() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((value) => value + 1)), []);
  return state;
}

/* -------------------------------------------------------------------------- */
/* Small UI helpers                                                           */
/* -------------------------------------------------------------------------- */

let toastId = 0;

export function toast(message, { tone = 'neutral', timeout = 5200, action = null } = {}) {
  const id = ++toastId;
  state.toasts = [...state.toasts, { id, message, tone, action }].slice(-3);
  emit();
  if (timeout > 0) {
    setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id) {
  const next = state.toasts.filter((item) => item.id !== id);
  if (next.length !== state.toasts.length) {
    state.toasts = next;
    emit();
  }
}

export function openSheet(name, extra = null) {
  state.sheets = { name, ...(extra || {}) };
  emit();
}

export function closeSheet() {
  state.sheets = { name: null, message: null };
  emit();
}

export function openMediaViewer(view) {
  state.mediaViewer = view;
  emit();
}

export function closeMediaViewer() {
  state.mediaViewer = null;
  emit();
}

export function setPhase(phase, patch = {}) {
  state.phase = phase;
  Object.assign(state, patch);
  emit();
}

function errorMessage(error) {
  if (!error) return 'Something went wrong.';
  if (error instanceof ApiError) return error.message;
  if (error instanceof VaultError) return error.message;
  if (error instanceof EngineError) return error.message;
  return error.message || 'Something went wrong.';
}

export function applyTheme() {
  const theme = state.settings.theme;
  const dark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#101117' : '#F7F7FA');
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* private mode */ }
  diag.configure({ enabled: state.settings.diagnostics });
  applyTheme();
  if (Object.prototype.hasOwnProperty.call(patch, 'presenceVisible') && state.vault.unlocked) {
    beatPresence(true);
  }
  emit();
}

/* -------------------------------------------------------------------------- */
/* Vault + engine                                                             */
/* -------------------------------------------------------------------------- */

let vault = null;
let autoLockTimer = null;
let activityAt = Date.now();
let hiddenAt = 0;
let presenceTimer = null;
let keyRetryTimer = null;

export function getVault() {
  return vault;
}

export function getEngine() {
  return engine;
}

function ensureVaultInstance() {
  if (!state.auth.user) return null;
  if (!vault) vault = new Vault(state.auth.user.id);
  return vault;
}

function syncVaultState() {
  if (!vault) {
    state.vault = { ...state.vault, exists: false, unlocked: false };
    return;
  }
  state.vault = {
    ...state.vault,
    exists: Boolean(vault.meta),
    unlocked: !vault.locked,
    biometric: Boolean(vault.meta?.biometric),
    deviceId: vault.meta?.deviceId || vault.deviceId || null,
    lastBackupAt: vault.lastBackupAt || state.vault.lastBackupAt || null,
    backupError: vault.lastBackupError || null
  };
}

export async function boot() {
  applyTheme();
  diag.configure({ enabled: state.settings.diagnostics, build: state.build });
  installGlobalListeners();
  state.pendingInvite = readPendingInvite();
  state.offline = !isOnline();

  try {
    const me = await api.me();
    state.auth = {
      ...state.auth,
      user: me.user,
      hasVault: Boolean(me.hasVault),
      vapidKey: me.vapidPublicKey || null,
      maxUploadBytes: Number(me.maxUploadBytes || 25 * 1024 * 1024)
    };
    state.build = me.build || 'client';
    diag.configure({ build: state.build });
    if (!me.user.displayName) {
      state.profile = { name: '', color: Number(me.user.avatarColor || 0) };
      setPhase('profile');
      return;
    }
    await resolveVault();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setPhase('welcome');
      return;
    }
    setPhase('welcome', {
      bootError: errorMessage(error)
    });
  }
}

export async function resolveVault() {
  if (!state.auth.user) {
    setPhase('welcome');
    return;
  }
  const info = await Vault.inspect(state.auth.user.id);
  ensureVaultInstance();
  if (info.exists) {
    await vault.loadMeta();
    syncVaultState();
    if (!vault.meta?.pin && !vault.meta?.biometric) {
      state.recovery = { secret: null, ready: false, mode: 'restore' };
      setPhase('vault-restore');
      return;
    }
    setPhase('locked', { lock: { error: null, retryAfter: 0, busy: false } });
    return;
  }
  if (state.auth.hasVault) {
    state.recovery = { secret: null, ready: false, mode: 'restore' };
    setPhase('vault-restore');
    return;
  }
  state.setup = { status: '', biometric: false, error: null };
  setPhase('vault-setup');
}

async function completeUnlock({ resumed = false } = {}) {
  engine.attach(vault);
  syncVaultState();
  state.vault.unlocked = true;
  state.offline = !isOnline();
  diag.event('vault_unlocked', { reason: resumed ? 'resume' : 'local' });
  try {
    await requestPersistence();
  } catch { /* optional */ }

  publishKeysSoon(0);
  startRealtime();
  startPresence();
  startAutoLock();

  const resume = state.resume;
  if (resume?.phase === 'chat' && resume.id) {
    state.resume = null;
    await refreshConversations().catch(() => {});
    const conversation = state.conversations.find((item) => item.id === resume.id);
    if (conversation) {
      await openConversation(conversation, { keepResume: true }).catch(() => {});
      return;
    }
    setPhase('home');
  } else {
    setPhase('home');
    await refreshAll().catch(() => {});
  }
  void redeemPendingInvite().catch(() => {});
  void resumeOutbox().catch(() => {});
  refreshStorageEstimate();
}

export async function setupVault({ pin, biometric }) {
  const v = ensureVaultInstance();
  if (!v) throw new VaultError('no_user', 'Sign in first.');
  setState({ busy: true, setup: { status: 'Creating your keys…', biometric, error: null } });
  try {
    const result = await v.create({
      pin,
      biometric,
      onState: (status) => setState((s) => { s.setup.status = status; })
    });
    vault = v;
    syncVaultState();
    state.recovery = {
      secret: result.recoverySecret,
      ready: false,
      mode: 'new',
      biometricError: result.biometricError || null,
      backupError: result.backupError || null
    };
    setState({ busy: false, phase: 'vault-recovery-key' });
    return result;
  } catch (error) {
    setState((s) => {
      s.busy = false;
      s.setup.error = errorMessage(error);
    });
    throw error;
  }
}

export async function finishVaultSetup() {
  if (!vault || vault.locked) throw new VaultError('locked', 'The vault is not open.');
  setState({ busy: true });
  await completeUnlock();
  setState({ busy: false });
}

export async function unlockVault(pin) {
  const v = ensureVaultInstance();
  if (!v) return;
  setState((s) => { s.lock = { ...s.lock, busy: true, error: null, retryAfter: 0 }; });
  try {
    await v.unlockWithPin(pin);
    vault = v;
    setState((s) => { s.lock = { ...s.lock, busy: false, error: null }; });
    await completeUnlock();
  } catch (error) {
    setState((s) => {
      s.lock = {
        ...s.lock,
        busy: false,
        error: errorMessage(error),
        retryAfter: error.extra?.retryAfter || 0
      };
    });
  }
}

export async function unlockBiometric() {
  const v = ensureVaultInstance();
  if (!v) return;
  setState((s) => { s.lock = { ...s.lock, busy: true, error: null, retryAfter: 0 }; });
  try {
    await v.unlockWithBiometric();
    vault = v;
    setState((s) => { s.lock = { ...s.lock, busy: false, error: null }; });
    await completeUnlock();
  } catch (error) {
    setState((s) => {
      s.lock = {
        ...s.lock,
        busy: false,
        error: errorMessage(error),
        retryAfter: error.extra?.retryAfter || 0
      };
    });
  }
}

export async function restoreVault(secret) {
  const normalized = normalizeRecoverySecret(secret);
  if (normalized.length !== 24) {
    throw new VaultError('bad_recovery', 'Recovery keys contain 24 letters and numbers.');
  }
  setState({ busy: true });
  try {
    const response = await api.recovery();
    if (!response?.backup) {
      throw new VaultError('no_backup',
        'This account has no encrypted backup yet. Open Duet on the device that has your keys once to create one.');
    }
    const v = ensureVaultInstance();
    await v.recover(normalized, response.backup);
    vault = v;
    syncVaultState();
    state.recovery = { secret: null, ready: true, mode: 'restore' };
    setState({ busy: false, phase: 'vault-new-pin' });
    return response.backup;
  } catch (error) {
    setState({ busy: false });
    throw error;
  }
}

export async function finishRecovery(pin, { biometric = false } = {}) {
  if (!vault) throw new VaultError('locked', 'Recovery is not in progress.');
  setState({ busy: true });
  try {
    const result = await vault.finishRecovery(pin, { biometric });
    state.vault.biometric = Boolean(vault.meta?.biometric);
    if (result?.biometricError) toast(result.biometricError, { tone: 'warn' });
    if (result?.backupError) toast('Key backup pending. Keep your recovery key safe.', { tone: 'warn' });
    await completeUnlock({ resumed: true });
  } finally {
    setState({ busy: false });
  }
}

export async function lockVault(reason = 'manual') {
  stopRealtime();
  stopPresence();
  stopAutoLock();
  clearTimeout(keyRetryTimer);
  if (vault && !vault.locked) {
    try { await vault.lock(); } catch { /* best effort */ }
  }
  const previousPhase = state.phase;
  const previousId = state.active.id;
  engine.detach();
  state.previews = {};
  state.active = emptyActive();
  state.mediaViewer = null;
  state.sheets = { name: null, message: null };
  syncVaultState();
  state.vault.unlocked = false;
  if (previousPhase === 'chat' && previousId) state.resume = { phase: 'chat', id: previousId };
  diag.event('vault_locked', { reason });
  setPhase('locked', { lock: { error: null, retryAfter: 0, busy: false } });
}

export async function changePin(pin) {
  if (!vault) throw new VaultError('locked', 'Unlock the vault first.');
  await vault.changePin(pin);
  toast('PIN updated.', { tone: 'ok' });
}

export async function enableBiometricUnlock() {
  if (!vault) throw new VaultError('locked', 'Unlock the vault first.');
  await vault.enrollBiometric();
  syncVaultState();
  toast('Biometric unlock enabled.', { tone: 'ok' });
}

export async function disableBiometricUnlock() {
  if (!vault) return;
  await vault.disableBiometric();
  syncVaultState();
  toast('Biometric unlock turned off.');
}

export async function regenerateRecovery(returnTo = null) {
  if (!vault) throw new VaultError('locked', 'Unlock the vault first.');
  const secret = await vault.regenerateRecovery();
  state.recovery = { secret, ready: false, mode: 'replace' };
  openSheet('recoveryKey', returnTo ? { returnTo } : null);
  return secret;
}

export async function backupNow() {
  if (!vault) return;
  try {
    await vault.backupNow();
    syncVaultState();
    toast('Encrypted key backup saved.', { tone: 'ok' });
  } catch (error) {
    toast(errorMessage(error), { tone: 'danger' });
  }
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export async function register(username, password, displayName, avatarColor) {
  setState({ busy: true });
  try {
    const result = await api.register(username, password, displayName, avatarColor);
    state.auth = {
      ...state.auth,
      user: result.user,
      hasVault: Boolean(result.hasVault),
      isNew: Boolean(result.isNew)
    };
    state.build = result.build || state.build;
    diag.configure({ build: state.build });
    if (!result.user.displayName) {
      state.profile = { name: '', color: Number(result.user.avatarColor || 0) };
      setPhase('profile', { busy: false });
      return;
    }
    setState({ busy: false });
    await resolveVault();
  } catch (error) {
    setState({ busy: false });
    throw error;
  }
}

export async function login(username, password) {
  setState({ busy: true });
  try {
    const result = await api.login(username, password);
    state.auth = {
      ...state.auth,
      user: result.user,
      hasVault: Boolean(result.hasVault),
      isNew: Boolean(result.isNew)
    };
    state.build = result.build || state.build;
    diag.configure({ build: state.build });
    if (!result.user.displayName) {
      state.profile = { name: '', color: Number(result.user.avatarColor || 0) };
      setPhase('profile', { busy: false });
      return;
    }
    setState({ busy: false });
    await resolveVault();
  } catch (error) {
    setState({ busy: false });
    throw error;
  }
}

export async function saveProfile(name, color) {
  const displayName = String(name || '').trim();
  if (!displayName) throw new ApiError('Enter a display name.', 'invalid_name', 400);
  setState({ busy: true });
  try {
    const result = await api.updateProfile({ displayName, avatarColor: color });
    state.auth.user = result.user;
    setState({ busy: false });
    await resolveVault();
  } catch (error) {
    setState({ busy: false });
    throw error;
  }
}

export async function signOut() {
  stopRealtime();
  stopPresence();
  stopAutoLock();
  if (vault && !vault.locked) {
    try { await vault.lock(); } catch { /* best effort */ }
  }
  try { await api.logout(); } catch { /* cookie may already be gone */ }
  engine.detach();
  vault = null;
  state.auth = { ...state.auth, user: null, hasVault: false, isNew: false };
  state.vault = { exists: false, unlocked: false, biometric: false, deviceId: null, lastBackupAt: null, backupError: null, keyError: null };
  state.conversations = [];
  state.previews = {};
  state.requests = { incoming: [], outgoing: [] };
  state.active = emptyActive();
  state.sessions = [];
  state.resume = null;
  setPhase('welcome');
}

export async function signOutAll() {
  try { await api.logoutAll(); } catch { /* best effort */ }
  await signOut();
  toast('All sessions signed out.', { tone: 'ok' });
}

export function handleAuthExpired() {
  stopRealtime();
  stopPresence();
  stopAutoLock();
  engine.detach();
  state.auth = { ...state.auth, user: null, hasVault: false, isNew: false };
  state.vault = { ...state.vault, unlocked: false };
  state.conversations = [];
  state.previews = {};
  state.active = emptyActive();
  setPhase('welcome');
  toast('Your session expired. Sign in again.', { tone: 'warn' });
}

/* -------------------------------------------------------------------------- */
/* Conversations + messages                                                   */
/* -------------------------------------------------------------------------- */

let previewQueue = [];
let previewBusy = 0;
const previewPending = new Set();

export async function refreshAll() {
  await Promise.allSettled([refreshConversations(), refreshConnections()]);
}

export async function refreshConversations() {
  const result = await api.conversations();
  const previous = new Map(state.conversations.map((item) => [item.id, item]));
  state.conversations = (result.conversations || []).map((conversation) => {
    const old = previous.get(conversation.id);
    return {
      ...conversation,
      peer: {
        ...conversation.peer,
        online: conversation.peer?.online ?? old?.peer?.online ?? false
      }
    };
  });
  prunePreviews();
  emit();
  queuePreviews(state.conversations);
  return state.conversations;
}

export async function refreshConnections() {
  const result = await api.connections();
  state.requests = {
    incoming: result.incoming || [],
    outgoing: result.outgoing || []
  };
  emit();
  return state.requests;
}

function prunePreviews() {
  const ids = new Set(state.conversations.map((item) => item.id));
  for (const key of Object.keys(state.previews)) {
    if (!ids.has(key)) delete state.previews[key];
  }
}

function queuePreviews(conversations) {
  for (const conversation of conversations) {
    if (!conversation.lastMessageAt) continue;
    if (conversation.lastMessageType === 'session') {
      state.previews[conversation.id] = { text: 'Secure session', tone: 'secure', kind: 'session' };
      continue;
    }
    if (state.previews[conversation.id] || previewPending.has(conversation.id)) continue;
    previewPending.add(conversation.id);
    previewQueue.push(conversation);
  }
  pumpPreviews();
}

async function pumpPreviews() {
  if (previewBusy >= 2) return;
  const conversation = previewQueue.shift();
  if (!conversation) return;
  previewBusy += 1;
  try {
    await loadPreview(conversation);
  } catch (error) {
    state.previews[conversation.id] = {
      text: 'Encrypted message',
      tone: 'muted',
      kind: 'unknown'
    };
    diag.event('offline_cache_hit', { reason: error.code || 'preview_failed', cached: false });
  } finally {
    previewPending.delete(conversation.id);
    previewBusy -= 1;
    emit();
    if (previewQueue.length) void pumpPreviews();
  }
}

async function loadPreview(conversation) {
  if (!engine.ready) return;
  const result = await api.messages(conversation.id, { limit: 1 });
  const row = result.messages?.[0];
  if (!row) return;
  if (row.deletedAt) {
    state.previews[conversation.id] = { text: 'Message deleted', tone: 'muted', kind: 'deleted' };
    return;
  }
  if (row.type === 'session') {
    state.previews[conversation.id] = { text: 'Secure session', tone: 'secure', kind: 'session' };
    return;
  }
  if (row.senderId === state.auth.user.id) {
    const payload = await engine.readCached(row.id, {
      variant: row.editedAt ? `edit:${row.editedAt}` : null
    });
    state.previews[conversation.id] = previewFromPayload(payload, true);
    return;
  }
  const decoded = await engine.decodeRow(row, {
    peerId: conversation.peer.id,
    variant: row.editedAt ? `edit:${row.editedAt}` : null
  });
  if (decoded.status === 'ok') {
    state.previews[conversation.id] = previewFromPayload(decoded.payload, false);
  } else {
    state.previews[conversation.id] = {
      text: decoded.reason === 'no_session' ? 'Secure message' : 'Encrypted message',
      tone: 'muted',
      kind: 'unknown'
    };
  }
}

function previewFromPayload(payload, mine) {
  if (!payload) return { text: mine ? 'Sent' : 'Encrypted message', tone: 'muted', kind: 'unknown' };
  if (payload.kind === 'session') return { text: 'Secure session', tone: 'secure', kind: 'session' };
  if (payload.kind === 'media') {
    return {
      text: `${mine ? 'You: ' : ''}${payload.mime?.startsWith('video/') ? 'Video' : 'Photo'}`,
      tone: 'muted',
      kind: 'media'
    };
  }
  if (payload.kind === 'text' && typeof payload.text === 'string') {
    return {
      text: `${mine ? 'You: ' : ''}${truncate(payload.text.replace(/\s+/g, ' '), 90)}`,
      tone: 'text',
      kind: 'text'
    };
  }
  return { text: mine ? 'Sent' : 'Encrypted message', tone: 'muted', kind: 'unknown' };
}

export function closeChat() {
  state.resume = null;
  state.sheets = { name: null, message: null };
  setPhase('home');
}

export async function openConversation(conversation, { keepResume = false } = {}) {
  if (!conversation) return;
  state.sheets = { name: null, message: null };
  state.active = {
    ...emptyActive(),
    id: conversation.id,
    peer: conversation.peer,
    loading: true,
    session: engine.sessionInfo(conversation.id)
  };
  if (!keepResume) state.resume = { phase: 'chat', id: conversation.id };
  setPhase('chat');
  await loadMessages({ older: false });
  await ensureConversationSession(conversation).catch(() => {});
  void markConversationRead();
}

export async function loadMessages({ older }) {
  const active = state.active;
  if (!active.id || active.loadingOlder) return;
  if (older && !active.hasMore) return;
  if (older) state.active.loadingOlder = true;
  else state.active.loading = true;
  state.active.error = null;
  emit();

  try {
    const result = await api.messages(active.id, {
      before: older ? active.cursor : null,
      limit: 40
    });
    const rows = (result.messages || []).slice().reverse();
    const materialized = [];
    for (const row of rows) {
      materialized.push(await materializeRow(row));
    }
    const existing = older ? state.active.messages : [];
    const byId = new Map(existing.map((item) => [item.row.id, item]));
    for (const item of materialized) {
      if (item.row.type === 'session') continue;
      byId.set(item.row.id, item);
    }
    const merged = [...byId.values()].sort(compareMessages);
    state.active = {
      ...state.active,
      messages: merged,
      loading: false,
      loadingOlder: false,
      hasMore: Boolean(result.hasMore),
      cursor: result.nextCursor || null,
      session: engine.sessionInfo(active.id)
    };
    emit();
    if (!older) {
      requestAnimationFrame(() => scrollToLatest(false));
      void markConversationRead();
    }
  } catch (error) {
    state.active = {
      ...state.active,
      loading: false,
      loadingOlder: false,
      error: errorMessage(error)
    };
    emit();
  }
}

function compareMessages(a, b) {
  const left = String(a.row.createdAt || '');
  const right = String(b.row.createdAt || '');
  if (left === right) return String(a.row.id).localeCompare(String(b.row.id));
  return left.localeCompare(right);
}

export async function materializeRow(row) {
  const variant = row.editedAt ? `edit:${row.editedAt}` : null;
  if (row.deletedAt) {
    return { row, status: 'deleted', payload: null };
  }
  if (row.senderId === state.auth.user.id) {
    const payload = await engine.readCached(row.id, { variant });
    return {
      row,
      status: payload ? 'ok' : 'unknown',
      payload: payload || null
    };
  }
  const decoded = await engine.decodeRow(row, {
    peerId: state.active.peer?.id,
    variant
  });
  // If this message failed with a retryable error, schedule a retry
  if (decoded.status === 'damaged' && decoded.retryable) {
    // Debounce retries to avoid hammering
    if (!state.active._retryScheduled) {
      state.active._retryScheduled = true;
      setTimeout(() => {
        state.active._retryScheduled = false;
        if (state.active.id) {
          loadMessages({ older: false }).catch(() => {});
        }
      }, 2000);
    }
  }
  return { row, ...decoded };
}

export async function loadOlder() {
  await loadMessages({ older: true });
}

export function scrollToLatest(smooth = true) {
  const node = document.getElementById('message-scroll');
  if (!node) return;
  node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

export async function markConversationRead() {
  const active = state.active;
  if (!active.id || document.visibilityState !== 'visible') return;
  const conversation = state.conversations.find((item) => item.id === active.id);
  if (conversation) conversation.unreadCount = 0;
  emit();
  try {
    await api.markRead(active.id);
  } catch { /* the next fetch will retry */ }
}

export function notifyConversationPreview(conversationId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  const updatedAt = new Date().toISOString();
  conversation.lastMessageAt = conversation.lastMessageAt || updatedAt;
  if (state.active.id !== conversationId) {
    conversation.unreadCount = Number(conversation.unreadCount || 0) + 1;
    delete state.previews[conversationId];
    queuePreviews([conversation]);
  }
  state.conversations = [...state.conversations].sort((a, b) =>
    String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
  emit();
}

export async function ensureConversationSession(conversation) {
  if (!conversation?.id || !conversation.peer?.id) return { exists: false };
  let info = engine.sessionInfo(conversation.id);
  if (info.exists) {
    state.active.session = info;
    emit();
    return info;
  }
  if (String(state.auth.user.id) < String(conversation.peer.id)) {
    try {
      await sendHiddenSession(conversation.id, conversation.peer.id);
    } catch (error) {
      diag.event('session_refused', {
        conversationId: conversation.id,
        reason: error.code || 'init_failed'
      });
      state.active.sendError = errorMessage(error);
      emit();
    }
  } else {
    // Proactively fetch peer's keys so we're ready when their handshake arrives.
    // This reduces the race window on cold starts.
    api.keys(conversation.id).catch(() => {});
    try { await api.repair(conversation.id); } catch { /* rate-limited is fine */ }
    diag.event('session_repair_requested', { conversationId: conversation.id });
  }
  info = engine.sessionInfo(conversation.id);
  state.active.session = info;
  emit();
  return info;
}

export async function requestSecureSession() {
  const active = state.active;
  if (!active.id || !active.peer) return;
  if (String(state.auth.user.id) < String(active.peer.id)) {
    await engine.resetSession(active.id, active.peer.id);
    await sendHiddenSession(active.id, active.peer.id);
    toast('Secure session re-created. New messages can flow.', { tone: 'ok' });
  } else {
    await engine.requestRepair(active.id);
    toast('Asked your contact to re-establish the secure session.');
  }
  state.active.session = engine.sessionInfo(active.id);
  emit();
}

async function sendHiddenSession(conversationId, peerId) {
  const info = engine.sessionInfo(conversationId);
  if (info.exists && !info.pending) return info;
  // Ensure our keys are published BEFORE sending the handshake message.
  // This prevents the recipient from getting 'keys_unavailable' when they
  // try to adopt the handshake (critical on cold-start platforms like Render).
  await engine.publishKeys();
  const session = await engine.ensureSession(conversationId, peerId);
  if (session?.needsPeer) return { exists: false };
  if (info.exists && !info.pending) return engine.sessionInfo(conversationId);
  const encrypted = await engine.encryptPayload(conversationId, { kind: 'session', v: 1 });
  await api.sendMessage({
    conversationId,
    type: 'session',
    clientId: uid('s'),
    ciphertext: encrypted.ciphertext,
    envelope: encrypted.envelope
  });
  state.active.session = engine.sessionInfo(conversationId);
  emit();
  return state.active.session;
}

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

export async function sendText(text, { replyTo = null } = {}) {
  const body = String(text || '').replace(/\s+$/g, '');
  if (!body.trim()) return null;
  if (!state.active.id) return null;
  const conversation = state.conversations.find((item) => item.id === state.active.id);
  const peerId = state.active.peer?.id || conversation?.peer?.id;
  if (!peerId) throw new EngineError('no_peer', 'This conversation is missing its contact.');

  let info = engine.sessionInfo(state.active.id);
  if (!info.exists) {
    info = await ensureConversationSession(state.active);
  }
  if (!info.exists) {
    const error = new EngineError('no_session',
      'The secure session is not ready yet. Ask your contact to open Duet.');
    state.active.sendError = error.message;
    emit();
    throw error;
  }

  const payload = {
    kind: 'text',
    v: 1,
    text: body.slice(0, 6000),
    at: new Date().toISOString(),
    ...(replyTo ? {
      replyTo: {
        id: replyTo.id,
        preview: truncate(replyTo.preview || '', 140),
        mine: Boolean(replyTo.mine)
      }
    } : {})
  };

  const clientId = uid('m');
  const encrypted = await engine.encryptPayload(state.active.id, payload);
  const optimistic = {
    id: clientId,
    clientId,
    conversationId: state.active.id,
    senderId: state.auth.user.id,
    type: 'text',
    ciphertext: encrypted.ciphertext,
    envelope: encrypted.envelope,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
    editedAt: null,
    deletedAt: null,
    _status: 'sending',
    _payload: payload
  };
  pushOptimistic(optimistic);
  await saveOutbox(optimistic, payload);

  try {
    const result = await api.sendMessage({
      conversationId: state.active.id,
      type: 'text',
      clientId,
      ciphertext: encrypted.ciphertext,
      envelope: encrypted.envelope
    });
    const row = result.message;
    await engine.rememberOwn(row.id, state.active.id, payload);
    replaceOptimistic(clientId, row, payload);
    await clearOutbox(clientId);
    bumpConversation(row, payload);
    state.active.session = engine.sessionInfo(state.active.id);
    state.active.sendError = null;
    emit();
    return row;
  } catch (error) {
    markFailed(clientId, errorMessage(error));
    throw error;
  }
}

export async function sendMedia(file) {
  if (!file || !state.active.id) return null;
  const max = state.auth.maxUploadBytes || 25 * 1024 * 1024;
  if (file.size > max) {
    const error = new Error(`Attachments are limited to ${Math.round(max / 1024 / 1024)} MB.`);
    toast(error.message, { tone: 'warn' });
    throw error;
  }
  const isImage = String(file.type || '').startsWith('image/');
  const isVideo = String(file.type || '').startsWith('video/');
  if (!isImage && !isVideo) {
    toast('Only photos and videos can be attached.', { tone: 'warn' });
    return null;
  }
  if (!engine.sessionInfo(state.active.id).exists) {
    await ensureConversationSession(state.active);
  }
  if (!engine.sessionInfo(state.active.id).exists) {
    throw new EngineError('no_session', 'The secure session is not ready yet.');
  }

  const conversationId = state.active.id;
  state.active.uploading = { name: file.name, progress: 0, kind: isVideo ? 'video' : 'image' };
  emit();

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileKey = b64(randomBytes(32));
    const sealed = encryptMedia(bytes, fileKey);
    const dimensions = isImage ? await imageSize(bytes, file.type) : { width: 0, height: 0 };
    state.active.uploading = { name: file.name, progress: 35, kind: isVideo ? 'video' : 'image' };
    emit();
    const upload = await api.uploadMedia(conversationId, unb64(sealed.ciphertext), file.type);
    state.active.uploading = { name: file.name, progress: 75, kind: isVideo ? 'video' : 'image' };
    emit();

    const payload = {
      kind: 'media',
      v: 1,
      mediaId: upload.id,
      key: fileKey,
      nonce: sealed.nonce,
      mime: file.type,
      size: bytes.length,
      name: file.name,
      width: dimensions.width,
      height: dimensions.height
    };
    const clientId = uid('m');
    const encrypted = await engine.encryptPayload(conversationId, payload);
    const type = isVideo ? 'video' : 'image';
    const optimistic = {
      id: clientId,
      clientId,
      conversationId,
      senderId: state.auth.user.id,
      type,
      ciphertext: encrypted.ciphertext,
      envelope: encrypted.envelope,
      mediaId: upload.id,
      mediaMeta: { mime: file.type, size: bytes.length, width: dimensions.width, height: dimensions.height },
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
      editedAt: null,
      deletedAt: null,
      _status: 'sending',
      _payload: payload
    };
    pushOptimistic(optimistic);
    await saveOutbox(optimistic, payload);
    const result = await api.sendMessage({
      conversationId,
      type,
      clientId,
      ciphertext: encrypted.ciphertext,
      envelope: encrypted.envelope,
      mediaId: upload.id,
      mediaMeta: { mime: file.type, size: bytes.length, width: dimensions.width, height: dimensions.height }
    });
    await engine.rememberOwn(result.message.id, conversationId, payload);
    replaceOptimistic(clientId, result.message, payload);
    await clearOutbox(clientId);
    bumpConversation(result.message, payload);
    diag.event('media_sent', { conversationId, messageId: result.message.id, count: bytes.length });
    state.active.uploading = null;
    emit();
    return result.message;
  } catch (error) {
    state.active.uploading = null;
    emit();
    toast(errorMessage(error), { tone: 'danger' });
    throw error;
  }
}

function imageSize(bytes, mime) {
  return new Promise((resolve) => {
    try {
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
        URL.revokeObjectURL(url);
      };
      image.onerror = () => {
        resolve({ width: 0, height: 0 });
        URL.revokeObjectURL(url);
      };
      image.src = url;
    } catch {
      resolve({ width: 0, height: 0 });
    }
  });
}

function pushOptimistic(message) {
  const item = {
    row: { ...message },
    payload: message._payload,
    status: 'ok',
    optimistic: true
  };
  const rest = state.active.messages.filter((entry) =>
    entry.row.clientId !== message.clientId);
  state.active.messages = [...rest, item].sort(compareMessages);
  emit();
  requestAnimationFrame(() => scrollToLatest(true));
}

function replaceOptimistic(clientId, row, payload) {
  const index = state.active.messages.findIndex((entry) => entry.row.clientId === clientId);
  const item = { row: { ...row, _status: 'sent' }, payload, status: 'ok' };
  if (index === -1) {
    state.active.messages = [...state.active.messages, item].sort(compareMessages);
  } else {
    state.active.messages = [
      ...state.active.messages.slice(0, index),
      item,
      ...state.active.messages.slice(index + 1)
    ];
  }
  emit();
  requestAnimationFrame(() => scrollToLatest(true));
}

function markFailed(clientId, message) {
  const item = state.active.messages.find((entry) => entry.row.clientId === clientId);
  if (item) item.row._status = 'failed';
  state.active.sendError = message;
  emit();
}

function bumpConversation(row, payload) {
  const conversation = state.conversations.find((item) => item.id === row.conversationId);
  if (!conversation) return;
  conversation.lastMessageAt = row.createdAt;
  conversation.lastMessageType = row.type;
  conversation.lastMessageSenderId = row.senderId;
  state.previews[conversation.id] = previewFromPayload(payload, true);
  state.conversations = [...state.conversations].sort((a, b) =>
    String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
}

export async function retryMessage(clientId) {
  const item = state.active.messages.find((entry) => entry.row.clientId === clientId);
  if (!item) return;
  const row = item.row;
  row._status = 'sending';
  emit();
  try {
    const result = await api.sendMessage({
      conversationId: row.conversationId,
      type: row.type,
      clientId: row.clientId,
      ciphertext: row.ciphertext,
      envelope: row.envelope,
      mediaId: row.mediaId || undefined,
      mediaMeta: row.mediaMeta || undefined
    });
    await engine.rememberOwn(result.message.id, row.conversationId, item.payload);
    replaceOptimistic(clientId, result.message, item.payload);
    await clearOutbox(clientId);
    bumpConversation(result.message, item.payload);
    emit();
  } catch (error) {
    markFailed(clientId, errorMessage(error));
  }
}

export async function saveEdit(messageId, text) {
  const body = String(text || '').trim();
  if (!body || !state.active.id) return;
  const item = state.active.messages.find((entry) => entry.row.id === messageId);
  if (!item) return;
  const previous = item.payload;
  const payload = {
    ...(previous && typeof previous === 'object' ? previous : {}),
    kind: 'text',
    v: 1,
    text: body.slice(0, 6000),
    edited: true,
    at: new Date().toISOString()
  };
  const encrypted = await engine.encryptPayload(state.active.id, payload);
  const result = await api.patchMessage(messageId, {
    ciphertext: encrypted.ciphertext,
    envelope: encrypted.envelope
  });
  const row = result.message;
  await engine.rememberOwn(row.id, state.active.id, payload, {
    variant: row.editedAt ? `edit:${row.editedAt}` : null
  });
  const index = state.active.messages.findIndex((entry) => entry.row.id === messageId);
  if (index !== -1) {
    state.active.messages[index] = { row, payload, status: 'ok' };
    state.active.messages = [...state.active.messages];
    emit();
  }
  toast('Message edited.', { tone: 'ok' });
}

export async function deleteMessage(messageId) {
  const item = state.active.messages.find((entry) => entry.row.id === messageId);
  if (!item) return;
  const result = await api.patchMessage(messageId, { deleted: true });
  engine.forgetMessage(messageId);
  const index = state.active.messages.findIndex((entry) => entry.row.id === messageId);
  if (index !== -1) {
    state.active.messages[index] = {
      row: result.message,
      payload: null,
      status: 'deleted'
    };
    state.active.messages = [...state.active.messages];
  }
  state.sheets = { name: null, message: null };
  emit();
  toast('Message deleted.', { tone: 'ok' });
}

export async function retryDamaged() {
  if (!state.active.id) return;
  engine.clearRetryableFailures(state.active.id);
  await loadMessages({ older: false });
  state.active.session = engine.sessionInfo(state.active.id);
  emit();
}

/* -------------------------------------------------------------------------- */
/* Outbox                                                                     */
/* -------------------------------------------------------------------------- */

async function saveOutbox(row, payload) {
  if (!vault) return;
  await vault.writeOutbox(row.clientId, {
    row: {
      conversationId: row.conversationId,
      type: row.type,
      clientId: row.clientId,
      ciphertext: row.ciphertext,
      envelope: row.envelope,
      mediaId: row.mediaId || null,
      mediaMeta: row.mediaMeta || null,
      createdAt: row.createdAt
    },
    payload
  });
}

async function clearOutbox(clientId) {
  if (!vault) return;
  await vault.deleteOutbox(clientId);
}

export async function resumeOutbox() {
  if (!vault || !engine.ready) return;
  const rows = await vault.listOutbox();
  for (const entry of rows) {
    try {
      const result = await api.sendMessage(entry.row);
      if (result?.message) {
        await engine.rememberOwn(result.message.id, entry.row.conversationId, entry.payload);
        await vault.deleteOutbox(entry.row.clientId);
        if (state.active.id === entry.row.conversationId) {
          await loadMessages({ older: false });
        }
      }
    } catch (error) {
      if (error.status === 400 || error.status === 403 || error.status === 404) {
        await vault.deleteOutbox(entry.row.clientId);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Realtime + presence                                                        */
/* -------------------------------------------------------------------------- */

let realtimeEs = null;
let realtimeReconnect = null;

export function startRealtime() {
  if (realtimeEs) return;
  if (!state.auth.user || !state.vault.unlocked) return;
  const url = new URL('/api/realtime', window.location.origin);
  realtimeEs = new EventSource(url, { withCredentials: true });

  realtimeEs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleRealtimeEvent(data);
    } catch { /* ignore */ }
  };

  realtimeEs.onerror = () => {
    realtimeEs.close();
    realtimeEs = null;
    clearTimeout(realtimeReconnect);
    realtimeReconnect = setTimeout(startRealtime, 3000);
  };
}

function stopRealtime() {
  if (realtimeEs) {
    realtimeEs.close();
    realtimeEs = null;
  }
  clearTimeout(realtimeReconnect);
}

function handleRealtimeEvent(data) {
  const { id, kind, ...payload } = data;
  if (kind === 'message') {
    notifyConversationPreview(payload.conversationId);
    if (state.active.id === payload.conversationId && state.vault.unlocked) {
      void loadMessages({ older: false });
    }
  } else if (kind === 'receipt') {
    handleReceipt(payload);
  } else if (kind === 'message_edit' || kind === 'message_deleted') {
    if (state.active.id === payload.conversationId && state.vault.unlocked) {
      void loadMessages({ older: false });
    }
    delete state.previews[payload.conversationId];
    refreshConversations().catch(() => {});
  } else if (kind === 'presence') {
    handlePresence(payload);
  } else if (kind === 'conversation') {
    refreshAll().catch(() => {});
  } else if (kind === 'connection_request') {
    refreshConnections().catch(() => {});
  } else if (kind === 'session_request') {
    if (state.active.id === payload.conversationId && String(state.auth.user.id) > String(payload.fromUserId)) {
      ensureConversationSession(state.active).catch(() => {});
    }
  } else if (kind === 'ready') {
    state.build = payload.build || state.build;
    diag.configure({ build: state.build });
  } else if (kind === 'auth_expired') {
    handleAuthExpired();
  } else if (kind === 'realtime_error') {
    // connection issue, will reconnect
  }
}

function handleReceipt(payload) {
  const { conversationId, kind, at } = payload;
  if (state.active.id !== conversationId) return;
  const messages = state.active.messages;
  let changed = false;
  for (const item of messages) {
    const row = item.row;
    if (row.conversationId === conversationId && row.senderId === state.auth.user.id) {
      if (kind === 'delivered' && !row.deliveredAt) {
        row.deliveredAt = at;
        changed = true;
      } else if (kind === 'read' && !row.readAt) {
        row.readAt = at;
        row.deliveredAt = row.deliveredAt || at;
        changed = true;
      }
    }
  }
  if (changed) {
    state.active.messages = [...messages];
    emit();
  }
  const conversation = state.conversations.find((c) => c.id === conversationId);
  if (conversation) conversation.unreadCount = 0;
}

function handlePresence(payload) {
  const { userId, presenceVisible, lastSeenAt, online } = payload;
  for (const conversation of state.conversations) {
    if (conversation.peer?.id === userId) {
      conversation.peer.presenceVisible = presenceVisible;
      conversation.peer.lastSeenAt = lastSeenAt;
      conversation.peer.online = online;
      break;
    }
  }
  emit();
}

function startPresence() {
  if (presenceTimer) return;
  presenceTimer = setInterval(async () => {
    if (!state.vault.unlocked) return;
    if (document.visibilityState === 'visible') {
      await api.presence(true, true).catch(() => {});
    }
  }, 25_000);
}

function stopPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
}

async function beatPresence(forceOnline = false) {
  if (!state.vault.unlocked) return;
  await api.presence(state.settings.presenceVisible, forceOnline || document.visibilityState === 'visible').catch(() => {});
}

export function noteActivity() {
  activityAt = Date.now();
}

function startAutoLock() {
  if (autoLockTimer) return;
  autoLockTimer = setInterval(() => {
    if (!state.settings.autoLockMinutes || !state.vault.unlocked) return;
    const limit = state.settings.autoLockMinutes * 60_000;
    if (document.visibilityState === 'visible' && Date.now() - activityAt > limit) {
      void lockVault('idle');
    }
  }, 10_000);
}

function stopAutoLock() {
  if (autoLockTimer) clearInterval(autoLockTimer);
  autoLockTimer = null;
}

/* -------------------------------------------------------------------------- */
/* Connections + invites                                                      */
/* -------------------------------------------------------------------------- */

export async function startChat(username) {
  const result = await api.startConnection(username);
  await refreshConversations().catch(() => {});
  if (result.conversationId) {
    const conversation = state.conversations.find((item) => item.id === result.conversationId);
    closeSheet();
    if (conversation) await openConversation(conversation);
    else await refreshConversations();
    return result;
  }
  await refreshConnections().catch(() => {});
  closeSheet();
  if (result.status === 'pending') toast('Request sent. You can chat once they accept.', { tone: 'ok' });
  return result;
}

export async function acceptConnection(requestId) {
  const result = await api.respondConnection(requestId, 'accept');
  await Promise.allSettled([refreshConnections(), refreshConversations()]);
  if (result.conversationId) {
    const conversation = state.conversations.find((item) => item.id === result.conversationId);
    if (conversation) await openConversation(conversation);
  }
  toast('You are connected.', { tone: 'ok' });
}

export async function declineConnection(requestId) {
  await api.respondConnection(requestId, 'decline');
  await refreshConnections();
  toast('Request declined.', { tone: 'ok' });
}

export function storePendingInvite(token) {
  if (!token) return;
  try { localStorage.setItem(INVITE_KEY, token); } catch { /* ignore */ }
  state.pendingInvite = token;
  emit();
}

function readPendingInvite() {
  try {
    return localStorage.getItem(INVITE_KEY) || parseInviteFromLocation();
  } catch {
    return parseInviteFromLocation();
  }
}

export function parseInviteFromLocation() {
  const hashMatch = window.location.hash.match(/#\/invite\/([A-Za-z0-9_-]{16,200})/);
  if (hashMatch) return hashMatch[1];
  const pathMatch = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{16,200})$/);
  return pathMatch ? pathMatch[1] : null;
}

export function clearPendingInvite() {
  try { localStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
  state.pendingInvite = null;
  if (window.location.hash.startsWith('#/invite/')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  emit();
}

export async function redeemPendingInvite() {
  const token = state.pendingInvite;
  if (!token || !state.vault.unlocked) return null;
  try {
    const result = await api.redeemInvite(token);
    clearPendingInvite();
    await Promise.allSettled([refreshConversations(), refreshConnections()]);
    const conversation = state.conversations.find((item) => item.id === result.conversationId) || {
      id: result.conversationId,
      peer: result.peer
    };
    toast('Invite accepted. Say hello.', { tone: 'ok' });
    await openConversation(conversation);
    return result;
  } catch (error) {
    clearPendingInvite();
    toast(errorMessage(error), { tone: 'warn' });
    return null;
  }
}

export async function createInvite(expiresInHours = 72) {
  const result = await api.createInvite(expiresInHours);
  return result.invite;
}

/* -------------------------------------------------------------------------- */
/* Settings + account actions                                                 */
/* -------------------------------------------------------------------------- */

export async function updateProfile(displayName, avatarColor, { returnTo = null } = {}) {
  const result = await api.updateProfile({ displayName, avatarColor });
  state.auth.user = result.user;
  if (returnTo) openSheet(returnTo);
  else closeSheet();
  await refreshConversations().catch(() => {});
  emit();
  toast('Profile updated.', { tone: 'ok' });
}

export async function loadSessions() {
  const result = await api.sessions();
  state.sessions = result.sessions || [];
  emit();
}

export async function togglePush(enabled) {
  if (enabled) {
    const result = await enablePush();
    if (!result.enabled) {
      updateSettings({ notifications: false });
      throw new Error(result.reason || 'Notifications are not available.');
    }
    updateSettings({ notifications: true });
    toast('Notifications enabled.', { tone: 'ok' });
  } else {
    await disablePush();
    updateSettings({ notifications: false });
    toast('Notifications turned off.');
  }
}

export async function installPwa() {
  if (!state.canInstall) return;
  try {
    const promptEvent = state._deferredPrompt;
    if (promptEvent) {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') {
        state.canInstall = false;
        state._deferredPrompt = null;
        emit();
      }
    }
  } catch { /* ignore */ }
}

function installGlobalListeners() {
  window.addEventListener('online', () => {
    state.offline = false;
    if (state.vault.unlocked) {
      void startRealtime();
      void startPresence();
      void publishKeysSoon(0);
      void resumeOutbox();
    }
    emit();
  });
  window.addEventListener('offline', () => {
    state.offline = true;
    emit();
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      noteActivity();
      if (state.vault.unlocked) {
        void beatPresence(true);
        void markConversationRead();
        void resumeOutbox();
      }
    } else {
      hiddenAt = Date.now();
    }
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state._deferredPrompt = event;
    state.canInstall = true;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    state.canInstall = false;
    state._deferredPrompt = null;
    emit();
  });
  window.addEventListener('duet:auth-expired', handleAuthExpired);
}

async function publishKeysSoon(delayMs) {
  if (!engine.ready) return;
  if (keyRetryTimer) clearTimeout(keyRetryTimer);
  keyRetryTimer = setTimeout(async () => {
    try {
      await engine.publishKeys();
    } catch (error) {
      if (error.code === 'locked') return; // vault locked meanwhile
      // Retry with backoff on transient failures
      if (['offline', 'timeout', 'store_unreachable'].includes(error.code)) {
        publishKeysSoon(Math.min(delayMs + 5000, 60000));
      }
    }
  }, delayMs);
}

function refreshStorageEstimate() {
  if (!navigator.storage?.estimate) return;
  navigator.storage.estimate().then((estimate) => {
    state.storage = {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0
    };
    emit();
  }).catch(() => {});
}