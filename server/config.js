import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.cwd());
const PUBLIC_DIR = path.join(ROOT, 'public');

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const port = Number(process.env.PORT || 3000);
const appOrigin = (
  process.env.APP_ORIGIN ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${port}`
).replace(/\/+$/, '');
const isHttps = appOrigin.startsWith('https://');

const bool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
};

const int = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function hashTree(dir, hash) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hash.update(`d:${path.relative(ROOT, full)}\n`);
      hashTree(full, hash);
    } else if (entry.isFile()) {
      hash.update(`f:${path.relative(ROOT, full)}\n`);
      hash.update(fs.readFileSync(full));
      hash.update('\n');
    }
  }
}

function computeBuildTag() {
  if (process.env.BUILD_TAG) return process.env.BUILD_TAG;
  const hash = crypto.createHash('sha256');
  hashTree(path.join(ROOT, 'server'), hash);
  hashTree(path.join(ROOT, 'public'), hash);
  return hash.digest('hex').slice(0, 12);
}

export const config = {
  root: ROOT,
  publicDir: PUBLIC_DIR,
  port,
  appOrigin,
  isHttps,
  buildTag: computeBuildTag(),
  nodeEnv: process.env.NODE_ENV || 'development',
  storeDriver: 'supabase',
  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    bucket: process.env.SUPABASE_MEDIA_BUCKET || 'duet-media'
  },
  sessionSecret: process.env.SESSION_SECRET || 'duet-dev-session-secret-change-me',
  sessionCookie: isHttps ? '__Host-duet_session' : 'duet_session',
  sessionDays: int(process.env.SESSION_DAYS, 30),
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:ops@example.com'
  },
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
  maxJsonBytes: int(process.env.MAX_JSON_KB, 4096) * 1024,
  diagnostics: bool(process.env.DIAGNOSTICS_ENABLED, true)
};

export function assertConfig() {
  if (!config.supabase.url || !config.supabase.key) {
    throw new Error('Duet requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Apply supabase/schema.sql first.');
  }
  if (config.nodeEnv === 'production' && !config.isHttps) {
    throw new Error('APP_ORIGIN must be the public https:// Render URL.');
  }
  if (config.nodeEnv === 'production' && config.sessionSecret === 'duet-dev-session-secret-change-me') {
    throw new Error('Set a strong SESSION_SECRET in production.');
  }
}