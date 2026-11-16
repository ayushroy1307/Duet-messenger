import crypto from 'node:crypto';
import { Supabase } from './supabase.js';
import { config } from './config.js';
import { httpError } from './util.js';

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const inList = (ids) => `in.(${ids.map((id) => `"${id}"`).join(',')})`;

/* ========================================================================== */
/* Supabase store                                                             */
/* ========================================================================== */

export class SupabaseStore {
  constructor() {
    this.driver = 'supabase';
    this.db = new Supabase(config.supabase.url, config.supabase.key, config.supabase.bucket);
    this.bucketReady = null;
  }

  async init() { /* schema is applied with supabase/schema.sql */ }

  async health() {
    return this.db.health();
  }

  /* ---- users ---- */
  async findUserByUsername(username) {
    const rows = await this.db.select('users', { username: `eq.${username}`, limit: 1 });
    return rows?.[0] || null;
  }

  async findUserById(id) {
    if (!id) return null;
    const rows = await this.db.select('users', { id: `eq.${id}`, limit: 1 });
    return rows?.[0] || null;
  }

  async findUsersByIds(ids) {
    if (!ids?.length) return [];
    return this.db.select('users', { id: inList([...new Set(ids)]), limit: ids.length });
  }

  async createUser({ username, passwordHash, displayName = null, avatarColor = 0 }) {
    const rows = await this.db.insert('users', [{
      username,
      password_hash: passwordHash,
      display_name: displayName || username,
      avatar_color: avatarColor
    }]);
    return rows?.[0] || null;
  }

  async updateUser(id, patch) {
    const rows = await this.db.update('users', { id: `eq.${id}` }, { ...patch, updated_at: now() });
    return rows?.[0] || null;
  }

  async setPresence(id, { visible, online }) {
    return this.updateUser(id, {
      presence_visible: Boolean(visible),
      presence_online: online !== false,
      last_seen_at: now()
    });
  }

  async listPeerIds(userId) {
    const rows = await this.db.rpc('duet_peer_ids', { p_user: userId });
    return (rows || []).map((row) => row.peer_id);
  }

  /* ---- sessions ---- */
  async createSession({ userId, tokenHash, userAgent, ip, expiresAt }) {
    const rows = await this.db.insert('sessions', [{
      user_id: userId,
      token_hash: tokenHash,
      user_agent: userAgent,
      ip,
      expires_at: expiresAt
    }]);
    return rows?.[0] || null;
  }

  async findSession(tokenHash) {
    const rows = await this.db.select('sessions', {
      token_hash: `eq.${tokenHash}`,
      expires_at: `gt.${now()}`,
      limit: 1
    });
    const session = rows?.[0];
    if (!session) return null;
    const user = await this.findUserById(session.user_id);
    if (!user) return null;
    return { session, user };
  }

  async touchSession(id) {
    await this.db.update('sessions', { id: `eq.${id}` }, { last_used_at: now() }, { returning: false });
  }

  async deleteSessionByHash(tokenHash) {
    await this.db.remove('sessions', { token_hash: `eq.${tokenHash}` });
  }

  async deleteAllSessions(userId) {
    await this.db.remove('sessions', { user_id: `eq.${userId}` });
  }

  async cleanupSessions() {
    await this.db.remove('sessions', { expires_at: `lt.${now()}` });
  }

  async listSessions(userId) {
    return this.db.select('sessions', {
      user_id: `eq.${userId}`,
      expires_at: `gt.${now()}`,
      order: 'created_at.desc',
      select: 'id,user_agent,ip,created_at,last_used_at,expires_at'
    });
  }

  /* ---- invites ---- */
  async createInvite({ tokenHash, createdBy, expiresAt }) {
    const rows = await this.db.insert('invites', [{
      token_hash: tokenHash, created_by: createdBy, expires_at: expiresAt
    }]);
    return rows?.[0] || null;
  }

  async redeemInvite(tokenHash, userId) {
    const rows = await this.db.rpc('duet_redeem_invite', { p_token_hash: tokenHash, p_user: userId });
    return rows?.[0] || null;
  }

  /* ---- connections ---- */
  async findPendingConnection(fromUser, toUser) {
    const rows = await this.db.select('connection_requests', {
      from_user_id: `eq.${fromUser}`,
      to_user_id: `eq.${toUser}`,
      status: 'eq.pending',
      limit: 1
    });
    return rows?.[0] || null;
  }

  async createConnectionRequest({ fromUser, toUser }) {
    // The pair is unique, so a previously declined request is reopened rather
    // than failing on the unique constraint.
    const rows = await this.db.upsert('connection_requests', [{
      from_user_id: fromUser,
      to_user_id: toUser,
      status: 'pending',
      responded_at: null,
      created_at: now()
    }], { onConflict: 'from_user_id,to_user_id' });
    return rows?.[0] || null;
  }

