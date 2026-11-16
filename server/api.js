import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import {
  HttpError, httpError, json, fail, readJson, readBody, parseCookies,
  setSessionCookie, clearSessionCookie, clientIp, sameOrigin, sha256Hex,
  hmacHex, timingSafeEqualHex, randomToken, validUuid, cleanText, clampInt,
  decodeCursor, encodeCursor, peerUser, clientUser, log
} from './util.js';
import { notifyUser, publicVapidKey, pushEnabled } from './push.js';
import { serveMediaResponse } from './static.js';

const DIAG_EVENTS = new Set([
  'session_created', 'session_reused', 'session_adopted', 'session_replayed',
  'session_refused', 'session_repair_requested', 'session_reset',
  'decrypt_ok', 'decrypt_failed', 'dead_row', 'prekeys_published',
  'prekeys_missing', 'vault_unlocked', 'vault_locked', 'vault_recovered',
  'push_subscribed', 'media_sent', 'message_sent', 'message_received',
  'realtime_open', 'realtime_error', 'offline_cache_hit', 'media_cached'
]);
const DIAG_FIELDS = new Set([
  'conversationId', 'messageId', 'generation', 'reason', 'count', 'peerId',
  'deviceId', 'pool', 'clientBuild', 'cached', 'online', 'durationMs', 'ok'
]);

const MESSAGE_TYPES = new Set(['text', 'image', 'video', 'session']);
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function amount(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isB64(value, bytes = null) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4_000_000) return false;
  if (!B64_RE.test(value)) return false;
  if (bytes === null) return true;
  try {
    return Buffer.from(value, 'base64').length === bytes;
  } catch {
    return false;
  }
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    type: row.type,
    ciphertext: row.ciphertext ?? null,
    envelope: row.envelope ?? null,
    clientId: row.client_id,
    mediaId: row.media_id ?? null,
    mediaMeta: row.media_meta ?? null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
    readAt: row.read_at ?? null,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null
  };
}

function mapConversation(row) {
  const visible = row.peer_presence_visible !== false;
  return {
    id: row.conversation_id,
    peer: {
      id: row.peer_id,
      displayName: row.peer_display_name ?? null,
      avatarColor: Number(row.peer_avatar_color ?? 0),
      presenceVisible: visible,
      lastSeenAt: visible ? row.peer_last_seen_at ?? null : null,
      online: visible && row.peer_online === true
    },
    lastMessageAt: row.last_message_at ?? null,
    unreadCount: Number(row.unread_count || 0),
    lastMessageType: row.last_message_type ?? null,
    lastMessageSenderId: row.last_message_sender_id ?? null
  };
}

function mapRequest(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    peer: peerUser(row.peer)
  };
}

async function permit(store, bucket, key, windowSeconds, limit) {
  const result = await store.rateLimit(bucket, key, windowSeconds, limit);
  if (!result?.allowed) {
    throw httpError(429, 'rate_limited',
      'Too many attempts. Wait a moment and try again.',
      { retryAfter: Number(result?.retryAfter || 30) });
  }
  return result;
}

async function getSession(req, store) {
  const cookies = parseCookies(req);
  const token = cookies[config.sessionCookie];
  if (!token) return null;
  const tokenHash = hmacHex(config.sessionSecret, token);
  const found = await store.findSession(tokenHash);
  if (!found) return null;
  return { ...found, tokenHash, token };
}

async function requireSession(req, store) {
  const auth = await getSession(req, store);
  if (!auth) throw httpError(401, 'unauthorized', 'Sign in to continue.');
  return auth;
}

