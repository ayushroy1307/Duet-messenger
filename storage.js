// Storage backends for the Duet relay. No dependencies: Supabase is reached through its REST APIs.
//   - FileStore / FileBlobs:     local JSON file + media folder (development)
//   - SupabaseStore / SupabaseBlobs: Postgres (PostgREST) + Storage bucket (production on Render)
// The server keeps a working set in memory (D) and calls store.save() after every mutation.
// SupabaseStore diffs D against what it last wrote and upserts only what changed, write-behind.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const emptyDb = () => ({ secret: crypto.randomBytes(32).toString('hex'), users: [], sessions: [], otp: [], invites: [], conversations: [], connections: [], messages: [], media: [], keys: {}, push: [], vapid: null });

// ---------------------------------------------------------------- file (dev)
export class FileStore {
  constructor(dir) {
    this.kind = 'file-json'; this.dir = dir; this.file = path.join(dir, 'db.json'); this.timer = null;
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    try { this.d = { ...emptyDb(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { this.d = emptyDb(); this._write(); }
  }
  _write() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.d)); fs.renameSync(tmp, this.file); }
  save(now = false) { clearTimeout(this.timer); if (now) this._write(); else this.timer = setTimeout(() => this._write(), 150); }
  async flush() { if (this.timer) this.save(true); }
}
export class FileBlobs {
  constructor(dir) { this.kind = 'disk'; this.dir = path.join(dir, 'media'); fs.mkdirSync(this.dir, { recursive: true }); }
  async put(id, buf) { await fsp.writeFile(path.join(this.dir, id + '.bin'), buf); }
  async get(id) { return fsp.readFile(path.join(this.dir, id + '.bin')); }
  async del(id) { await fsp.unlink(path.join(this.dir, id + '.bin')).catch(() => {}); }
}

// ------------------------------------------------------------ supabase (prod)
// Every collection is a table (id text primary key, data jsonb). messages additionally carries real columns
// so the two indexes the product needs exist: pagination on (conversation_id, created_at desc, id desc)
// and uniqueness on (conversation_id, client_id). See supabase/schema.sql.
const COLLECTIONS = [
  { name: 'users', table: 'duet_users', id: (x) => x.id },
  { name: 'sessions', table: 'duet_sessions', id: (x) => x.id },
  { name: 'otp', table: 'duet_otp_codes', id: (x) => x.phone },
  { name: 'invites', table: 'duet_invites', id: (x) => x.hash },
  { name: 'conversations', table: 'duet_conversations', id: (x) => x.id },
  { name: 'connections', table: 'duet_connection_requests', id: (x) => x.id },
  { name: 'messages', table: 'duet_messages', id: (x) => x.id, extra: (m) => ({ conversation_id: m.conversationId, created_at: m.createdAt, client_id: m.clientId, sender_id: m.senderId }) },
  { name: 'media', table: 'duet_media', id: (x) => x.id },
  { name: 'push', table: 'duet_push_subscriptions', id: (x) => sha(x.subscription.endpoint) },
];
const KEYS_TABLE = 'duet_prekeys'; // one row per user: the published public bundle
const META_TABLE = 'duet_meta';    // secret + vapid

