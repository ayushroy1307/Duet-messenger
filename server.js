// Duet relay server. Zero dependencies (Node >= 20). It stores ciphertext and public keys only.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackends } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
const CFG = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  publicDir: path.join(__dirname, 'public'),
  authMode: process.env.AUTH_MODE === 'otp' ? 'otp' : 'password', // 'password' needs no SMS provider
  signupCode: process.env.SIGNUP_CODE || '',
  devShowOtp: process.env.DEV_SHOW_OTP ? process.env.DEV_SHOW_OTP === '1' : !PROD, // MUST be off in public deployments
  smsWebhook: process.env.SMS_WEBHOOK_URL || '',
  smsMaxPerHour: Number(process.env.SMS_MAX_PER_HOUR || 200),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  diagToken: process.env.DIAG_TOKEN || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.invalid',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '', // server-side only; never ship this to a client
  supabaseBucket: process.env.SUPABASE_BUCKET || 'duet-media',
  twilioSid: process.env.TWILIO_ACCOUNT_SID || '', twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFrom: process.env.TWILIO_FROM || '', twilioService: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
};
const MEDIA_MAX = 26 * 1024 * 1024;
const JSON_MAX = 300 * 1024;

// ------------------------------------------------------------------ store
// Backends live in storage.js: a local file in development, Supabase (Postgres + Storage) in production.
const { store, blobs } = await createBackends(CFG);
store.byConv = new Map();
for (const m of store.d.messages) { if (!store.byConv.has(m.conversationId)) store.byConv.set(m.conversationId, []); store.byConv.get(m.conversationId).push(m); }
const D = store.d;
if (process.env.SESSION_SECRET) D.secret = process.env.SESSION_SECRET;
let shuttingDown = false;
async function shutdown() { if (shuttingDown) return; shuttingDown = true; try { await Promise.race([store.flush(), new Promise((r) => setTimeout(r, 8000))]); } catch (e) { console.error('[shutdown] flush failed', e.message); } process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// ----------------------------------------------------------------- helpers
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tok = (n = 32) => crypto.randomBytes(n).toString('base64url');
class HttpError extends Error { constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; } }
const bad = (code, msg, status = 400) => new HttpError(status, code, msg);

const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const t = now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) { hits.set(key, arr); throw new HttpError(429, 'rate-limited', 'Too many requests, slow down'); }
  arr.push(t); hits.set(key, arr);
}
setInterval(() => { const t = now(); for (const [k, v] of hits) { const f = v.filter((x) => t - x < 24 * 3600e3); if (f.length) hits.set(k, f); else hits.delete(k); } }, 600e3).unref();

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
const normPhone = (p) => { const s = String(p || '').replace(/[\s\-().]/g, ''); if (!/^\+[1-9]\d{6,14}$/.test(s)) throw bad('bad-phone', 'Enter the number in international format'); return s; };
const maskPhone = (p) => p.slice(0, 3) + '•'.repeat(Math.max(3, p.length - 7)) + p.slice(-4);
const maskName = (n) => (n ? n.slice(0, 1) + '•••' : '•••');
const userById = (id) => D.users.find((u) => u.id === id);

function viewUser(u) { return { id: u.id, phone: u.phone, displayName: u.displayName || '', avatar: u.avatar || null, sharePresence: u.sharePresence !== false, needsProfile: !u.displayName }; }

// ---------------------------------------------------------------- realtime
const clients = new Map(); // userId -> Set(res)
const signals = []; // queued signals for offline users: {to, type, conversationId, from, at}
const isOnline = (id) => (clients.get(id)?.size || 0) > 0;
function emit(userId, event, data) {
  const set = clients.get(userId); if (!set) return false;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch { /* closed */ } }
  return set.size > 0;
}
function signal(to, type, conversationId, from) {
  const live = emit(to, type, { conversationId, from, at: now() });
  if (!live) { const i = signals.findIndex((s) => s.to === to && s.type === type && s.conversationId === conversationId); if (i >= 0) signals.splice(i, 1); signals.push({ to, type, conversationId, from, at: now() }); }
}
const peersOf = (userId) => D.conversations.filter((c) => c.participants.includes(userId)).map((c) => c.participants.find((p) => p !== userId));
function presenceOf(u) { return u.sharePresence === false ? { online: null, lastSeen: null } : { online: isOnline(u.id), lastSeen: u.lastSeen || null }; }
function broadcastPresence(userId) {
  const u = userById(userId); if (!u) return;
  for (const p of peersOf(userId)) emit(p, 'presence', { userId, ...presenceOf(u) });
}

