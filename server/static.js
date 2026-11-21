import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

const compressedCache = new Map();

export function applySecurityHeaders(res) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ];
  if (config.isHttps) csp.push('upgrade-insecure-requests');

  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (config.isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function cacheControlFor(urlPath) {
  if (urlPath === '/sw.js' || urlPath === '/index.html' || urlPath === '/manifest.webmanifest') {
    return 'no-cache';
  }
  if (urlPath.startsWith('/vendor/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (/\.[a-f0-9]{8,}\./i.test(urlPath)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

async function readAndMaybeCompress(filePath, stat, req) {
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const cacheableType = /^(text\/|application\/(json|manifest|javascript))/.test(type);
  if (!acceptsGzip || !cacheableType || stat.size < 1024) {
    return { body: await fs.readFile(filePath), encoding: null };
  }
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  let cached = compressedCache.get(key);
  if (!cached) {
    const raw = await fs.readFile(filePath);
    cached = zlib.gzipSync(raw, { level: 8 });
    compressedCache.set(key, cached);
    if (compressedCache.size > 120) {
      const first = compressedCache.keys().next().value;
      compressedCache.delete(first);
    }
  }
  return { body: cached, encoding: 'gzip' };
}

async function sendFile(req, res, filePath, { spa = false } = {}) {
  let stat;
  try {
    stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    if (!spa) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return;
    }
    filePath = path.join(config.publicDir, 'index.html');
    stat = await fs.stat(filePath);
  }

  const urlPath = '/'.concat(path.relative(config.publicDir, filePath).split(path.sep).join('/'));
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': cacheControlFor(urlPath)
    });
    res.end();
    return;
  }

  const { body, encoding } = await readAndMaybeCompress(filePath, stat, req);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': cacheControlFor(urlPath),
    ETag: etag,
    Vary: 'Accept-Encoding'
  };
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

export async function serveStatic(req, res, url) {
  applySecurityHeaders(res);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/' || pathname === '' ||
      pathname === '/index.html' || pathname === '/tests' || pathname === '/tests.html' ||
      pathname.startsWith('/invite/') || pathname.startsWith('/c/')) {
    const file = pathname === '/tests' || pathname === '/tests.html'
      ? path.join(config.publicDir, 'tests.html')
      : path.join(config.publicDir, 'index.html');
    await sendFile(req, res, file);
    return;
  }

  // The service worker's cache name follows the build tag (a hash of every
  // server and public file), so each GitHub push -> Render deploy gives
  // browsers a fresh cache automatically. No manual version bump needed.
  if (pathname === '/sw.js') {
    try {
      const source = await fs.readFile(path.join(config.publicDir, 'sw.js'), 'utf8');
      const body = Buffer.from(source.replace(
        /const VERSION = '[^']*';/,
        `const VERSION = 'duet-${config.buildTag}';`
      ));
      res.writeHead(200, {
        'Content-Type': MIME['.js'],
        'Content-Length': body.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
    return;
  }

  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(config.publicDir, safe);
  if (!full.startsWith(config.publicDir + path.sep) && full !== config.publicDir) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  // Extension-less paths are SPA routes, not files.
  if (!path.extname(safe)) {
    await sendFile(req, res, path.join(config.publicDir, 'index.html'));
    return;
  }
  await sendFile(req, res, full, { spa: false });
}

export async function serveMediaResponse(res, response) {
  applySecurityHeaders(res);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  };
  const length = response.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    res.end();
  }
}