async function issueSession(store, req, res, user) {
  const token = randomToken(32);
  const tokenHash = hmacHex(config.sessionSecret, token);
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400_000).toISOString();
  await store.createSession({
    userId: user.id,
    tokenHash,
    userAgent: cleanText(String(req.headers['user-agent'] || ''), 220),
    ip: clientIp(req),
    expiresAt
  });
  setSessionCookie(res, token, config.sessionDays * 86400);
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw httpError(400, 'bad_envelope', 'Missing encryption envelope.');
  }
  const header = envelope.header;
  if (!header || typeof header !== 'object' ||
      typeof header.dh !== 'string' || header.dh.length < 20 || header.dh.length > 120 ||
      !Number.isInteger(header.n) || header.n < 0 || header.n > 1_000_000_000 ||
      !Number.isInteger(header.pn) || header.pn < 0 || header.pn > 1_000_000_000) {
    throw httpError(400, 'bad_envelope', 'The encryption header is malformed.');
  }
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length < 16 || envelope.nonce.length > 64) {
    throw httpError(400, 'bad_envelope', 'The encryption nonce is malformed.');
  }
  if (envelope.x3dh !== undefined) {
    const x = envelope.x3dh;
    if (!x || typeof x !== 'object' ||
        typeof x.generation !== 'string' || x.generation.length < 8 || x.generation.length > 80 ||
        typeof x.ephemeralPublicKey !== 'string' ||
        typeof x.initiatorIdentityKey !== 'string' ||
        typeof x.authTag !== 'string') {
      throw httpError(400, 'bad_envelope', 'The session handshake is malformed.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > 20_000) {
    throw httpError(400, 'bad_envelope', 'The encryption envelope is too large.');
  }
  return envelope;
}

function validateCiphertext(ciphertext) {
  if (!isB64(ciphertext, null) || ciphertext.length > 900_000) {
    throw httpError(400, 'bad_ciphertext', 'The encrypted payload is malformed.');
  }
  return ciphertext;
}

function sanitizeMediaMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  if (meta.mime) out.mime = cleanText(String(meta.mime), 80);
  if (meta.size !== undefined) out.size = clampInt(meta.size, 0, 200 * 1024 * 1024, 0);
  if (meta.width !== undefined) out.width = clampInt(meta.width, 0, 100_000, 0);
  if (meta.height !== undefined) out.height = clampInt(meta.height, 0, 100_000, 0);
  if (Buffer.byteLength(JSON.stringify(out)) > 2000) return null;
  return out;
}

function parseKeyBundle(body) {
  const deviceId = String(body.deviceId || '');
  if (!DEVICE_RE.test(deviceId)) {
    throw httpError(400, 'bad_device', 'The device id is malformed.');
  }
  if (!isB64(body.identityKey, 32)) {
    throw httpError(400, 'bad_identity_key', 'The identity key must be a 32-byte Ed25519 key.');
  }
  const spk = body.signedPreKey;
  if (!spk || typeof spk !== 'object' ||
      !Number.isInteger(spk.id) || spk.id < 1 || spk.id > 2_147_483_647 ||
      !isB64(spk.publicKey, 32) || !isB64(spk.signature, 64)) {
    throw httpError(400, 'bad_signed_prekey', 'The signed prekey is malformed.');
  }
  const oneTimePreKeys = Array.isArray(body.oneTimePreKeys)
    ? body.oneTimePreKeys.slice(0, 100).map((key) => {
      if (!key || !Number.isInteger(key.id) || key.id < 1 || key.id > 2_147_483_647 ||
          !isB64(key.publicKey, 32)) {
        throw httpError(400, 'bad_one_time_prekey', 'A one-time prekey is malformed.');
      }
      return { id: key.id, publicKey: key.publicKey };
    })
    : [];
  const seen = new Set();
  const deduped = oneTimePreKeys.filter((key) => {
    if (seen.has(key.id)) return false;
    seen.add(key.id);
    return true;
  });
  return {
    deviceId,
    identityKey: body.identityKey,
    signedPreKey: {
      id: spk.id,
      publicKey: spk.publicKey,
      signature: spk.signature,
      createdAt: spk.createdAt ? cleanText(String(spk.createdAt), 40) : new Date().toISOString()
    },
    oneTimePreKeys: deduped
  };
}

function conversationIdFrom(url) {
  const id = url.searchParams.get('conversationId');
  if (!validUuid(id)) throw httpError(400, 'bad_conversation', 'A valid conversationId is required.');
  return id;
}

