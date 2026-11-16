import { httpError } from './util.js';

export class SupabaseError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Tiny PostgREST + Storage client. The server uses the service-role key and
 * never exposes this client, the URL or the key to the browser.
 */
export class Supabase {
  constructor(url, key, bucket) {
    this.url = url.replace(/\/+$/, '');
    this.key = key;
    this.bucket = bucket || 'duet-media';
  }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      ...extra
    };
  }

  async request(path, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      expectJson = true,
      signal
    } = options;

    const finalHeaders = this.headers(headers);
    let payload = body;
    if (body !== undefined && body !== null &&
        !(body instanceof Uint8Array) && typeof body !== 'string' && !(body instanceof ArrayBuffer)) {
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: finalHeaders,
        body: payload,
        signal
      });
    } catch (error) {
      throw httpError(502, 'store_unreachable', 'The datastore is unreachable.', { cause: String(error) });
    }

    if (!res.ok) {
      let parsed = null;
      try { parsed = await res.json(); } catch { /* maybe empty */ }
      const message = parsed?.message || parsed?.error || `Datastore request failed (${res.status})`;
      throw new SupabaseError(res.status, message, parsed);
    }

    if (!expectJson) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  q(table, params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const suffix = search.toString();
    return `/rest/v1/${table}${suffix ? `?${suffix}` : ''}`;
  }

  select(table, params = {}) {
    return this.request(this.q(table, { select: '*', ...params }));
  }

  insert(table, rows, { onConflict, ignoreDuplicates = false, returning = true } = {}) {
    const params = {};
    if (onConflict) params.on_conflict = onConflict;
    const prefer = [
      returning ? 'return=representation' : 'return=minimal',
      ignoreDuplicates ? 'resolution=ignore-duplicates' : null
    ].filter(Boolean).join(',');
    return this.request(this.q(table, params), {
      method: 'POST',
      body: rows,
      headers: { Prefer: prefer }
    });
  }

  upsert(table, rows, { onConflict, returning = true } = {}) {
    const params = {};
    if (onConflict) params.on_conflict = onConflict;
    return this.request(this.q(table, params), {
      method: 'POST',
      body: rows,
      headers: {
        Prefer: `resolution=merge-duplicates,${returning ? 'return=representation' : 'return=minimal'}`
      }
    });
  }

  update(table, filters, patch, { returning = true } = {}) {
    return this.request(this.q(table, filters), {
      method: 'PATCH',
      body: patch,
      headers: {
        Prefer: returning ? 'return=representation' : 'return=minimal'
      }
    });
  }

  remove(table, filters, { returning = false } = {}) {
    return this.request(this.q(table, filters), {
      method: 'DELETE',
      headers: {
        Prefer: returning ? 'return=representation' : 'return=minimal'
      }
    });
  }

  async count(table, filters = {}) {
    const res = await this.request(this.q(table, { select: 'id', limit: 1, ...filters }), {
      expectJson: false,
      headers: { Prefer: 'count=exact', Range: '0-0' }
    });
    const range = res.headers.get('content-range') || '';
    const total = Number(range.split('/')[1]);
    return Number.isFinite(total) ? total : 0;
  }

  rpc(name, args = {}) {
    return this.request(`/rest/v1/rpc/${name}`, {
      method: 'POST',
      body: args
    });
  }

  storagePath(path) {
    const encoded = String(path).split('/').map(encodeURIComponent).join('/');
    return `/storage/v1/object/${this.bucket}/${encoded}`;
  }

  async ensureBucket() {
    try {
      await this.request('/storage/v1/bucket', {
        method: 'POST',
        body: { id: this.bucket, name: this.bucket, public: false },
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // 400/409 means it already exists. RLS/plan errors are reported by upload.
      if (!(error instanceof SupabaseError) || ![400, 409].includes(error.status)) throw error;
    }
  }

  async upload(path, bytes, contentType = 'application/octet-stream') {
    return this.request(this.storagePath(path), {
      method: 'POST',
      body: bytes,
      headers: {
        'Content-Type': contentType,
        'x-upsert': 'true',
        'cache-control': 'private, max-age=0'
      },
      expectJson: false
    });
  }

  async download(path) {
    return this.request(this.storagePath(path), {
      expectJson: false
    });
  }

  async removeObject(path) {
    return this.request(this.storagePath(path), {
      method: 'DELETE',
      expectJson: false
    });
  }

  async health() {
    try {
      await this.request(this.q('users', { select: 'id', limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}
