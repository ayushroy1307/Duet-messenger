import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(data);
}

export function fail(res, status, code, message, extra = {}) {
  json(res, status, { error: message, code, ...extra });
}

export function httpError(status, code, message, extra = {}) {
  return new HttpError(status, code, message, extra);
}

export async function readBody(req, limit = config.maxJsonBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = httpError(413, 'payload_too_large', 'That payload is too large.');
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = config.maxJsonBytes) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw httpError(415, 'json_required', 'Expected a JSON request body.');
  }
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw httpError(400, 'invalid_json', 'The request body was not valid JSON.');
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      out[key] = pair.slice(idx + 1).trim();
    }
  }
  return out;
}

export function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [
    `${config.sessionCookie}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (config.isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const parts = [
    `${config.sessionCookie}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (config.isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clientIp(req) {
  // Render (and most reverse proxies) append the real client address to any
  // inbound X-Forwarded-For value, so the last entry is the one the proxy saw.
  // Taking the first entry would let a caller forge an address and dodge
  // per-IP rate limits.
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = forwarded.length ? forwarded[forwarded.length - 1] : '';
  return candidate || req.socket?.remoteAddress || 'unknown';
}

export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    return parsed.origin === config.appOrigin || parsed.host === host;
  } catch {
    return false;
  }
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function validUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function cleanText(value, max = 80) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function encodeCursor(createdAt, id) {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx === -1) return null;
    const createdAt = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    if (!validUuid(id)) return null;
    // Only ISO-8601 characters: the value is embedded in a PostgREST `or=`
    // filter, so commas and parentheses must never get through.
    if (!/^[0-9T:.Z+-]{20,40}$/.test(createdAt)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clientUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? null,
    avatarColor: Number(row.avatar_color ?? 0),
    presenceVisible: row.presence_visible !== false,
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at ?? null
  };
}

export function peerUser(row) {
  if (!row) return null;
  const visible = row.presence_visible !== false;
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : null;
  return {
    id: row.id,
    displayName: row.display_name ?? null,
    avatarColor: Number(row.avatar_color ?? 0),
    presenceVisible: visible,
    lastSeenAt: visible ? row.last_seen_at ?? null : null,
    online: visible && row.presence_online === true &&
      lastSeen !== null && Date.now() - lastSeen < 65_000
  };
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}