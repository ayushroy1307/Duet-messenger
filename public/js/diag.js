import { api } from './api.js';

/**
 * Opt-in, content-free tracing. Ids and counters only.
 * The server applies its own allow-list as a second line of defence.
 */
const ALLOWED = new Set([
  'conversationId', 'messageId', 'generation', 'reason', 'count', 'peerId',
  'deviceId', 'pool', 'clientBuild', 'cached', 'online', 'durationMs', 'ok'
]);

const ring = [];
let enabled = false;
let build = 'client';
let flushing = false;

export const diag = {
  configure({ enabled: nextEnabled, build: nextBuild } = {}) {
    if (nextEnabled !== undefined) enabled = Boolean(nextEnabled);
    if (nextBuild) build = nextBuild;
  },
  get enabled() { return enabled; },
  get build() { return build; },
  event(name, fields = {}) {
    const clean = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED.has(key)) continue;
      if (typeof value === 'string') clean[key] = value.slice(0, 120);
      else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
      else if (typeof value === 'boolean') clean[key] = value;
    }
    const entry = { event: name, fields: clean, at: new Date().toISOString() };
    ring.push(entry);
    if (ring.length > 300) ring.splice(0, ring.length - 300);
    if (enabled) {
      console.debug(`[duet:${name}]`, clean);
      void diag.flush();
    }
  },
  snapshot() {
    return ring.map((item) => ({ ...item }));
  },
  async flush() {
    if (!enabled || flushing || !ring.length) return;
    flushing = true;
    const batch = ring.splice(0, 40);
    try {
      await api.diag(batch.map(({ event, fields }) => ({ event, fields })), build);
    } catch {
      // Keep events for the next attempt, but never grow without bound.
      ring.unshift(...batch);
      if (ring.length > 300) ring.splice(0, ring.length - 300);
    } finally {
      flushing = false;
    }
  }
};