// ------------------------------------------------------------ conversations
const SECRET_TYPES = new Set(['text', 'image', 'video', 'audio']);
const MSG_TYPES = new Set(['text', 'image', 'video', 'audio', 'edit', 'ctl']);
function convFor(userId, convId) { const c = D.conversations.find((x) => x.id === convId); if (!c || !c.participants.includes(userId)) throw new HttpError(404, 'no-conversation', 'Conversation not found'); return c; }
function convBetween(a, b) { return D.conversations.find((c) => c.participants.includes(a) && c.participants.includes(b)); }
function getOrCreateConv(a, b) {
  let c = convBetween(a, b);
  if (!c) { c = { id: uid(), participants: [a, b], createdAt: now(), lastCreatedAt: 0 }; D.conversations.push(c); store.save(); for (const u of [a, b]) emit(u, 'conversation', { id: c.id }); }
  return c;
}
function viewConv(userId, c) {
  const peer = userById(c.participants.find((p) => p !== userId));
  const msgs = store.byConv.get(c.id) || [];
  let last = null, unread = 0;
  for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (!last && SECRET_TYPES.has(m.type)) last = { id: m.id, type: m.type, senderId: m.senderId, createdAt: m.createdAt, deleted: !!m.deletedAt }; }
  for (const m of msgs) if (m.senderId !== userId && SECRET_TYPES.has(m.type) && !m.readAt && !m.deletedAt) unread++;
  return { id: c.id, createdAt: c.createdAt, peer: { id: peer.id, displayName: peer.displayName || maskPhone(peer.phone), avatar: peer.avatar || null, ...presenceOf(peer) }, lastMessage: last, unread };
}
const viewMsg = (m) => ({ ...m });

