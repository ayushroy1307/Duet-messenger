// Test harness: an in-memory relay that behaves like the real server's key/message rules.
import { Engine, MemoryDB } from '../public/js/engine.js';
import { Sealer } from '../public/js/vaultcore.js';
import { rand, randId } from '../public/js/util.js';

export class FakeServer {
  constructor() {
    this.bundles = {}; this.consumed = {}; this.messages = []; this.signals = []; this.clock = 1000; this.posts = 0;
    this.parts = {}; // convId -> [userA, userB]
  }
  wipeRegistry() { this.bundles = {}; this.consumed = {}; }
  peerOf(convId, me) { return this.parts[convId].find((u) => u !== me); }
  api(me) {
    const s = this;
    return {
      async publishKeys(b) {
        const cur = s.bundles[me];
        if (!cur || (b.identity && cur.identity.dh !== b.identity.dh)) {
          s.bundles[me] = { identity: b.identity, spk: b.spk, otks: [...(b.otks || [])] }; s.consumed[me] = [];
        } else { // merge, never overwrite (7.11)
          if (b.identity) cur.identity = b.identity;
          if (b.spk && b.spk.sig) cur.spk = b.spk;
          for (const o of b.otks || []) if (!s.consumed[me].includes(o.id) && !cur.otks.find((x) => x.id === o.id)) cur.otks.push(o);
        }
        return { otkRemaining: s.bundles[me].otks.length };
      },
      async getPeerBundle(convId) {
        const peer = s.peerOf(convId, me); const b = s.bundles[peer];
        if (!b) { const e = new Error('none'); e.code = 'peer-keys-unavailable'; throw e; }
        const otk = b.otks.shift() || null; if (otk) s.consumed[peer].push(otk.id);
        return { identity: b.identity, spk: b.spk, otk };
      },
      async requestRepair(convId, kind) { s.signals.push({ to: s.peerOf(convId, me), from: me, convId, kind }); },
      async postMessage(m) {
        s.posts++;
        const dup = s.messages.find((r) => r.conversationId === m.conversationId && r.clientId === m.clientId);
        if (dup) return dup;
        const row = { id: randId(8), senderId: me, createdAt: ++s.clock, deliveredAt: null, readAt: null, deletedAt: null, editedAt: null, ...m };
        s.messages.push(row); return row;
      },
      async fetchMessages(convId, { before, limit = 50 }) {
        let rows = s.messages.filter((r) => r.conversationId === convId).sort((a, b) => b.createdAt - a.createdAt);
        if (before) rows = rows.filter((r) => r.createdAt < before);
        const page = rows.slice(0, limit);
        return { messages: page, nextCursor: rows.length > limit ? page[page.length - 1].createdAt : null };
      },
      async uploadMedia(convId, blob) { const id = randId(8); s.parts[convId].media = s.parts[convId].media || {}; s.parts[convId].media[id] = blob; return { id }; },
      async downloadMedia(id) { for (const k of Object.keys(s.parts)) if (s.parts[k].media?.[id]) return s.parts[k].media[id]; throw new Error('404'); },
    };
  }
}

export async function makeClient(server, userId, convId, peerId, opts = {}) {
  const db = opts.db || new MemoryDB();
  const mk = opts.mk || rand(32);
  const events = [];
  const engine = new Engine({ selfId: userId, db, sealer: new Sealer(mk), api: server.api(userId), trace: (e, f) => events.push({ e, ...f }) });
  await engine.init();
  const conv = engine.conv(convId, peerId);
  await conv.load();
  return { engine, conv, db, mk, events, count: (name) => events.filter((x) => x.e === name).length };
}

export function newPair() {
  const server = new FakeServer();
  const convId = 'conv-1';
  server.parts[convId] = ['a-user', 'b-user']; // 'a-user' < 'b-user' => A is the initiator
  return { server, convId };
}

export async function decodeAll(conv, server) {
  await conv.catchUp();
  const rows = server.messages.filter((r) => r.conversationId === conv.convId).sort((a, b) => a.createdAt - b.createdAt);
  const out = [];
  for (const r of rows) out.push({ row: r, o: await conv.decodeRow(r) });
  return out;
}
export const texts = (decoded, fromId) => decoded.filter((d) => d.o.state === 'ok' && d.o.payload.t === 'text' && (!fromId || d.row.senderId === fromId)).map((d) => d.o.payload.body);