function sseSend(res, id, kind, payload = {}) {
  res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify({ id: Number(id), kind, ...payload })}\n\n`);
}

async function streamRealtime(req, res, url, store, auth) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity'
  });
  res.write('retry: 3000\n\n');

  let cursor;
  const lastEventId = req.headers['last-event-id'];
  if (lastEventId !== undefined) {
    cursor = Math.max(0, Number(lastEventId) || 0);
  } else if (url.searchParams.has('after')) {
    cursor = Math.max(0, Number(url.searchParams.get('after')) || 0);
  } else {
    cursor = await store.latestEventId(auth.user.id);
  }
  sseSend(res, cursor, 'ready', { build: config.buildTag });

  let closed = false;
  let heartbeat = null;
  let timer = null;
  let lastAuthCheck = Date.now();

  const close = () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    try { res.end(); } catch { /* closed */ }
  };

  req.on('close', close);
  res.on('close', close);

  heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': keep-alive\n\n'); } catch { close(); }
  }, 20_000);

  const tick = async () => {
    if (closed) return;
    try {
      const events = await store.listEvents(auth.user.id, cursor, 100);
      for (const event of events) {
        if (closed) return;
        cursor = Number(event.id);
        sseSend(res, cursor, event.kind, event.payload || {});
      }
      if (events.length === 100) {
        timer = setTimeout(tick, 50);
        return;
      }
      if (Date.now() - lastAuthCheck > 60_000) {
        lastAuthCheck = Date.now();
        const again = await store.findSession(auth.tokenHash);
        if (!again) {
          sseSend(res, cursor, 'auth_expired', {});
          close();
          return;
        }
      }
    } catch (error) {
      sseSend(res, cursor, 'realtime_error', { reason: 'store' });
      close();
      return;
    }
    timer = setTimeout(tick, 1200);
  };
  timer = setTimeout(tick, 100);
}

/* ========================================================================== */
/* Routes                                                                     */
/* ========================================================================== */

export async function handleApi(req, res, url, store) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // CSRF: cookie-authenticated mutations must come from this origin.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !sameOrigin(req)) {
    throw httpError(403, 'bad_origin', 'Cross-origin request refused.');
  }

  if (method === 'GET' && pathname === '/api/health') {
    const db = await store.health();
    const ok = db;
    json(res, ok ? 200 : 503, {
      ok,
      build: config.buildTag,
      store: 'supabase',
      db,
      push: pushEnabled() ? 'vapid' : 'disabled',
      realtime: 'sse',
      crypto: 'X3DH + Double Ratchet / XChaCha20-Poly1305',
      protocol: 1,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }

  /* ---------- Auth: register ---------- */
  if (method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJson(req);
    const username = String(body.username || '').toLowerCase().trim();
    const password = String(body.password || '');
    const displayName = body.displayName ? cleanText(String(body.displayName), 40) : null;
    const avatarColor = body.avatarColor !== undefined ? clampInt(body.avatarColor, 0, 7, 0) : 0;
    const ip = clientIp(req);

    if (!USERNAME_RE.test(username)) {
      throw httpError(400, 'invalid_username', 'Username must be 3-32 characters: letters, numbers, underscore, dash, dot.');
    }
    if (password.length < 8) {
      throw httpError(400, 'weak_password', 'Password must be at least 8 characters.');
    }
    if (password.length > 128) {
      throw httpError(400, 'weak_password', 'Password too long.');
    }

    await permit(store, 'auth:register', ip, 3600, 10);

    const existing = await store.findUserByUsername(username);
    if (existing) {
      throw httpError(409, 'username_taken', 'That username is already taken.');
    }

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await store.createUser({
        username,
        passwordHash,
        displayName: displayName || username,
        avatarColor
      });
    } catch (error) {
      if (error?.status === 409 || /duplicate|unique/i.test(String(error?.message || ''))) {
        throw httpError(409, 'username_taken', 'That username is already taken.');
      }
      throw error;
    }

    const updated = await store.findUserById(user.id);
    await issueSession(store, req, res, updated);

    json(res, 200, {
      ok: true,
      user: clientUser(updated),
      isNew: true,
      hasVault: false,
      build: config.buildTag
    });
    return;
  }

  /* ---------- Auth: login ---------- */
  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const username = String(body.username || '').toLowerCase().trim();
    const password = String(body.password || '');
    const ip = clientIp(req);

    if (!username || !password) {
      throw httpError(400, 'missing_credentials', 'Enter your username and password.');
    }
    // Same character set as registration: keeps the value safe as a PostgREST
    // filter and avoids odd errors from usernames containing commas or dots.
    if (!USERNAME_RE.test(username)) {
      throw httpError(401, 'invalid_credentials', 'Invalid username or password.');
    }

    await permit(store, 'auth:login', ip, 600, 10);
    await permit(store, 'auth:login-user', username, 900, 5);

    const user = await store.findUserByUsername(username);
    if (!user) {
      // Burn the same scrypt cost to reduce username-enumeration timing leaks.
      await burnPasswordTime(password);
      throw httpError(401, 'invalid_credentials', 'Invalid username or password.');
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw httpError(401, 'invalid_credentials', 'Invalid username or password.');
    }

    await issueSession(store, req, res, user);
    const backup = await store.getVaultRecovery(user.id).catch(() => null);

    json(res, 200, {
      ok: true,
      user: clientUser(user),
      isNew: false,
      hasVault: Boolean(backup),
      build: config.buildTag
    });
    return;
  }

  /* ---------- Auth: me ---------- */
  if (method === 'GET' && pathname === '/api/auth/me') {
    const auth = await requireSession(req, store);
    const backup = await store.getVaultRecovery(auth.user.id).catch(() => null);
    json(res, 200, {
      user: clientUser(auth.user),
      hasVault: Boolean(backup),
      build: config.buildTag,
      vapidPublicKey: publicVapidKey(),
      maxUploadBytes: config.maxUploadBytes
    });
    return;
  }

  /* ---------- Auth: logout ---------- */
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const auth = await getSession(req, store);
    if (auth) await store.deleteSessionByHash(auth.tokenHash);
    clearSessionCookie(res);
    json(res, 200, { ok: true });
    return;
  }

  /* ---------- Auth: sessions ---------- */
  if (method === 'GET' && pathname === '/api/auth/sessions') {
    const auth = await requireSession(req, store);
    const rows = await store.listSessions(auth.user.id);
    json(res, 200, {
      sessions: (rows || []).map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        expiresAt: s.expires_at,
        current: s.id === auth.session.id
      }))
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/logout-all') {
    const auth = await requireSession(req, store);
    await store.deleteAllSessions(auth.user.id);
    clearSessionCookie(res);
    json(res, 200, { ok: true });
    return;
  }

  /* ---------- Auth: profile ---------- */
  if (method === 'PATCH' && pathname === '/api/auth/profile') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const patch = {};
    if (body.displayName !== undefined) {
      const name = cleanText(String(body.displayName), 40);
      if (name.length < 1) throw httpError(400, 'invalid_name', 'Enter a display name.');
      patch.display_name = name;
    }
    if (body.avatarColor !== undefined) {
      patch.avatar_color = clampInt(body.avatarColor, 0, 7, 0);
    }
    if (body.presenceVisible !== undefined) {
      patch.presence_visible = Boolean(body.presenceVisible);
    }
    if (!Object.keys(patch).length) throw httpError(400, 'nothing_to_update', 'Nothing to update.');
    const user = await store.updateUser(auth.user.id, patch);
    json(res, 200, { user: clientUser(user) });
    return;
  }

  /* ---------- Auth: presence ---------- */
  if (method === 'POST' && pathname === '/api/auth/presence') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    await permit(store, 'presence:user', auth.user.id, 10, 4);
    const visible = body.visible !== false;
    const user = await store.setPresence(auth.user.id, { visible, online: body.online !== false });
    const peers = await store.listPeerIds(auth.user.id);
    const payload = {
      userId: auth.user.id,
      presenceVisible: visible,
      lastSeenAt: visible ? user.last_seen_at : null,
      online: visible && body.online !== false
    };
    await Promise.all(peers.map((peerId) => store.emit(peerId, 'presence', payload)));
    json(res, 200, { ok: true, lastSeenAt: user.last_seen_at });
    return;
  }

  /* ---------- Connections ---------- */
  if (method === 'GET' && pathname === '/api/connections') {
    const auth = await requireSession(req, store);
    const lists = await store.listConnectionRequests(auth.user.id);
    json(res, 200, {
      incoming: (lists.incoming || []).map(mapRequest),
      outgoing: (lists.outgoing || []).map(mapRequest)
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/connections') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const username = String(body.username || '').toLowerCase().trim();
    if (!USERNAME_RE.test(username)) {
      throw httpError(400, 'invalid_username', 'Enter a valid username.');
    }
    await permit(store, 'connect:hour', auth.user.id, 3600, 20);
    const target = await store.findUserByUsername(username);
    if (!target) throw httpError(404, 'not_found', 'No Duet account uses that username.');
    if (target.id === auth.user.id) throw httpError(400, 'self', 'That is your own username.');

    const existing = await store.conversationBetween(auth.user.id, target.id);
    if (existing) {
      json(res, 200, { status: 'existing', conversationId: existing });
      return;
    }
    const incoming = await store.findPendingConnection(target.id, auth.user.id);
    if (incoming) {
      const accepted = await store.acceptConnection(incoming.id, auth.user.id);
      if (accepted?.conversation_id) {
        await Promise.all([auth.user.id, target.id].map((id) =>
          store.emit(id, 'conversation', { conversationId: accepted.conversation_id })));
        json(res, 200, { status: 'accepted', conversationId: accepted.conversation_id });
        return;
      }
    }
    const pending = await store.findPendingConnection(auth.user.id, target.id);
    if (pending) {
      json(res, 200, { status: 'pending', requestId: pending.id });
      return;
    }
    const request = await store.createConnectionRequest({
      fromUser: auth.user.id, toUser: target.id
    });
    await store.emit(target.id, 'connection_request', {
      requestId: request.id,
      peer: peerUser(auth.user)
    });
    void notifyUser(store, target.id).catch(() => {});
    json(res, 200, { status: 'pending', requestId: request.id });
    return;
  }

  if (method === 'POST' && pathname === '/api/connections/respond') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const requestId = String(body.requestId || '');
    if (!validUuid(requestId)) throw httpError(400, 'bad_request', 'A valid requestId is required.');
    const action = String(body.action || '');
    if (!['accept', 'decline'].includes(action)) {
      throw httpError(400, 'bad_action', 'action must be accept or decline.');
    }
    if (action === 'decline') {
      const reqRow = await store.declineConnection(requestId, auth.user.id);
      if (!reqRow) throw httpError(404, 'not_found', 'That request is no longer pending.');
      json(res, 200, { ok: true, status: 'declined' });
      return;
    }
    const accepted = await store.acceptConnection(requestId, auth.user.id);
    if (!accepted?.conversation_id) {
      throw httpError(404, 'not_found', 'That request is no longer pending.');
    }
    await Promise.all([
      auth.user.id,
      accepted.peer_id ? String(accepted.peer_id) : null
    ].filter(Boolean).map((id) =>
      store.emit(id, 'conversation', { conversationId: accepted.conversation_id })));
    json(res, 200, { ok: true, status: 'accepted', conversationId: accepted.conversation_id });
    return;
  }

  /* ---------- Conversations ---------- */
  if (method === 'GET' && pathname === '/api/conversations') {
    const auth = await requireSession(req, store);
    const rows = await store.listConversations(auth.user.id);
    json(res, 200, { conversations: (rows || []).map(mapConversation) });
    return;
  }

  const conversationMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})$/i);
  if (method === 'GET' && conversationMatch) {
    const auth = await requireSession(req, store);
    const conversationId = conversationMatch[1];
    if (!validUuid(conversationId)) throw httpError(400, 'bad_conversation', 'Invalid conversation.');
    const data = await store.getConversation(conversationId, auth.user.id);
    json(res, 200, {
      conversation: {
        id: data.conversation?.id,
        createdAt: data.conversation?.created_at,
        lastMessageAt: data.conversation?.last_message_at
      },
      peer: peerUser(data.peer),
      participants: data.participants.map((p) => ({
        userId: p.user_id, lastReadAt: p.last_read_at
      }))
    });
    return;
  }

  /* ---------- Messages ---------- */
  if (method === 'GET' && pathname === '/api/messages') {
    const auth = await requireSession(req, store);
    const conversationId = conversationIdFrom(url);
    await store.getConversation(conversationId, auth.user.id);
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 40);
    const before = decodeCursor(url.searchParams.get('before'));
    const rows = await store.listMessages(conversationId, before, limit);

    const deliveredAt = await store.markDelivered(conversationId, auth.user.id).catch(() => null);
    if (deliveredAt) {
      const peer = await store.getConversation(conversationId, auth.user.id);
      const peerId = peer.participants.find((p) => p.user_id !== auth.user.id)?.user_id;
      if (peerId) {
        await store.emit(peerId, 'receipt', {
          conversationId, kind: 'delivered', at: deliveredAt
        }).catch(() => {});
      }
    }

    const messages = (rows || []).map(mapMessage);
    const last = messages[messages.length - 1];
    json(res, 200, {
      messages,
      hasMore: messages.length === limit,
      nextCursor: last ? encodeCursor(last.createdAt, last.id) : null
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/messages') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const conversationId = String(body.conversationId || '');
    if (!validUuid(conversationId)) throw httpError(400, 'bad_conversation', 'Invalid conversation.');
    const participant = await store.getConversation(conversationId, auth.user.id);
    const type = String(body.type || 'text');
    if (!MESSAGE_TYPES.has(type)) throw httpError(400, 'bad_type', 'Unsupported message type.');
    const clientId = String(body.clientId || '');
    if (!CLIENT_ID_RE.test(clientId)) throw httpError(400, 'bad_client_id', 'Invalid clientId.');
    const ciphertext = validateCiphertext(body.ciphertext);
    const envelope = validateEnvelope(body.envelope);
    const mediaId = body.mediaId ? String(body.mediaId) : null;
    if (mediaId && !validUuid(mediaId)) throw httpError(400, 'bad_media', 'Invalid media id.');
    if (['image', 'video'].includes(type) && !mediaId) {
      throw httpError(400, 'media_required', 'Attachments require an uploaded media id.');
    }
    if (mediaId) {
      const media = await store.findMedia(mediaId);
      if (!media || media.conversation_id !== conversationId || media.uploader_id !== auth.user.id) {
        throw httpError(404, 'media_not_found', 'That upload could not be attached.');
      }
    }
    const mediaMeta = sanitizeMediaMeta(body.mediaMeta);

    const result = await store.insertMessage({
      conversationId,
      senderId: auth.user.id,
      type,
      ciphertext,
      envelope,
      clientId,
      mediaId,
      mediaMeta
    });
    if (!result?.row) throw httpError(500, 'insert_failed', 'The message could not be stored.');

    if (!result.duplicate) {
      const peerIds = participant.participants
        .map((p) => p.user_id).filter((id) => id !== auth.user.id);
      const message = mapMessage(result.row);
      await Promise.all(peerIds.map((peerId) =>
        store.emit(peerId, 'message', { conversationId, message }).catch(() => {})));
      for (const peerId of peerIds) {
        void notifyUser(store, peerId).catch(() => {});
      }
    }
    json(res, 200, { message: mapMessage(result.row), duplicate: Boolean(result.duplicate) });
    return;
  }

  const messageMatch = pathname.match(/^\/api\/messages\/([0-9a-f-]{36})$/i);
  if (method === 'PATCH' && messageMatch) {
    const auth = await requireSession(req, store);
    const id = messageMatch[1];
    if (!validUuid(id)) throw httpError(400, 'bad_message', 'Invalid message id.');
    const existing = await store.getMessage(id);
    if (!existing) throw httpError(404, 'not_found', 'That message is gone.');
    if (existing.sender_id !== auth.user.id) {
      throw httpError(403, 'not_sender', 'You can only change your own messages.');
    }
    const body = await readJson(req);
    let row;
    let kind;
    let payload;
    if (body.deleted) {
      row = await store.updateMessage(id, auth.user.id, {
        deleted_at: new Date().toISOString(),
        ciphertext: null,
        envelope: null,
        media_id: null,
        media_meta: null
      });
      if (existing.media_id) await store.deleteMedia(existing.media_id).catch(() => {});
      kind = 'message_deleted';
      payload = { conversationId: existing.conversation_id, messageId: id, deletedAt: row?.deleted_at };
    } else {
      const ciphertext = validateCiphertext(body.ciphertext);
      const envelope = validateEnvelope(body.envelope);
      if (existing.deleted_at) throw httpError(409, 'deleted', 'That message was deleted.');
      row = await store.updateMessage(id, auth.user.id, {
        ciphertext,
        envelope,
        edited_at: new Date().toISOString()
      });
      kind = 'message_edit';
      payload = {
        conversationId: existing.conversation_id,
        messageId: id,
        ciphertext,
        envelope,
        editedAt: row?.edited_at
      };
    }
    if (!row) throw httpError(404, 'not_found', 'That message is gone.');
    const participant = await store.getConversation(existing.conversation_id, auth.user.id);
    await Promise.all(participant.participants.map((p) =>
      store.emit(p.user_id, kind, payload).catch(() => {})));
    json(res, 200, { message: mapMessage(row) });
    return;
  }

  if (method === 'POST' && pathname === '/api/messages/read') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const conversationId = String(body.conversationId || '');
    if (!validUuid(conversationId)) throw httpError(400, 'bad_conversation', 'Invalid conversation.');
    await store.getConversation(conversationId, auth.user.id);
    const result = await store.markRead(conversationId, auth.user.id);
    if (result?.peerId) {
      await store.emit(result.peerId, 'receipt', {
        conversationId, kind: 'read', at: result.at
      }).catch(() => {});
    }
    json(res, 200, { ok: true, readAt: result?.at || new Date().toISOString() });
    return;
  }

  /* ---------- Keys ---------- */
  if (method === 'GET' && pathname === '/api/keys') {
    const auth = await requireSession(req, store);
    const conversationId = conversationIdFrom(url);
    const bundle = await store.getPeerBundle(conversationId, auth.user.id);
    json(res, 200, { bundle });
    return;
  }

  if (method === 'POST' && pathname === '/api/keys/consume') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const conversationId = String(body.conversationId || '');
    if (!validUuid(conversationId)) throw httpError(400, 'bad_conversation', 'Invalid conversation.');
    const bundle = await store.consumePeerPrekey(conversationId, auth.user.id);
    if (!bundle) throw httpError(404, 'keys_unavailable', 'Their encryption keys are not published yet.');
    json(res, 200, { bundle });
    return;
  }

  if (method === 'POST' && pathname === '/api/keys') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const bundle = parseKeyBundle(body);
    const result = await store.publishBundle(auth.user.id, bundle.deviceId, bundle);
    json(res, 200, { ok: true, pool: result.pool });
    return;
  }

  if (method === 'GET' && pathname === '/api/keys/self') {
    const auth = await requireSession(req, store);
    const deviceId = String(url.searchParams.get('deviceId') || '');
    if (!DEVICE_RE.test(deviceId)) throw httpError(400, 'bad_device', 'Invalid device id.');
    const bundle = await store.getSelfBundle(auth.user.id, deviceId);
    json(res, 200, { bundle });
    return;
  }

  if (method === 'POST' && pathname === '/api/keys/repair') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const conversationId = String(body.conversationId || '');
    if (!validUuid(conversationId)) throw httpError(400, 'bad_conversation', 'Invalid conversation.');
    await permit(store, 'repair', `${auth.user.id}:${conversationId}`, 600, 4);
    const data = await store.getConversation(conversationId, auth.user.id);
    const peerId = data.participants.find((p) => p.user_id !== auth.user.id)?.user_id;
    if (peerId) {
      await store.emit(peerId, 'session_request', {
        conversationId,
        fromUserId: auth.user.id
      });
      void notifyUser(store, peerId).catch(() => {});
    }
    json(res, 200, { ok: true });
    return;
  }

  /* ---------- Media ---------- */
  if (method === 'POST' && pathname === '/api/media/upload') {
    const auth = await requireSession(req, store);
    const conversationId = String(url.searchParams.get('conversationId') || '');
    if (!validUuid(conversationId)) throw httpError(400, 'bad_conversation', 'Invalid conversation.')
    await store.getConversation(conversationId, auth.user.id);
    const length = Number(req.headers['content-length'] || 0);
    if (length > config.maxUploadBytes) {
      throw httpError(413, 'too_large', `Attachments are limited to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
    }
    const bytes = await readBody(req, config.maxUploadBytes);
    if (!bytes.length) throw httpError(400, 'empty', 'The upload was empty.');
    await permit(store, 'media:upload', auth.user.id, 3600, 120);
    const id = crypto.randomUUID();
    const storagePath = `${conversationId}/${id}.enc`;
    await store.putMediaBlob(storagePath, bytes);
    const media = await store.createMedia({
      id,
      uploaderId: auth.user.id,
      conversationId,
      storagePath,
      sizeBytes: bytes.length,
      mimeHint: cleanText(String(req.headers['x-mime-hint'] || ''), 80)
    });
    json(res, 200, { id: media.id, size: bytes.length });
    return;
  }

  const mediaMatch = pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
  if (method === 'GET' && mediaMatch) {
    const auth = await requireSession(req, store);
    const media = await store.findMedia(mediaMatch[1]);
    if (!media) throw httpError(404, 'not_found', 'That attachment is gone.');
    await store.getConversation(media.conversation_id, auth.user.id);
    const response = await store.getMediaBlob(media.storage_path);
    await serveMediaResponse(res, response);
    return;
  }

  /* ---------- Invites ---------- */
  if (method === 'POST' && pathname === '/api/invites') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const hours = clampInt(body.expiresInHours, 1, 168, 72);
    await permit(store, 'invite:create', auth.user.id, 3600, 20);
    const token = randomToken(24);
    const invite = await store.createInvite({
      tokenHash: sha256Hex(token),
      createdBy: auth.user.id,
      expiresAt: new Date(Date.now() + hours * 3600_000).toISOString()
    });
    json(res, 200, {
      invite: {
        id: invite.id,
        token,
        url: `${config.appOrigin}/#/invite/${token}`,
        expiresAt: invite.expires_at
      }
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/invites/redeem') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const token = String(body.token || '').trim();
    if (token.length < 16 || token.length > 200) {
      throw httpError(400, 'invalid_invite', 'That invite link is not valid.')
    }
    await permit(store, 'invite:redeem', auth.user.id, 3600, 20);
    const result = await store.redeemInvite(sha256Hex(token), auth.user.id);
    if (!result) throw httpError(404, 'invite_invalid', 'That invite is invalid or has already been used.')
    const peer = await store.findUserById(result.peer_id);
    await Promise.all([
      auth.user.id,
      String(result.peer_id)
    ].map((id) => store.emit(id, 'conversation', { conversationId: result.conversation_id })));
    json(res, 200, {
      conversationId: result.conversation_id,
      peer: peerUser(peer)
    });
    return;
  }

  /* ---------- Realtime ---------- */
  if (method === 'GET' && pathname === '/api/realtime') {
    const auth = await requireSession(req, store);
    await streamRealtime(req, res, url, store, auth);
    return;
  }

  /* ---------- Push ---------- */
  if (method === 'GET' && pathname === '/api/push/public-key') {
    await requireSession(req, store);
    json(res, 200, { publicKey: publicVapidKey(), enabled: pushEnabled() });
    return;
  }

  if (method === 'POST' && pathname === '/api/push/subscribe') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const endpoint = String(body.endpoint || '');
    if (!endpoint.startsWith('https://') || endpoint.length > 1200) {
      throw httpError(400, 'bad_subscription', 'Invalid push endpoint.')
    }
    const keys = body.keys || {};
    if (!isB64(keys.p256dh, 65) || !isB64(keys.auth, 16)) {
      throw httpError(400, 'bad_subscription', 'Invalid push keys.')
    }
    await store.savePushSubscription({
      userId: auth.user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: cleanText(String(req.headers['user-agent'] || ''), 220)
    });
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && pathname === '/api/push/unsubscribe') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const endpoint = String(body.endpoint || '');
    if (endpoint) await store.removePushSubscription(auth.user.id, endpoint);
    json(res, 200, { ok: true });
    return;
  }

  /* ---------- Vault ---------- */
  if (method === 'PUT' && pathname === '/api/vault') {
    const auth = await requireSession(req, store);
    const body = await readJson(req);
    const deviceId = String(body.deviceId || '');
    if (!DEVICE_RE.test(deviceId)) throw httpError(400, 'bad_device', 'Invalid device id.')
    if (!isB64(body.recoverySalt, 16)) throw httpError(400, 'bad_vault', 'Invalid recovery salt.')
    if (typeof body.wrappedMk !== 'string' || body.wrappedMk.length < 20 || body.wrappedMk.length > 400) {
      throw httpError(400, 'bad_vault', 'Invalid wrapped key.')
    }
    if (typeof body.keystoreBlob !== 'string' || body.keystoreBlob.length < 20 ||
        body.keystoreBlob.length > 4_000_000) {
      throw httpError(400, 'bad_vault', 'Invalid keystore backup.')
    }
    await permit(store, 'vault:write', auth.user.id, 600, 120);
    await store.putVault({
      userId: auth.user.id,
      deviceId,
      recoverySalt: body.recoverySalt,
      wrappedMk: body.wrappedMk,
      keystoreBlob: body.keystoreBlob,
      keyVersion: clampInt(body.keyVersion, 1, 9, 1)
    });
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/vault/recovery') {
    const auth = await requireSession(req, store);
    const row = await store.getVaultRecovery(auth.user.id);
    if (!row) {
      json(res, 200, { backup: null });
      return;
    }
    json(res, 200, {
      backup: {
        deviceId: row.device_id,
        recoverySalt: row.recovery_salt,
        wrappedMk: row.wrapped_mk,
        keystoreBlob: row.keystore_blob,
        keyVersion: row.key_version,
        updatedAt: row.updated_at
      }
    });
    return;
  }

  /* ---------- Diagnostics ---------- */
  if (method === 'POST' && pathname === '/api/diag') {
    const auth = await requireSession(req, store);
    if (!config.diagnostics) {
      json(res, 200, { ok: true, skipped: true });
      return;
    }
    const body = await readJson(req);
    const events = Array.isArray(body.events) ? body.events.slice(0, 60) : [];
    await permit(store, 'diag:user', auth.user.id, 3600, 240);
    const clientBuild = typeof body.build === 'string' ? body.build.slice(0, 80) : null;
    const stored = [];
    for (const event of events) {
      if (!event || !DIAG_EVENTS.has(event.event)) continue;
      const fields = {};
      for (const [key, value] of Object.entries(event.fields || {})) {
        if (!DIAG_FIELDS.has(key)) continue;
        if (typeof value === 'string') fields[key] = value.slice(0, 120);
        else if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
        else if (typeof value === 'boolean') fields[key] = value;
      }
      if (clientBuild) fields.clientBuild = clientBuild;
      stored.push({ event: event.event, fields });
    }
    await Promise.all(stored.map((item) =>
      store.insertDiagnostic(auth.user.id, config.buildTag, item.event, item.fields)));
    json(res, 200, { ok: true, stored: stored.length });
    return;
  }

  throw httpError(404, 'not_found', 'No such endpoint.');
}