export class SupabaseStore {
  constructor(url, serviceKey, log = console) {
    this.kind = 'supabase-postgres'; this.base = url.replace(/\/+$/, ''); this.key = serviceKey; this.log = log;
    this.d = emptyDb(); this.snap = new Map(); this.timer = null; this.running = null; this.dirty = false; this.failures = 0; this.lastError = null;
  }
  async _rest(method, pathq, body, extraHeaders = {}) {
    const res = await fetch(`${this.base}/rest/v1/${pathq}`, { method, headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json', ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Supabase ${method} ${pathq.split('?')[0]} -> ${res.status} ${t.slice(0, 200)}`); }
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  async _all(table) {
    const out = []; const page = 1000;
    for (let off = 0; ; off += page) {
      const rows = await this._rest('GET', `${table}?select=id,data&order=id.asc&limit=${page}&offset=${off}`);
      out.push(...rows); if (rows.length < page) return out;
    }
  }
  async load() {
    for (const c of COLLECTIONS) {
      const rows = await this._all(c.table); const m = new Map();
      this.d[c.name] = rows.map((r) => { m.set(r.id, JSON.stringify(r.data)); return r.data; });
      this.snap.set(c.name, m);
    }
    const km = new Map(); this.d.keys = {};
    for (const r of await this._all(KEYS_TABLE)) { this.d.keys[r.id] = r.data; km.set(r.id, JSON.stringify(r.data)); }
    this.snap.set('keys', km);
    const meta = await this._all(META_TABLE); const mm = new Map();
    for (const r of meta) { mm.set(r.id, JSON.stringify(r.data)); if (r.id === 'secret') this.d.secret = r.data.v; if (r.id === 'vapid') this.d.vapid = r.data; }
    this.snap.set('meta', mm);
    // keep a fresh secret persistent from the very first boot
    if (!mm.has('secret')) { this.dirty = true; await this.flush(); }
    return this;
  }
  _current(name) {
    const out = new Map();
    if (name === 'keys') { for (const [k, v] of Object.entries(this.d.keys)) out.set(k, { id: k, data: v }); return out; }
    if (name === 'meta') { out.set('secret', { id: 'secret', data: { v: this.d.secret } }); if (this.d.vapid) out.set('vapid', { id: 'vapid', data: this.d.vapid }); return out; }
    const c = COLLECTIONS.find((x) => x.name === name);
    for (const item of this.d[name]) { const id = c.id(item); out.set(id, { id, data: item, ...(c.extra ? c.extra(item) : {}) }); }
    return out;
  }
  async _sync() {
    const plan = [...COLLECTIONS.map((c) => [c.name, c.table]), ['keys', KEYS_TABLE], ['meta', META_TABLE]];
    for (const [name, table] of plan) {
      const cur = this._current(name); const prev = this.snap.get(name) || new Map(); const upserts = []; const next = new Map();
      for (const [id, row] of cur) { const j = JSON.stringify(row.data); next.set(id, j); if (prev.get(id) !== j) upserts.push(row); }
      const gone = [...prev.keys()].filter((id) => !cur.has(id));
      for (let i = 0; i < upserts.length;) { // batch by payload size, not just count
        let size = 0; const batch = [];
        while (i < upserts.length && batch.length < 200 && size < 1_500_000) { const r = upserts[i++]; size += JSON.stringify(r).length; batch.push(r); }
        await this._rest('POST', `${table}?on_conflict=id`, batch, { prefer: 'resolution=merge-duplicates,return=minimal' });
      }
      for (let i = 0; i < gone.length; i += 40) {
        const ids = gone.slice(i, i + 40).map((x) => `"${String(x).replace(/"/g, '')}"`).join(',');
        await this._rest('DELETE', `${table}?id=in.(${encodeURIComponent(ids)})`, undefined, { prefer: 'return=minimal' });
      }
      this.snap.set(name, next); // only after the table fully succeeded; a failed table is retried whole
    }
  }
  save() {
    this.dirty = true;
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; this._run(); }, 300);
  }
  _run() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (this.dirty) { this.dirty = false; await this._sync(); this.failures = 0; this.lastError = null; }
      } catch (e) {
        this.dirty = true; this.failures++; this.lastError = e.message; this.log.error('[store] sync failed:', e.message);
        this.timer = setTimeout(() => { this.timer = null; this._run(); }, Math.min(30000, 1000 * 2 ** this.failures));
      } finally { this.running = null; }
    })();
    return this.running;
  }
  async flush() { clearTimeout(this.timer); this.timer = null; if (this.dirty || this.running) { await this._run(); } }
  health() { return { ok: this.failures === 0, pendingWrites: this.dirty, lastError: this.lastError }; }
}

export class SupabaseBlobs {
  constructor(url, serviceKey, bucket) { this.kind = 'supabase-storage'; this.base = url.replace(/\/+$/, ''); this.key = serviceKey; this.bucket = bucket; }
  _h(extra = {}) { return { apikey: this.key, authorization: `Bearer ${this.key}`, ...extra }; }
  _u(id) { return `${this.base}/storage/v1/object/${this.bucket}/${encodeURIComponent(id)}`; }
  async put(id, buf) {
    const res = await fetch(this._u(id), { method: 'POST', headers: this._h({ 'content-type': 'application/octet-stream', 'x-upsert': 'true' }), body: buf });
    if (!res.ok) throw new Error(`Supabase Storage upload -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  }
  async get(id) {
    const res = await fetch(this._u(id), { headers: this._h() });
    if (!res.ok) throw new Error(`Supabase Storage download -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async del(id) { await fetch(this._u(id), { method: 'DELETE', headers: this._h() }).catch(() => {}); }
  /** Create the private bucket when it does not exist yet (needs the service-role key). */
  async ensureBucket() {
    const res = await fetch(`${this.base}/storage/v1/bucket`, { method: 'POST', headers: this._h({ 'content-type': 'application/json' }), body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false, file_size_limit: 27 * 1024 * 1024 }) });
    if (!res.ok && res.status !== 409 && !/already exists|Duplicate/i.test(await res.text().catch(() => ''))) throw new Error(`Could not create bucket ${this.bucket}: ${res.status}`);
  }
}

export async function createBackends(cfg, log = console) {
  if (cfg.supabaseUrl && cfg.supabaseKey) {
    const store = await new SupabaseStore(cfg.supabaseUrl, cfg.supabaseKey, log).load();
    const blobs = new SupabaseBlobs(cfg.supabaseUrl, cfg.supabaseKey, cfg.supabaseBucket);
    await blobs.ensureBucket();
    return { store, blobs };
  }
  return { store: new FileStore(cfg.dataDir), blobs: new FileBlobs(cfg.dataDir) };
}
