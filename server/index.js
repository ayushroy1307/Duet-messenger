import http from 'node:http';
import { config, assertConfig } from './config.js';
import { createStore } from './store.js';
import { handleApi, handleApiError } from './api.js';
import { serveStatic, applySecurityHeaders } from './static.js';
import { log } from './util.js';

assertConfig();

const store = await createStore();
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  let url;
  try {
    url = new URL(req.url || '/', config.appOrigin);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, store);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' })
        .end('Method not allowed');
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) {
      try { res.end(); } catch { /* already closed */ }
      log('Request failed after headers were sent', error?.message || String(error));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApiError(res, error);
    } else {
      log('Static request failed', error?.message || String(error));
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error');
    }
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000;

server.listen(config.port, '0.0.0.0', () => {
  log(`Duet ${config.buildTag} listening on :${config.port}`);
  log(`origin=${config.appOrigin} store=${config.storeDriver}`);
  store.health().then((ok) => {
    if (!ok) log('WARNING: Supabase health check failed. Apply supabase/schema.sql and check keys.');
    else log('Supabase reachable.');
  }).catch(() => log('WARNING: Supabase health check failed.'));
});

const cleanup = setInterval(() => {
  store.cleanupEvents().catch(() => {});
  store.cleanupSessions().catch(() => {});
}, 6 * 3600_000);
cleanup.unref();

async function shutdown(signal) {
  log(`Received ${signal}; shutting down.`);
  clearInterval(cleanup);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection', reason?.message || String(reason));
});