/* ---- Password hashing (scrypt, memory-hard) ---- */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT_PARAMS);
  return `$scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, hash) {
  try {
    const parts = hash.split('$');
    if (parts[1] !== 'scrypt') return false;
    const params = Object.fromEntries(parts[2].split(',').map((pair) => {
      const [key, value] = pair.split('=');
      return [key, parseInt(value, 10)];
    }));
    if (params.N !== 16384 || params.r !== 8 || params.p !== 1) return false;
    const salt = Buffer.from(parts[3], 'base64');
    const expectedHash = Buffer.from(parts[4], 'base64');
    if (expectedHash.length !== 32) return false;
    const derived = await scryptAsync(password, salt, 32, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(derived, expectedHash);
  } catch {
    return false;
  }
}

/** Burn the same scrypt cost for unknown usernames (timing-side-channel filler). */
async function burnPasswordTime(password) {
  try {
    await scryptAsync(password, 'duet-fake-salt-000000000000000000', 32, SCRYPT_PARAMS);
  } catch { /* ignore */ }
}

export function handleApiError(res, error) {
  if (error instanceof HttpError) {
    fail(res, error.status, error.code, error.message, error.extra || {});
    return true;
  }
  if (error?.name === 'PayloadTooLargeError') {
    fail(res, 413, 'too_large', 'That request is too large.');
    return true;
  }
  log('Unhandled API error', error?.stack || error?.message || String(error));
  fail(res, 500, 'server_error', 'Something went wrong on our side.');
  return true;
}