  async listConnectionRequests(userId) {
    const [incoming, outgoing] = await Promise.all([
      this.db.select('connection_requests', {
        to_user_id: `eq.${userId}`,
        status: 'eq.pending',
        order: 'created_at.desc',
        limit: 50
      }),
      this.db.select('connection_requests', {
        from_user_id: `eq.${userId}`,
        status: 'eq.pending',
        order: 'created_at.desc',
        limit: 50
      })
    ]);
    const users = await this.findUsersByIds([
      ...(incoming || []).map((r) => r.from_user_id),
      ...(outgoing || []).map((r) => r.to_user_id)
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      incoming: (incoming || []).map((r) => ({ ...r, peer: byId.get(r.from_user_id) || null })),
      outgoing: (outgoing || []).map((r) => ({ ...r, peer: byId.get(r.to_user_id) || null }))
    };
  }

  async getConnectionRequest(id) {
    const rows = await this.db.select('connection_requests', { id: `eq.${id}`, limit: 1 });
    return rows?.[0] || null;
  }

  async acceptConnection(id, userId) {
    const rows = await this.db.rpc('duet_accept_connection', { p_request_id: id, p_user: userId });
    return rows?.[0] || null;
  }

  async declineConnection(id, userId) {
    const rows = await this.db.update('connection_requests', {
      id: `eq.${id}`, to_user_id: `eq.${userId}`, status: 'eq.pending'
    }, { status: 'declined', responded_at: now() });
    return rows?.[0] || null;
  }

  /* ---- conversations ---- */
  async conversationBetween(a, b) {
    const mine = await this.db.select('conversation_participants', {
      user_id: `eq.${a}`,
      select: 'conversation_id',
      limit: 200
    });
    if (!mine?.length) return null;
    const ids = mine.map((r) => r.conversation_id);
    const rows = await this.db.select('conversation_participants', {
      conversation_id: inList(ids),
      user_id: `eq.${b}`,
      limit: 1
    });
    return rows?.[0]?.conversation_id || null;
  }

  async listConversations(userId) {
    const rows = await this.db.rpc('duet_list_conversations', { p_user: userId });
    return rows || [];
  }

  async getConversation(conversationId, userId) {
    const participants = await this.db.select('conversation_participants', {
      conversation_id: `eq.${conversationId}`,
      select: 'conversation_id,user_id,last_read_at,joined_at'
    });
    if (!participants?.some((p) => p.user_id === userId)) {
      throw httpError(403, 'not_a_participant', 'You are not part of this conversation.');
    }
    const convRows = await this.db.select('conversations', {
      id: `eq.${conversationId}`, limit: 1
    });
    const users = await this.findUsersByIds(participants.map((p) => p.user_id));
    const peer = users.find((u) => u.id !== userId) || null;
    return {
      conversation: convRows?.[0] || null,
      participants,
      peer
    };
  }

  async setLastRead(conversationId, userId) {
    const at = now();
    await this.db.update('conversation_participants', {
      conversation_id: `eq.${conversationId}`,
      user_id: `eq.${userId}`
    }, { last_read_at: at }, { returning: false });
    return at;
  }

  /* ---- messages ---- */
  async insertMessage(row) {
    const payload = {
      conversation_id: row.conversationId,
      sender_id: row.senderId,
      type: row.type,
      ciphertext: row.ciphertext,
      envelope: row.envelope,
      client_id: row.clientId,
      media_id: row.mediaId || null,
      media_meta: row.mediaMeta || null
    };
    const inserted = await this.db.insert('messages', [payload], {
      onConflict: 'conversation_id,client_id',
      ignoreDuplicates: true
    });
    if (inserted?.length) return { row: inserted[0], duplicate: false };
    const existing = await this.db.select('messages', {
      conversation_id: `eq.${row.conversationId}`,
      client_id: `eq.${row.clientId}`,
      limit: 1
    });
    return { row: existing?.[0] || null, duplicate: true };
  }

  async listMessages(conversationId, before, limit) {
    const filters = {
      conversation_id: `eq.${conversationId}`,
      order: 'created_at.desc,id.desc',
      limit
    };
    if (before) {
      filters.or = `(created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id}))`;
    }
    return this.db.select('messages', filters);
  }

  async getMessage(id) {
    const rows = await this.db.select('messages', { id: `eq.${id}`, limit: 1 });
    return rows?.[0] || null;
  }

  async updateMessage(id, senderId, patch) {
    const rows = await this.db.update('messages', {
      id: `eq.${id}`,
      sender_id: `eq.${senderId}`
    }, patch);
    return rows?.[0] || null;
  }

  async markDelivered(conversationId, readerId) {
    const participants = await this.db.select('conversation_participants', {
      conversation_id: `eq.${conversationId}`,
      user_id: `neq.${readerId}`,
      select: 'user_id'
    });
    const peerId = participants?.[0]?.user_id;
    if (!peerId) return null;
    const at = now();
    const updated = await this.db.update('messages', {
      conversation_id: `eq.${conversationId}`,
      sender_id: `eq.${peerId}`,
      delivered_at: 'is.null'
    }, { delivered_at: at });
    return updated?.length ? at : null;
  }

  async markRead(conversationId, readerId) {
    const participants = await this.db.select('conversation_participants', {
      conversation_id: `eq.${conversationId}`,
      user_id: `neq.${readerId}`,
      select: 'user_id'
    });
    const peerId = participants?.[0]?.user_id;
    if (!peerId) return null;
    const at = now();
    await this.db.update('messages', {
      conversation_id: `eq.${conversationId}`,
      sender_id: `eq.${peerId}`,
      read_at: 'is.null'
    }, { read_at: at, delivered_at: at });
    await this.setLastRead(conversationId, readerId);
    return { at, peerId };
  }

  /* ---- keys ---- */
  async getPeerBundle(conversationId, userId) {
    const { peer } = await this.getConversation(conversationId, userId);
    if (!peer) return null;
    const bundles = await this.db.select('key_bundles', {
      user_id: `eq.${peer.id}`,
      order: 'updated_at.desc',
      limit: 1
    });
    if (!bundles?.length) return null;
    const bundle = bundles[0];
    const pool = await this.db.count('one_time_prekeys', {
      user_id: `eq.${peer.id}`,
      device_id: `eq.${bundle.device_id}`
    });
    return {
      userId: peer.id,
      deviceId: bundle.device_id,
      identityKey: bundle.identity_key,
      signedPreKey: bundle.signed_prekey,
      oneTimePreKey: null,
      pool
    };
  }

  async consumePeerPrekey(conversationId, userId) {
    const { peer } = await this.getConversation(conversationId, userId);
    if (!peer) return null;
    const allocatedRows = await this.db.rpc('duet_consume_prekey', { p_user_id: peer.id });
    const allocated = allocatedRows?.[0] || null;
    let bundleRows;
    if (allocated?.device_id) {
      bundleRows = await this.db.select('key_bundles', {
        user_id: `eq.${peer.id}`,
        device_id: `eq.${allocated.device_id}`,
        limit: 1
      });
    }
    if (!bundleRows?.length) {
      bundleRows = await this.db.select('key_bundles', {
        user_id: `eq.${peer.id}`,
        order: 'updated_at.desc',
        limit: 1
      });
    }
    const bundle = bundleRows?.[0];
    if (!bundle) return null;
    const pool = await this.db.count('one_time_prekeys', {
      user_id: `eq.${peer.id}`,
      device_id: `eq.${bundle.device_id}`
    });
    return {
      userId: peer.id,
      deviceId: bundle.device_id,
      identityKey: bundle.identity_key,
      signedPreKey: bundle.signed_prekey,
      oneTimePreKey: allocated ? {
        id: allocated.prekey_id,
        publicKey: allocated.public_key
      } : null,
      pool
    };
  }

  async publishBundle(userId, deviceId, data) {
    const existingRows = await this.db.select('key_bundles', {
      user_id: `eq.${userId}`,
      device_id: `eq.${deviceId}`,
      limit: 1
    });
    const existing = existingRows?.[0] || null;

    let signedPreKey = data.signedPreKey;
    if (!signedPreKey?.publicKey || !signedPreKey?.signature) {
      if (!existing) throw httpError(400, 'incomplete_bundle', 'A signed prekey is required for the first publish.');
      signedPreKey = existing.signed_prekey;
    }

    if (existing && existing.identity_key !== data.identityKey) {
      await this.db.remove('one_time_prekeys', {
        user_id: `eq.${userId}`,
        device_id: `eq.${deviceId}`
      });
    }

    await this.db.upsert('key_bundles', [{
      user_id: userId,
      device_id: deviceId,
      identity_key: data.identityKey,
      signed_prekey: signedPreKey,
      updated_at: now()
    }], { onConflict: 'user_id,device_id' });

    if (data.oneTimePreKeys?.length) {
      await this.db.insert('one_time_prekeys', data.oneTimePreKeys.map((key) => ({
        user_id: userId,
        device_id: deviceId,
        prekey_id: key.id,
        public_key: key.publicKey
      })), {
        onConflict: 'user_id,device_id,prekey_id',
        ignoreDuplicates: true
      });
    }

    const pool = await this.db.count('one_time_prekeys', {
      user_id: `eq.${userId}`,
      device_id: `eq.${deviceId}`
    });
    return { pool };
  }

  async getSelfBundle(userId, deviceId) {
    const rows = await this.db.select('key_bundles', {
      user_id: `eq.${userId}`,
      device_id: `eq.${deviceId}`,
      limit: 1
    });
    const bundle = rows?.[0];
    if (!bundle) return null;
    const pool = await this.db.count('one_time_prekeys', {
      user_id: `eq.${userId}`,
      device_id: `eq.${deviceId}`
    });
    return {
      identityKey: bundle.identity_key,
      signedPreKey: bundle.signed_prekey,
      pool,
      updatedAt: bundle.updated_at
    };
  }

  /* ---- media ---- */
  async ensureBucket() {
    if (!this.bucketReady) {
      this.bucketReady = this.db.ensureBucket().catch((error) => {
        this.bucketReady = null;
        throw error;
      });
    }
    return this.bucketReady;
  }

  async createMedia(row) {
    const rows = await this.db.insert('media', [{
      id: row.id,
      uploader_id: row.uploaderId,
      conversation_id: row.conversationId,
      storage_path: row.storagePath,
      size_bytes: row.sizeBytes,
      mime_hint: row.mimeHint
    }]);
    return rows?.[0] || null;
  }

  async deleteMedia(id) {
    const rows = await this.db.select('media', { id: `eq.${id}`, limit: 1 });
    const row = rows?.[0];
    await this.db.remove('media', { id: `eq.${id}` });
    if (row?.storage_path) {
      try { await this.db.removeObject(row.storage_path); } catch { /* best effort */ }
    }
  }

  async findMedia(id) {
    const rows = await this.db.select('media', { id: `eq.${id}`, limit: 1 });
    return rows?.[0] || null;
  }

  async putMediaBlob(storagePath, bytes) {
    await this.ensureBucket();
    await this.db.upload(storagePath, bytes, 'application/octet-stream');
  }

  async getMediaBlob(storagePath) {
    return this.db.download(storagePath);
  }

  /* ---- events / push / diagnostics ---- */
  async emit(userId, kind, payload = {}) {
    const rows = await this.db.insert('events', [{ user_id: userId, kind, payload }], { returning: false });
    return rows;
  }

  async latestEventId(userId) {
    const rows = await this.db.select('events', {
      user_id: `eq.${userId}`,
      select: 'id',
      order: 'id.desc',
      limit: 1
    });
    return Number(rows?.[0]?.id || 0);
  }

  async listEvents(userId, afterId, limit = 100) {
    return this.db.select('events', {
      user_id: `eq.${userId}`,
      id: `gt.${afterId}`,
      order: 'id.asc',
      limit
    });
  }

  async cleanupEvents() {
    await this.db.remove('events', {
      created_at: `lt.${new Date(Date.now() - 2 * 24 * 3600_000).toISOString()}`
    });
  }

  async savePushSubscription({ userId, endpoint, p256dh, auth, userAgent }) {
    await this.db.upsert('push_subscriptions', [{
      user_id: userId, endpoint, p256dh, auth, user_agent: userAgent
    }], { onConflict: 'user_id,endpoint' });
  }

  async removePushSubscription(userId, endpoint) {
    await this.db.remove('push_subscriptions', {
      user_id: `eq.${userId}`, endpoint: `eq.${endpoint}`
    });
  }

  async listPushSubscriptions(userId) {
    return this.db.select('push_subscriptions', { user_id: `eq.${userId}` }) || [];
  }

  async insertDiagnostic(userId, build, event, fields) {
    await this.db.insert('diagnostics', [{
      user_id: userId, build, event, fields
    }], { returning: false });
  }

  async putVault({ userId, deviceId, recoverySalt, wrappedMk, keystoreBlob, keyVersion }) {
    await this.db.upsert('vault_backups', [{
      user_id: userId,
      device_id: deviceId,
      recovery_salt: recoverySalt,
      wrapped_mk: wrappedMk,
      keystore_blob: keystoreBlob,
      key_version: keyVersion || 1,
      updated_at: now()
    }], { onConflict: 'user_id,device_id' });
  }

  async getVaultRecovery(userId) {
    const rows = await this.db.select('vault_backups', {
      user_id: `eq.${userId}`,
      order: 'updated_at.desc',
      limit: 1
    });
    return rows?.[0] || null;
  }

  async rateLimit(bucket, key, windowSeconds, limit) {
    return this.db.rpc('duet_rate_limit', {
      p_bucket: bucket,
      p_key: key,
      p_window_seconds: windowSeconds,
      p_limit: limit
    });
  }
}

export async function createStore() {
  const store = new SupabaseStore();
  await store.init();
  return store;
}