// ------------------------------------------------------------------- auth
function parseCookies(req) { const out = {}; for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; }
function authenticate(req) {
  const t = parseCookies(req).duet_sid; if (!t) return null;
  const h = sha(t); const s = D.sessions.find((x) => x.hash === h && x.expiresAt > now());
  if (!s) return null;
  const user = userById(s.userId); if (!user) return null;
  if (now() - s.lastSeen > 60e3) { s.lastSeen = now(); store.save(); }
  return { user, session: s };
}
function setCookie(res, value, maxAge, req) {
  const secure = CFG.cookieSecure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `duet_sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
const smsSent = [];
async function sendSms(phone, text) {
  const t = now(); while (smsSent.length && t - smsSent[0] > 3600e3) smsSent.shift();
  if (smsSent.length >= CFG.smsMaxPerHour) throw new HttpError(503, 'sms-budget', 'SMS budget exhausted, try later');
  smsSent.push(t);
  if (CFG.twilioSid && CFG.twilioToken && (CFG.twilioFrom || CFG.twilioService)) {
    const form = new URLSearchParams({ To: phone, Body: text });
    if (CFG.twilioService) form.set('MessagingServiceSid', CFG.twilioService); else form.set('From', CFG.twilioFrom);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${CFG.twilioSid}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${CFG.twilioSid}:${CFG.twilioToken}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    if (!r.ok) { console.error('[sms:twilio] failed', r.status, (await r.text().catch(() => '')).slice(0, 200)); throw new HttpError(502, 'sms-failed', 'Could not send the code. Check the number and try again.'); }
  } else if (CFG.smsWebhook) {
    const u = new URL(CFG.smsWebhook); const body = JSON.stringify({ to: phone, text });
    await new Promise((resolve, reject) => {
      const r = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (resp) => { resp.resume(); resp.on('end', resolve); });
      r.on('error', reject); r.end(body);
    });
  } else console.log(`[sms:console] to ${phone}: ${text}`);
}

// --------------------------------------------------------------- web push
function vapid() {
  if (!D.vapid) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    D.vapid = privateKey.export({ format: 'jwk' }); store.save();
  }
  const x = Buffer.from(D.vapid.x, 'base64url'), y = Buffer.from(D.vapid.y, 'base64url');
  return { key: crypto.createPrivateKey({ key: D.vapid, format: 'jwk' }), pub: Buffer.concat([Buffer.from([4]), x, y]).toString('base64url') };
}
function pushTo(userId) {
  const subs = D.push.filter((s) => s.userId === userId); if (!subs.length) return;
  const { key, pub } = vapid();
  for (const s of subs) {
    try {
      const u = new URL(s.subscription.endpoint);
      const head = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ aud: u.origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: CFG.vapidSubject })).toString('base64url');
      const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      // Opaque push: no payload at all, so the push service learns only "something happened".
      const r = https.request(u, { method: 'POST', timeout: 8000, headers: { TTL: '120', Urgency: 'normal', 'Content-Length': '0', Authorization: `vapid t=${head}.${claims}.${sig}, k=${pub}` } }, (resp) => {
        resp.resume();
        if (resp.statusCode === 404 || resp.statusCode === 410) { D.push = D.push.filter((x) => x !== s); store.save(); }
      });
      r.on('error', () => {}); r.on('timeout', () => r.destroy()); r.end();
    } catch { /* ignore a bad subscription */ }
  }
}

// ---------------------------------------------------------- diagnostics sink
const DIAG_EVENTS = new Set(['app-boot', 'unlock', 'lock', 'sse-open', 'sse-error', 'keystore-created', 'spk-rotated', 'bundle-published', 'publish-failed', 'session-reused', 'session-created', 'session-repaired', 'session-adopted', 'session-replay-ignored', 'session-superseded', 'session-refused', 'session-requested', 'session-handshake-resent', 'peer-bundle-unavailable', 'peer-identity-changed', 'handshake-acked', 'send-deferred', 'decode-error', 'decrypt-failed', 'catch-up']);
const diagBuf = [];

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, p, opts, handler) => { if (typeof opts === 'function') { handler = opts; opts = {}; } routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '([^/]+)') + '$'), opts, handler }); };
const OK = { ok: true };

// health (public)
route('GET', '/api/health', { public: true }, () => {
  const warnings = [];
  if (CFG.authMode === 'password' && !CFG.signupCode && PROD) warnings.push('Anyone who finds this server can create an account. Set SIGNUP_CODE to restrict sign-ups.');
  if (CFG.authMode === 'otp' && CFG.devShowOtp) warnings.push('DEV_SHOW_OTP is on: login codes are echoed in API responses. Turn it off in any public deployment.');
  if (!CFG.cookieSecure && PROD) warnings.push('COOKIE_SECURE is not set.');
  if (PROD && store.kind === 'file-json') warnings.push('Using the local file store: data is lost on hosts with ephemeral disks. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  if (PROD && CFG.authMode === 'otp' && !CFG.twilioSid && !CFG.smsWebhook) warnings.push('No SMS provider configured: login codes are only printed to the server log.');
  if (store.health && !store.health().ok) warnings.push('Database writes are failing: ' + store.health().lastError);
  return { ok: !store.health || store.health().ok, build: buildTag(), auth: CFG.authMode, signupCodeRequired: !!CFG.signupCode, store: store.kind, media: blobs.kind, storeHealth: store.health ? store.health() : { ok: true }, sms: CFG.authMode !== 'otp' ? 'off' : CFG.twilioSid ? 'twilio' : CFG.smsWebhook ? 'webhook' : 'console', push: { vapid: true, payload: 'none (opaque)', subscriptions: D.push.length }, realtime: 'sse', crypto: 'x3dh+double-ratchet/x25519+ed25519/hkdf-sha256/aes-256-gcm', devOtpEcho: CFG.authMode === 'otp' && CFG.devShowOtp, users: D.users.length, warnings };
});

// auth
route('POST', '/api/auth/otp/send', { public: true }, async ({ req, body }) => {
  if (CFG.authMode !== 'otp') throw new HttpError(404, 'auth-mode', 'Code sign-in is not enabled on this server');
  const phone = normPhone(body.phone);
  rateLimit('otp-ip:' + clientIp(req), 10, 3600e3); rateLimit('otp-phone:' + phone, 3, 600e3);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  D.otp = D.otp.filter((o) => o.phone !== phone && o.expiresAt > now());
  D.otp.push({ phone, hash: sha(D.secret + '|' + phone + '|' + code), expiresAt: now() + 5 * 60e3, attempts: 0 });
  store.save();
  await sendSms(phone, `Your Duet code is ${code}. It expires in 5 minutes.`);
  return { ok: true, ...(CFG.devShowOtp ? { devCode: code } : {}) };
});
route('POST', '/api/auth/otp/verify', { public: true }, ({ req, res, body }) => {
  if (CFG.authMode !== 'otp') throw new HttpError(404, 'auth-mode', 'Code sign-in is not enabled on this server');
  const phone = normPhone(body.phone); const code = String(body.code || '').trim();
  rateLimit('verify-ip:' + clientIp(req), 30, 3600e3);
  const o = D.otp.find((x) => x.phone === phone);
  if (!o || o.expiresAt < now()) throw bad('otp-expired', 'That code has expired. Request a new one.', 400);
  if (o.attempts >= 5) throw new HttpError(429, 'otp-locked', 'Too many wrong codes. Request a new one.');
  o.attempts++;
  const a = Buffer.from(sha(D.secret + '|' + phone + '|' + code)), b = Buffer.from(o.hash);
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(a, b)) { store.save(); throw bad('otp-wrong', 'That code is not right.', 400); }
  D.otp = D.otp.filter((x) => x !== o);
  let user = D.users.find((u) => u.phone === phone); let isNew = false;
  if (!user) { user = { id: uid(), phone, displayName: '', avatar: null, sharePresence: true, createdAt: now(), lastSeen: now() }; D.users.push(user); isNew = true; }
  const t = tok(); D.sessions.push({ id: uid(), hash: sha(t), userId: user.id, createdAt: now(), lastSeen: now(), expiresAt: now() + 30 * 86400e3, ua: String(req.headers['user-agent'] || '').slice(0, 120) });
  store.save(); setCookie(res, t, 30 * 86400, req);
  return { user: viewUser(user), isNew };
});
// password sign-in (default; needs no SMS provider). The phone number is a sign-in name here: it is NOT verified.
const scrypt = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); return { salt: salt.toString('base64'), hash: (await scrypt(pw, salt)).toString('base64') }; }
const DUMMY_SALT = crypto.randomBytes(16);
async function checkPassword(user, pw) { // constant-ish work for unknown users too, so "no such number" is not distinguishable
  const salt = user?.pw ? Buffer.from(user.pw.salt, 'base64') : DUMMY_SALT; const got = await scrypt(pw, salt);
  return !!user?.pw && crypto.timingSafeEqual(got, Buffer.from(user.pw.hash, 'base64'));
}
function startSession(req, res, user) {
  const t = tok(); D.sessions.push({ id: uid(), hash: sha(t), userId: user.id, createdAt: now(), lastSeen: now(), expiresAt: now() + 30 * 86400e3, ua: String(req.headers['user-agent'] || '').slice(0, 120) });
  store.save(); setCookie(res, t, 30 * 86400, req);
}
const needPasswordMode = () => { if (CFG.authMode !== 'password') throw new HttpError(404, 'auth-mode', 'Password sign-in is not enabled on this server'); };
function checkPw(pw) { if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw bad('weak-password', 'Use a password of at least 8 characters.'); }
route('POST', '/api/auth/register', { public: true }, async ({ req, res, body }) => {
  needPasswordMode(); const phone = normPhone(body.phone);
  rateLimit('reg-ip:' + clientIp(req), 10, 3600e3);
  if (CFG.signupCode) { const a = Buffer.from(sha(String(body.signupCode || ''))), b = Buffer.from(sha(CFG.signupCode)); if (!crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'bad-signup-code', 'That sign-up code is not right.'); }
  checkPw(body.password);
  if (D.users.find((u) => u.phone === phone)) throw new HttpError(409, 'exists', 'An account with this number already exists. Sign in instead.');
  const user = { id: uid(), phone, displayName: '', avatar: null, sharePresence: true, createdAt: now(), lastSeen: now(), pw: await hashPassword(body.password) };
  D.users.push(user); startSession(req, res, user);
  return { user: viewUser(user), isNew: true };
});
route('POST', '/api/auth/login', { public: true }, async ({ req, res, body }) => {
  needPasswordMode(); const phone = normPhone(body.phone);
  rateLimit('login-ip:' + clientIp(req), 30, 600e3); rateLimit('login-phone:' + phone, 8, 600e3);
  const user = D.users.find((u) => u.phone === phone);
  if (!(await checkPassword(user, String(body.password || '')))) throw new HttpError(401, 'bad-credentials', 'Number or password is not right.');
  startSession(req, res, user);
  return { user: viewUser(user), isNew: false };
});
route('PUT', '/api/auth/password', { auth: true }, async ({ user, body, session }) => {
  needPasswordMode(); rateLimit('chpw:' + user.id, 10, 3600e3); checkPw(body.next);
  if (!(await checkPassword(user, String(body.current || '')))) throw new HttpError(401, 'bad-credentials', 'Your current password is not right.');
  user.pw = await hashPassword(body.next);
  D.sessions = D.sessions.filter((x) => x.userId !== user.id || x === session); store.save(); // other devices are signed out
  return OK;
});
route('GET', '/api/auth/me', { auth: true }, ({ user }) => ({ user: viewUser(user) }));
route('POST', '/api/auth/logout', { auth: true }, ({ req, res, user, session, body }) => {
  if (body && body.all) D.sessions = D.sessions.filter((s) => s.userId !== user.id); else D.sessions = D.sessions.filter((s) => s !== session);
  store.save(); setCookie(res, '', 0, req); return OK;
});
route('GET', '/api/auth/sessions', { auth: true }, ({ user, session }) => ({ sessions: D.sessions.filter((s) => s.userId === user.id).map((s) => ({ id: s.id.slice(0, 8), createdAt: s.createdAt, lastSeen: s.lastSeen, ua: s.ua, current: s === session })) }));
route('PUT', '/api/users/me', { auth: true }, ({ user, body }) => {
  if (body.displayName !== undefined) { const n = String(body.displayName).trim(); if (n.length < 1 || n.length > 40) throw bad('bad-name', 'Name must be 1–40 characters'); user.displayName = n; }
  if (body.avatar !== undefined) {
    if (body.avatar === null) user.avatar = null;
    else { if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body.avatar) || body.avatar.length > 90000) throw bad('bad-avatar', 'Avatar must be a small PNG/JPEG/WebP'); user.avatar = body.avatar; }
  }
  if (body.sharePresence !== undefined) { user.sharePresence = !!body.sharePresence; broadcastPresence(user.id); }
  store.save(); return { user: viewUser(user) };
});

// lookup: rate-limited, masked, no directory
route('GET', '/api/lookup', { auth: true }, ({ user, url }) => {
  rateLimit('lookup:' + user.id, 15, 3600e3);
  const phone = normPhone(url.searchParams.get('phone'));
  const u = D.users.find((x) => x.phone === phone);
  if (!u || u.id === user.id) return { exists: false };
  return { exists: true, maskedName: maskName(u.displayName), maskedPhone: maskPhone(u.phone), connected: !!convBetween(user.id, u.id) };
});

// connections (start a chat / accept a request)
route('GET', '/api/connections', { auth: true }, ({ user }) => {
  const view = (c, otherId) => { const o = userById(otherId); return { id: c.id, createdAt: c.createdAt, status: c.status, name: o.displayName || '', maskedPhone: maskPhone(o.phone), avatar: o.avatar || null }; };
  return { incoming: D.connections.filter((c) => c.toId === user.id && c.status === 'pending').map((c) => view(c, c.fromId)), outgoing: D.connections.filter((c) => c.fromId === user.id && c.status === 'pending').map((c) => view(c, c.toId)) };
});
route('POST', '/api/connections', { auth: true }, ({ user, body }) => {
  if (body.requestId) {
    const c = D.connections.find((x) => x.id === body.requestId && x.toId === user.id && x.status === 'pending');
    if (!c) throw new HttpError(404, 'no-request', 'Request not found');
    c.status = body.accept === false ? 'declined' : 'accepted'; store.save();
    if (c.status === 'declined') return OK;
    return { conversation: viewConv(user.id, getOrCreateConv(c.fromId, c.toId)) };
  }
  rateLimit('conn:' + user.id, 20, 86400e3);
  const phone = normPhone(body.phone);
  const other = D.users.find((u) => u.phone === phone);
  if (!other || other.id === user.id) throw new HttpError(404, 'no-such-user', 'No Duet account for that number');
  const existing = convBetween(user.id, other.id);
  if (existing) return { conversation: viewConv(user.id, existing) };
  const reverse = D.connections.find((c) => c.fromId === other.id && c.toId === user.id && c.status === 'pending');
  if (reverse) { reverse.status = 'accepted'; store.save(); return { conversation: viewConv(user.id, getOrCreateConv(user.id, other.id)) }; }
  let c = D.connections.find((x) => x.fromId === user.id && x.toId === other.id && x.status === 'pending');
  if (!c) { c = { id: uid(), fromId: user.id, toId: other.id, status: 'pending', createdAt: now() }; D.connections.push(c); store.save(); emit(other.id, 'connection', { id: c.id }); }
  return { pending: true };
});

// invites (anonymous, single-use)
route('POST', '/api/invites', { auth: true }, ({ req, user }) => {
  rateLimit('invite:' + user.id, 10, 3600e3);
  const token = tok(16);
  D.invites.push({ hash: sha(token), creatorId: user.id, createdAt: now(), expiresAt: now() + 7 * 86400e3, usedAt: null });
  D.invites = D.invites.filter((i) => i.usedAt === null ? i.expiresAt > now() : now() - i.usedAt < 86400e3);
  store.save();
  const origin = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  return { token, url: `${origin}/i/${token}`, expiresAt: now() + 7 * 86400e3 };
});
route('POST', '/api/invites/redeem', { auth: true }, ({ user, body }) => {
  rateLimit('redeem:' + user.id, 20, 3600e3);
  const inv = D.invites.find((i) => i.hash === sha(String(body.token || '')));
  if (!inv || inv.usedAt || inv.expiresAt < now()) throw new HttpError(404, 'bad-invite', 'This invite is invalid, expired or already used');
  if (inv.creatorId === user.id) throw bad('own-invite', 'You cannot redeem your own invite');
  inv.usedAt = now();
  const c = getOrCreateConv(inv.creatorId, user.id);
  store.save();
  return { conversation: viewConv(user.id, c) };
});

// conversations
route('GET', '/api/conversations', { auth: true }, ({ user }) => ({ conversations: D.conversations.filter((c) => c.participants.includes(user.id)).map((c) => viewConv(user.id, c)).sort((a, b) => (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt)) }));
route('POST', '/api/conversations', { auth: true }, ({ user, body }) => {
  const c = body.peerId && convBetween(user.id, body.peerId);
  if (!c) throw new HttpError(403, 'no-connection', 'Start a chat with an invite or an accepted request first');
  return { conversation: viewConv(user.id, c) };
});

// keys (prekey registry): merge, never overwrite (7.11)
const isB64Len = (s, n) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').length === n;
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function verifySpk(b) {
  try {
    const msg = Buffer.concat([Buffer.from('duet-spk-v1'), Buffer.from(b.spk.pub, 'base64'), Buffer.from(b.identity.dh, 'base64')]);
    const key = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(b.identity.sign, 'base64')]), format: 'der', type: 'spki' });
    return crypto.verify(null, msg, key, Buffer.from(b.spk.sig, 'base64'));
  } catch { return false; }
}
route('POST', '/api/keys', { auth: true }, ({ user, body }) => {
  rateLimit('keys:' + user.id, 60, 3600e3);
  const id = body.identity, spk = body.spk, otks = Array.isArray(body.otks) ? body.otks : [];
  if (id && !(isB64Len(id.sign, 32) && isB64Len(id.dh, 32))) throw bad('bad-bundle', 'Malformed identity key');
  if (spk && !(Number.isInteger(spk.id) && isB64Len(spk.pub, 32) && (spk.sig === undefined || isB64Len(spk.sig, 64)))) throw bad('bad-bundle', 'Malformed signed prekey');
  for (const o of otks) if (!(Number.isInteger(o.id) && isB64Len(o.pub, 32))) throw bad('bad-bundle', 'Malformed one-time prekey');
  let cur = D.keys[user.id]; let changed = false;
  const incoming = { identity: id || cur?.identity, spk: spk && spk.sig ? spk : undefined };
  if (id && spk && spk.sig && !verifySpk({ identity: id, spk })) throw bad('bad-signature', 'Signed prekey signature does not verify');
  if (!cur || (id && cur.identity && cur.identity.dh !== id.dh)) { // new identity: wholesale replace, old one-time prekeys are meaningless
    if (!id) throw bad('bad-bundle', 'Identity required for a first publish');
    cur = D.keys[user.id] = { identity: id, spk: spk && spk.sig ? spk : null, otks: [], consumed: [], updatedAt: now() }; changed = true;
  } else {
    if (id) cur.identity = id;
    if (spk && spk.sig) { if (!cur.spk || cur.spk.pub !== spk.pub || cur.spk.sig !== spk.sig) changed = true; cur.spk = spk; }
  }
  for (const o of otks) if (!cur.consumed.includes(o.id) && !cur.otks.some((x) => x.id === o.id)) cur.otks.push({ id: o.id, pub: o.pub });
  cur.otks = cur.otks.slice(-100); cur.updatedAt = now(); store.save();
  if (changed) for (const p of peersOf(user.id)) emit(p, 'keys-updated', { userId: user.id });
  void incoming;
  return { ok: true, otkRemaining: cur.otks.length };
});
route('GET', '/api/keys', { auth: true }, ({ user, url }) => {
  const c = convFor(user.id, url.searchParams.get('conversationId'));
  const peerId = c.participants.find((p) => p !== user.id);
  const k = D.keys[peerId];
  if (!k || !k.identity) throw new HttpError(409, 'peer-keys-unavailable', 'The other device has not published encryption keys');
  if (!k.spk || !k.spk.sig) throw new HttpError(409, 'peer-keys-incomplete', 'The other device published an incomplete bundle');
  const otk = k.otks.shift() || null; if (otk) k.consumed.push(otk.id);
  store.save();
  return { peerId, identity: k.identity, spk: k.spk, otk };
});
route('POST', '/api/keys/repair', { auth: true }, ({ user, body }) => {
  rateLimit('repair:' + user.id, 40, 3600e3);
  const c = convFor(user.id, body.conversationId); const peer = c.participants.find((p) => p !== user.id);
  if (body.kind === 'bundle') signal(peer, 'repair', c.id, user.id);
  else if (body.kind === 'session') signal(peer, 'session-request', c.id, user.id);
  else throw bad('bad-kind', 'Unknown repair kind');
  return OK;
});

// messages
route('GET', '/api/messages', { auth: true }, ({ user, url }) => {
  const c = convFor(user.id, url.searchParams.get('conversationId'));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
  const before = url.searchParams.get('before'); const after = url.searchParams.get('after');
  const all = store.byConv.get(c.id) || [];
  const parse = (s) => { const [t, i] = String(s).split('_'); return { t: Number(t), i: i || '' }; };
  const lt = (m, p) => m.createdAt < p.t || (m.createdAt === p.t && m.id < p.i);
  if (after) { const p = parse(after); const rows = all.filter((m) => !lt(m, p) && !(m.createdAt === p.t && m.id === p.i)).slice(0, limit); return { messages: rows.map(viewMsg), nextCursor: null }; }
  let rows = all; if (before) { const p = parse(before); rows = all.filter((m) => lt(m, p)); }
  const page = rows.slice(-limit).reverse(); // newest first
  const more = rows.length > limit; const oldest = page[page.length - 1];
  return { messages: page.map(viewMsg), nextCursor: more && oldest ? `${oldest.createdAt}_${oldest.id}` : null };
});
route('POST', '/api/messages', { auth: true }, ({ user, body }) => {
  rateLimit('msg:' + user.id, 120, 60e3);
  const c = convFor(user.id, body.conversationId);
  if (!MSG_TYPES.has(body.type)) throw bad('bad-type', 'Unknown message type');
  if (typeof body.ciphertext !== 'string' || !body.ciphertext || body.ciphertext.length > 200000) throw bad('bad-ciphertext', 'Ciphertext missing or too large');
  if (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) throw bad('bad-client-id', 'clientId required');
  const msgs = store.byConv.get(c.id) || [];
  const dup = msgs.find((m) => m.clientId === body.clientId && m.senderId === user.id); // idempotent retry
  if (dup) return { ...viewMsg(dup), duplicate: true };
  let mediaId = null, mediaMeta = null;
  if (body.mediaId) {
    const m = D.media.find((x) => x.id === body.mediaId && x.conversationId === c.id && x.ownerId === user.id);
    if (!m) throw bad('bad-media', 'Unknown attachment');
    mediaId = m.id; mediaMeta = { size: m.size, kind: m.kind };
  }
  const t = Math.max(now(), (c.lastCreatedAt || 0) + 1); c.lastCreatedAt = t;
  const row = { id: uid(), conversationId: c.id, senderId: user.id, type: body.type, clientId: body.clientId, ciphertext: body.ciphertext, createdAt: t, deliveredAt: null, readAt: null, editedAt: null, deletedAt: null, mediaId, mediaMeta };
  D.messages.push(row); if (!store.byConv.has(c.id)) store.byConv.set(c.id, []); store.byConv.get(c.id).push(row);
  const peer = c.participants.find((p) => p !== user.id);
  if (body.type === 'edit' && typeof body.editsClientId === 'string') {
    const target = msgs.find((m) => m.clientId === body.editsClientId && m.senderId === user.id && m.type === 'text' && !m.deletedAt);
    if (target) { target.editedAt = t; emit(peer, 'message-updated', viewMsg(target)); emit(user.id, 'message-updated', viewMsg(target)); }
  }
  store.save();
  const live = emit(peer, 'message', viewMsg(row));
  if (!live) pushTo(peer);
  return viewMsg(row);
});
route('POST', '/api/messages/receipts', { auth: true }, ({ user, body }) => {
  const c = convFor(user.id, body.conversationId); const peer = c.participants.find((p) => p !== user.id);
  const msgs = store.byConv.get(c.id) || []; const upTo = msgs.find((m) => m.id === body.upTo);
  if (!upTo || !['delivered', 'read'].includes(body.kind)) throw bad('bad-receipt', 'Bad receipt');
  const ids = [], clientIds = []; const t = now();
  for (const m of msgs) {
    if (m.senderId === user.id || m.createdAt > upTo.createdAt) continue;
    let touched = false;
    if (!m.deliveredAt) { m.deliveredAt = t; touched = true; }
    if (body.kind === 'read' && !m.readAt) { m.readAt = t; touched = true; }
    if (touched) { ids.push(m.id); clientIds.push(m.clientId); }
  }
  if (ids.length) { store.save(); emit(peer, 'receipt', { conversationId: c.id, kind: body.kind, ids, clientIds, at: t }); }
  return { ok: true, updated: ids.length };
});
route('POST', '/api/messages/delete', { auth: true }, ({ user, body }) => {
  const m = D.messages.find((x) => x.id === body.id && x.senderId === user.id);
  if (!m) throw new HttpError(404, 'no-message', 'Message not found');
  const c = convFor(user.id, m.conversationId);
  m.deletedAt = now(); m.ciphertext = ''; // tombstone
  if (m.mediaId) { const med = D.media.find((x) => x.id === m.mediaId); if (med) { blobs.del(med.id); D.media = D.media.filter((x) => x !== med); } m.mediaId = null; }
  store.save();
  const peer = c.participants.find((p) => p !== user.id);
  emit(peer, 'message-updated', viewMsg(m)); emit(user.id, 'message-updated', viewMsg(m));
  return OK;
});

// media (ciphertext blobs only)
route('POST', '/api/media/upload', { auth: true, raw: true }, async ({ req, user }) => {
  rateLimit('media:' + user.id, 60, 3600e3);
  const c = convFor(user.id, req.headers['x-conversation']);
  const kind = ['video', 'audio'].includes(req.headers['x-kind']) ? req.headers['x-kind'] : 'image';
  const len = Number(req.headers['content-length'] || 0);
  if (!len || len > MEDIA_MAX) throw new HttpError(413, 'too-large', 'Attachment too large (max 25 MB)');
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (ch) => { size += ch.length; if (size > MEDIA_MAX) { req.destroy(); reject(new HttpError(413, 'too-large', 'Attachment too large')); } else chunks.push(ch); });
    req.on('end', resolve); req.on('error', reject);
  });
  const id = uid();
  try { await blobs.put(id, Buffer.concat(chunks)); } catch (e) { console.error('[media] store failed', e.message); throw new HttpError(502, 'media-store-failed', 'Could not store the attachment, try again'); }
  D.media.push({ id, conversationId: c.id, ownerId: user.id, size, kind, createdAt: now() }); store.save();
  return { id };
});
route('GET', '/api/media/:id', { auth: true, rawResponse: true }, async ({ res, user, params }) => {
  const m = D.media.find((x) => x.id === params[0]);
  if (!m) throw new HttpError(404, 'no-media', 'Not found');
  convFor(user.id, m.conversationId);
  let buf; try { buf = await blobs.get(m.id); } catch { throw new HttpError(404, 'no-media', 'Not found'); }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'private, max-age=3600' });
  res.end(buf);
});

// push
route('GET', '/api/push/key', { auth: true }, () => ({ key: vapid().pub }));
route('POST', '/api/push/subscribe', { auth: true }, ({ user, body }) => {
  const sub = body.subscription;
  if (body.unsubscribe) { D.push = D.push.filter((s) => s.userId !== user.id || s.subscription.endpoint !== sub?.endpoint); store.save(); return OK; }
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw bad('bad-subscription', 'Bad subscription');
  D.push = D.push.filter((s) => s.subscription.endpoint !== sub.endpoint);
  D.push.push({ userId: user.id, subscription: { endpoint: sub.endpoint, keys: sub.keys || {} }, createdAt: now() }); store.save();
  return OK;
});

// diagnostics: allow-listed event names, scalar fields only (identifiers and counters, never content)
route('POST', '/api/diag', { public: true }, ({ req, body }) => {
  rateLimit('diag:' + clientIp(req), 120, 60e3);
  const auth = authenticate(req); const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  let kept = 0;
  for (const ev of events) {
    if (!ev || !DIAG_EVENTS.has(ev.e)) continue;
    const rec = { at: now(), build: String(body.build || '').slice(0, 24), user: auth ? auth.user.id.slice(0, 8) : null, e: ev.e };
    for (const [k, v] of Object.entries(ev)) {
      if (k === 'e' || !/^[a-z][a-zA-Z0-9]{0,23}$/.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) rec[k] = v; else if (typeof v === 'boolean') rec[k] = v; else if (typeof v === 'string' && v.length <= 32 && /^[\w .:-]*$/.test(v)) rec[k] = v;
    }
    diagBuf.push(rec); kept++;
  }
  while (diagBuf.length > 500) diagBuf.shift();
  return { ok: true, kept };
});
route('GET', '/api/diag', { public: true }, ({ url }) => {
  if (!CFG.diagToken || url.searchParams.get('token') !== CFG.diagToken) throw new HttpError(403, 'forbidden', 'Diagnostics read is disabled');
  return { events: diagBuf.slice(-200) };
});

// realtime (SSE)
function handleSse(req, res, user) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!clients.has(user.id)) clients.set(user.id, new Set());
  const set = clients.get(user.id); const wasOnline = set.size > 0; set.add(res);
  user.lastSeen = now();
  for (let i = signals.length - 1; i >= 0; i--) { const s = signals[i]; if (s.to !== user.id) continue; signals.splice(i, 1); if (now() - s.at < 10 * 60e3) res.write(`event: ${s.type}\ndata: ${JSON.stringify({ conversationId: s.conversationId, from: s.from, at: s.at })}\n\n`); }
  res.write(`event: hello\ndata: ${JSON.stringify({ at: now() })}\n\n`);
  if (!wasOnline) broadcastPresence(user.id);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 20000);
  req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) { clients.delete(user.id); user.lastSeen = now(); store.save(); broadcastPresence(user.id); } });
}

// ------------------------------------------------------------ static files
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
let _build = null;
function buildTag() {
  if (_build) return _build;
  const h = crypto.createHash('sha256');
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (!/\.(png|ico|jpg|webp)$/.test(e.name)) h.update(e.name).update(fs.readFileSync(p)); } })(CFG.publicDir);
  return (_build = h.digest('hex').slice(0, 10));
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.startsWith('/i/')) rel = '/index.html';
  const file = path.normalize(path.join(CFG.publicDir, rel));
  if (!file.startsWith(CFG.publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const ext = path.extname(file); let data = fs.readFileSync(file);
  if (/\.(html|js|webmanifest)$/.test(file) && (file.endsWith('index.html') || file.endsWith('sw.js') || file.endsWith('build.js'))) data = Buffer.from(data.toString().replaceAll('__BUILD__', buildTag()));
  const long = /\.(png|ico|jpg|webp)$/.test(ext);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': long ? 'public, max-age=86400' : 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(self), geolocation=()', 'x-frame-options': 'DENY', ...(file.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}) });
  res.end(data);
}

// ----------------------------------------------------------------- server
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > JSON_MAX) { reject(new HttpError(413, 'too-large', 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(bad('bad-json', 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
function send(res, status, body) { const s = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(s); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    if (url.pathname === '/api/realtime') {
      const a = authenticate(req); if (!a) throw new HttpError(401, 'unauthorized', 'Sign in required');
      return handleSse(req, res, a.user);
    }
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-duet'] !== '1') throw new HttpError(403, 'csrf', 'Missing client header');
      const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'csrf', 'Cross-origin request refused');
    }
    let match = null, params = [];
    for (const r of routes) { if (r.method !== method) continue; const m = r.re.exec(url.pathname); if (m) { match = r; params = m.slice(1); break; } }
    if (!match) throw new HttpError(404, 'not-found', 'No such endpoint');
    let a = null;
    if (match.opts.auth) { a = authenticate(req); if (!a) throw new HttpError(401, 'unauthorized', 'Sign in required'); } // actor always comes from the session, never from the client
    const body = match.opts.raw || method === 'GET' ? {} : await readJson(req);
    const out = await match.handler({ req, res, url, params, body, user: a?.user, session: a?.session });
    if (match.opts.rawResponse) return;
    send(res, 200, out);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, code: err.code });
    console.error('[error]', err);
    send(res, 500, { error: 'Internal error', code: 'internal' });
  }
});
server.requestTimeout = 120000;
server.listen(CFG.port, CFG.host, () => {
  console.log(`Duet listening on http://${CFG.host}:${CFG.port}  build=${buildTag()}  store=${store.kind}  media=${blobs.kind}`);
  if (CFG.authMode === 'otp' && CFG.devShowOtp) console.warn('WARNING: DEV_SHOW_OTP is on - login codes are returned by the API. Disable for any public deployment (DEV_SHOW_OTP=0).');
});
export { server };
