// The unlocked app: chat list, chat view, sheets (settings / invite / start chat), realtime.
import { S, api, actions, refreshSettings } from './state.js';
import { h, btn, svg, iconBtn, field, clear, avatar, toast, openSheet, confirmSheet, showViewer, fmtClock, fmtDay, dayKey, fmtList, fmtLastSeen } from './ui.js';
import { COUNTRIES, flag, defaultCountry, toE164 } from './countries.js';
import { setSetting, getSettings, AUTOLOCK_OPTIONS } from './settings.js';
import { prepareImage, prepareVideo } from './media.js';
import { bioAvailable } from './bio.js';
import { BUILD } from './build.js';
import { Recorder, voiceSupported, fmtDur } from './voice.js';

let el = null;           // #app
let listEl = null, chatEl = null;
let C = null;            // open chat: { conv, ce, rows:Map, dec:Map, cursor, msgsEl, ... }
let es = null, esRetry = 0;
const EMOJI = '😀 😃 😄 😁 😆 😅 😂 🙂 😉 😊 😍 🥰 😘 😋 😎 🤗 🤔 😐 😴 😢 😭 😡 🥳 🤩 😇 🙃 😬 🙄 😮 🤝 👍 👎 👏 🙌 🙏 💪 👀 🎉 ✨ 🔥 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 ☀️ 🌙 ⭐ 🌈 🍕 ☕ 🎂 🎁 🏠 ✈️ 📷 🎵'.split(' ');

const REASONS = {
  'otk-missing': 'Sent before this device was re-paired.', superseded: 'Sent in an earlier pairing.', 'previous-pairing': 'Sent in an earlier pairing.',
  'handshake-rejected': 'Its security handshake was rejected.', 'own-unavailable': 'Sent from another device.', malformed: 'It arrived damaged.', 'decrypt-failed': 'It could not be decrypted.', internal: 'Something went wrong reading it.',
};

// ---------------------------------------------------------------- lifecycle
export function renderMain(container) {
  el = container;
  const shell = h('div', { class: 'shell' + (C ? ' has-chat' : '') });
  listEl = h('section', { class: 'pane-list', 'aria-label': 'Conversations' });
  chatEl = h('section', { class: 'pane-chat', 'aria-label': 'Conversation' }, h('div', { class: 'pane-empty' }, h('p', {}, 'Select a conversation')));
  shell.append(listEl, chatEl);
  el.append(shell);
  renderList();
  if (C) { const keep = C.conv; C = null; openChat(keep.id); }
}
export function startMain() { connectSse(); refreshAll(); }
export function stopMain() { if (es) { es.close(); es = null; } S.sseUp = false; cancelRec(); stopPlayer(); clearVoiceCache(); C = null; }

async function refreshAll() {
  try {
    const [c, r] = await Promise.all([api.conversations(), api.connections()]);
    S.convs = c.conversations; S.connections = r;
    try { await S.engine.sput('convcache', 'list', S.convs); } catch { /* cache is optional */ }
  } catch { const cached = await S.engine?.sget('convcache', 'list'); if (cached) S.convs = cached; }
  await redeemPendingInvite();
  renderList();
  for (const c of S.convs) { const ce = S.engine.conv(c.id, c.peer.id); ce.bootstrap().catch(() => {}); }
}
async function redeemPendingInvite() {
  if (!S.pendingInvite) return;
  const token = S.pendingInvite; S.pendingInvite = null; try { sessionStorage.removeItem('duet.invite'); } catch { /* ignore */ }
  try { const r = await api.redeemInvite(token); const c = await api.conversations(); S.convs = c.conversations; toast('Conversation created'); setTimeout(() => openChat(r.conversation.id), 0); }
  catch (x) { toast(x.message); }
}

// ----------------------------------------------------------------- realtime
function connectSse() {
  if (es) es.close();
  es = new EventSource('/api/realtime');
  es.addEventListener('hello', () => { S.sseUp = true; esRetry = 0; actions.trace('sse-open'); S.engine?.publish().catch(() => {}); refreshAll(); if (C) loadChat(true); updateBanner(); });
  es.onerror = async () => {
    S.sseUp = false; updateBanner(); actions.trace('sse-error');
    try { await api.me(); } catch (x) { if (x.status === 401) { es?.close(); return actions.sessionLost(); } }
    // EventSource reconnects by itself
  };
  const on = (name) => es.addEventListener(name, (e) => { let d = {}; try { d = JSON.parse(e.data); } catch { /* ignore */ } onSseEvent(name, d); });
  ['message', 'message-updated', 'receipt', 'presence', 'keys-updated', 'repair', 'session-request', 'conversation', 'connection'].forEach(on);
}

export async function onSseEvent(name, d) {
  if (S.phase !== 'unlocked' || !S.engine) return;
  try {
    if (name === 'online' || name === 'offline') { updateBanner(); if (name === 'online') { flushAll(); if (!S.sseUp) connectSse(); } return; }
    if (name === 'resume') { flushAll(); if (C) loadChat(true); return; }
    if (name === 'conversation') return refreshAll();
    if (name === 'connection') { S.connections = await api.connections(); return renderList(); }
    if (name === 'repair') return void S.engine.publish();
    if (name === 'keys-updated') { for (const c of S.convs) { const ce = S.engine.conv(c.id, c.peer.id); if (['waiting-peer-keys', 'registry-lost', 'error'].includes(ce.status)) ce.bootstrap(); } return; }
    if (name === 'session-request') { const c = S.convs.find((x) => x.id === d.conversationId); if (c) await S.engine.conv(c.id, c.peer.id).onSessionRequest(); return; }
    if (name === 'presence') { for (const c of S.convs) if (c.peer.id === d.userId) { c.peer.online = d.online; c.peer.lastSeen = d.lastSeen; } renderList(); if (C && C.conv.peer.id === d.userId) { C.conv.peer.online = d.online; C.conv.peer.lastSeen = d.lastSeen; renderHead(); } return; }
    if (name === 'receipt') {
      const c = S.convs.find((x) => x.id === d.conversationId); if (!c) return;
      await S.engine.conv(c.id, c.peer.id).onReceipt(d.clientIds || []);
      if (C && C.conv.id === d.conversationId) for (const id of d.ids) { const r = C.rows.get(id); if (r) { r.deliveredAt = r.deliveredAt || d.at; if (d.kind === 'read') r.readAt = d.at; } }
      return C && renderMsgs();
    }
    if (name === 'message-updated') { if (C && C.conv.id === d.conversationId) { C.rows.set(d.id, d); await decodeInto(d); renderMsgs(); } return refreshList(); }
    if (name === 'message') await onIncoming(d);
  } catch (e) { actions.trace('decode-error', { code: e.code || 'event' }); }
}

async function onIncoming(row) {
  const c = S.convs.find((x) => x.id === row.conversationId) || (await refreshAll(), S.convs.find((x) => x.id === row.conversationId));
  if (!c) return;
  const ce = S.engine.conv(c.id, c.peer.id);
  await ce.load(); await ce.catchUp(); // decode oldest → newest, adopting any handshake first (7.6)
  const open = C && C.conv.id === c.id;
  if (open) { C.rows.set(row.id, row); await decodeInto(row); renderMsgs(true); await markRead(); }
  else api.postReceipt(c.id, row.id, 'delivered').catch(() => {});
  await refreshList();
  if (document.hidden && S.settings.notifications && 'Notification' in window && Notification.permission === 'granted' && row.type !== 'ctl' && row.type !== 'edit') {
    const o = await ce._loadOutcome(row.id); const body = S.settings.hidePreviews || o?.state !== 'ok' ? 'New message' : o.payload.t === 'text' ? o.payload.body.slice(0, 80) : o.payload.t === 'image' ? 'Photo' : o.payload.t === 'audio' ? 'Voice message' : 'Video';
    try { new Notification(c.peer.displayName, { body, icon: '/icons/icon-192.png', tag: c.id }); } catch { /* not allowed here */ }
  }
}
async function refreshList() { try { S.convs = (await api.conversations()).conversations; } catch { /* offline */ } renderList(); }
function flushAll() { for (const c of S.convs) S.engine.conv(c.id, c.peer.id).flush().catch(() => {}); }

// ---------------------------------------------------------------- list pane
function banner() { return !S.online ? 'You are offline. Showing saved messages; new ones will send when you reconnect.' : !S.sseUp ? 'Reconnecting…' : null; }
function updateBanner() { const b = document.querySelector('.banner'); const t = banner(); if (!b && t) renderList(); else if (b && !t) renderList(); else if (b) b.lastChild.textContent = t; }

async function previewFor(c) {
  const lm = c.lastMessage; if (!lm) return 'No messages yet';
  if (S.settings.hidePreviews) return 'Encrypted message';
  if (lm.deleted) return 'Message deleted';
  const o = await S.engine.conv(c.id, c.peer.id)._loadOutcome(lm.id);
  if (!o || o.state !== 'ok') return o ? 'Message not readable' : 'Encrypted message';
  const mine = lm.senderId === S.user.id ? 'You: ' : '';
  return mine + (o.payload.t === 'text' ? o.payload.body : o.payload.t === 'image' ? 'Photo' : o.payload.t === 'audio' ? 'Voice message' : 'Video');
}

async function renderList() {
  if (!listEl) return;
  const top = h('div', { class: 'topbar' }, h('h1', { class: 'title' }, 'Duet'), h('span', { class: 'spacer' }),
    iconBtn('lock', 'Lock', () => actions.lock('manual')), iconBtn('sliders', 'Settings', openSettings));
  const list = h('div', { class: 'list' });
  const b = banner();
  const inc = S.connections.incoming || [];
  const parts = [top, b ? h('div', { class: 'banner' }, h('span', {}, b)) : null,
    h('div', { class: 'actions' }, btn('Invite someone', { kind: 'primary', small: true, onClick: openInvite }), btn('Start with a number', { small: true, onClick: openStartChat })),
    ...inc.map((r) => h('div', { class: 'reqs' }, avatar({ displayName: r.name, avatar: r.avatar }, 'sm'), h('div', { class: 'grow' }, h('b', {}, r.name || r.maskedPhone), ' wants to chat'),
      btn('Accept', { small: true, kind: 'primary', onClick: async () => { try { const x = await api.respondConnection(r.id, true); await refreshAll(); openChat(x.conversation.id); } catch (e) { toast(e.message); } } }),
      btn('Decline', { small: true, kind: 'quiet', onClick: async () => { await api.respondConnection(r.id, false).catch(() => {}); S.connections = await api.connections().catch(() => S.connections); renderList(); } }))),
    list];
  if (!S.convs.length) list.append(h('div', { class: 'empty' }, h('h2', {}, 'Your private line'), h('p', { class: 'muted' }, 'Duet is for exactly two people. Share an invite link, or start with their phone number.'), (S.connections.outgoing || []).length ? h('p', { class: 'small muted' }, `Waiting for ${(S.connections.outgoing || []).length} request(s) to be accepted.`) : null));
  const previews = await Promise.all(S.convs.map(previewFor));
  S.convs.forEach((c, i) => {
    list.append(h('button', { class: 'conv', 'aria-current': C?.conv.id === c.id ? 'true' : null, on: { click: () => openChat(c.id) } },
      avatar(c.peer, '', c.peer.online),
      h('div', { class: 'grow' }, h('div', { class: 'top' }, h('span', { class: 'name' }, c.peer.displayName), h('span', { class: 'time' }, fmtList(c.lastMessage?.createdAt))),
        h('div', { class: 'top' }, h('span', { class: 'preview grow' }, previews[i]), c.unread ? h('span', { class: 'badge', 'aria-label': `${c.unread} unread` }, c.unread > 99 ? '99+' : c.unread) : null))));
  });
  clear(listEl).append(...parts.filter(Boolean));
}

// ----------------------------------------------------------------- chat pane
function statusNotice(ce, peer) {
  const m = {
    'waiting-peer-keys': [`${peer} hasn't opened Duet on a device yet, so encryption keys aren't available.`, 'Messages will be sent securely as soon as they do.'],
    'registry-lost': ['The server no longer has this contact\'s encryption keys (it was reset).', 'This is a server problem, not your contact. We have asked their device to republish; it happens when they next open Duet.'],
    'waiting-handshake': [`Waiting for ${peer}'s device to start the secure session.`, 'We have asked it to. This usually takes seconds once they are online.'],
    'setting-up': ['Setting up end-to-end encryption…', ''],
    error: ['Encryption could not be set up with this contact.', 'Their key bundle failed verification. Tap "Re-pair" to try again.'],
  }[ce.status];
  return m || null;
}

export async function openChat(convId) {
  const conv = S.convs.find((c) => c.id === convId); if (!conv) return;
  const ce = S.engine.conv(conv.id, conv.peer.id);
  cancelRec(); stopPlayer(); clearVoiceCache();
  C = { conv, ce, rows: new Map(), dec: new Map(), cursor: null, lastRead: null, emojiOpen: false, ctx: null, loading: false };
  document.querySelector('.shell')?.classList.add('has-chat');
  buildChatPane(); renderList();
  ce.on((ev) => { if (!C || C.ce !== ce) return; if (ev.kind === 'status' || ev.kind === 'session') { renderBanner(); renderComposerState(); } if (ev.kind === 'sent' && ev.row) { C.rows.set(ev.row.id, ev.row); decodeInto(ev.row).then(() => renderMsgs(true)); return; } // posted: becomes a real row, never vanishes
    if (ev.kind === 'outbox' || ev.kind === 'send-failed') renderMsgs(true); });
  await loadChat(false);
}

function buildChatPane() {
  const msgs = h('div', { class: 'msgs', role: 'log', 'aria-label': 'Messages' });
  const head = h('div', { class: 'chat-head' });
  const sec = h('div', {}); const ctx = h('div', {}); const emoji = h('div', {});
  const ta = h('textarea', { rows: 1, placeholder: 'Message…', 'aria-label': 'Message', maxLength: 4000, enterKeyHint: 'send' });
  const file = h('input', { type: 'file', accept: 'image/*,video/*', class: 'sr', tabIndex: -1, on: { change: () => attach(file) } });
  const sendB = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send', title: 'Send', hidden: true, on: { click: sendText } }, svg('send', 19));
  const micB = h('button', { class: 'pill-btn', type: 'button', 'aria-label': 'Record voice message', title: 'Record voice message', hidden: !voiceSupported(), on: { click: startRec } }, svg('mic', 22));
  const attachB = h('button', { class: 'cam-btn', type: 'button', 'aria-label': 'Attach photo or video', title: 'Photo or video', on: { click: () => file.click() } }, svg('camera', 22));
  const emojiB = h('button', { class: 'pill-btn', type: 'button', 'aria-label': 'Emoji', title: 'Emoji', on: { click: () => { C.emojiOpen = !C.emojiOpen; renderEmoji(); } } }, svg('smile', 22));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover)').matches) { e.preventDefault(); sendText(); } });
  const sync = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; const has = !!ta.value.trim(); sendB.hidden = !has; micB.hidden = has || !voiceSupported(); };
  ta.addEventListener('input', sync);
  const normalRow = h('div', { class: 'composer-row' }, attachB, h('div', { class: 'pill' }, ta, emojiB, micB, sendB));
  const recTime = h('span', { class: 'rec-time', role: 'timer', 'aria-label': 'Recording time' }, '0:00'); const recLevels = h('div', { class: 'rec-levels', 'aria-hidden': 'true' });
  const recRow = h('div', { class: 'composer-row rec-row', hidden: true },
    iconBtn('trash', 'Cancel recording', () => finishRec(false)), h('div', { class: 'rec-pill', role: 'status' }, h('span', { class: 'rec-dot' }), recTime, recLevels),
    h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Send voice message', title: 'Send voice message', on: { click: () => finishRec(true) } }, svg('send', 20)));
  const composer = h('div', { class: 'composer' }, ctx, emoji, normalRow, recRow, file);
  Object.assign(C, { msgsEl: msgs, headEl: head, secEl: sec, ctxEl: ctx, emojiEl: emoji, ta, sendB, micB, attachB, emojiB, syncSend: sync, normalRow, recRow, recTime, recLevels });
  clear(chatEl).append(head, sec, msgs, composer);
  renderHead(); renderBanner(); renderComposerState();
  msgs.addEventListener('scroll', () => { C.atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80; }, { passive: true });
  C.atBottom = true;
}

// ---- voice messages: record, encrypt like any attachment, send
async function startRec() {
  if (!C || C.rec) return; if (!C.ce.ready) return toast('Secure session is not ready yet');
  const mine = C;
  const rec = new Recorder({
    onTick: (ms, lv) => {
      if (C !== mine || !mine.rec) return;
      mine.recTime.textContent = fmtDur(ms / 1000);
      mine.recLevels.append(h('i', { style: { height: Math.max(10, Math.round(lv * 100)) + '%' } }));
      while (mine.recLevels.childElementCount > 40) mine.recLevels.firstChild.remove();
    },
    onLimit: () => { toast('5 minute limit reached'); finishRec(true); },
  });
  try { await rec.start(); } catch (e) {
    return toast(e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'Microphone access is blocked. Allow it in your browser’s site settings.' : e.name === 'NotFoundError' ? 'No microphone was found.' : 'Could not start recording.');
  }
  if (C !== mine) { rec.cancel(); return; }
  mine.rec = rec; mine.recTime.textContent = '0:00'; clear(mine.recLevels); mine.normalRow.hidden = true; mine.recRow.hidden = false;
}
async function finishRec(send) {
  const mine = C; const rec = mine?.rec; if (!rec) return;
  mine.rec = null; mine.recRow.hidden = true; mine.normalRow.hidden = false;
  if (!send) return void rec.cancel();
  try {
    const r = await rec.stop();
    if (r.duration < 0.6) return toast('That voice message was too short.');
    await mine.ce.sendMedia({ kind: 'audio', bytes: r.bytes, mime: r.mime, name: 'voice-message', duration: r.duration, wave: r.wave });
    mine.atBottom = true; mine.ce.flush();
  } catch (e) { toast(e.code === 'not-ready' ? 'Secure session is not ready yet' : 'Could not send the voice message.'); }
}
function cancelRec() { if (C?.rec) { C.rec.cancel(); C.rec = null; } }

// ---- voice playback: one at a time; the bubble UI is repainted from this state after every re-render
const player = { id: null, audio: null, loading: false, urls: new Map(), token: 0 };
function stopPlayer() { player.token++; if (player.audio) { player.audio.pause(); player.audio = null; } player.id = null; player.loading = false; updateVoiceUi(); }
function clearVoiceCache() { for (const u of player.urls.values()) URL.revokeObjectURL(u); player.urls.clear(); }
async function togglePlay(p) {
  if (player.id === p.mediaId && player.audio) { if (player.audio.paused) player.audio.play().catch(() => {}); else player.audio.pause(); return; }
  stopPlayer(); const token = player.token; player.id = p.mediaId; player.loading = true; updateVoiceUi();
  try {
    let url = player.urls.get(p.mediaId);
    if (!url) { const bytes = await C.ce.openMedia(p); url = URL.createObjectURL(new Blob([bytes], { type: p.mime || 'audio/webm' })); player.urls.set(p.mediaId, url); }
    if (token !== player.token) return;
    const a = new Audio(url); player.audio = a; player.loading = false;
    for (const ev of ['play', 'pause', 'timeupdate', 'ended']) a.addEventListener(ev, () => { if (player.audio !== a) return; if (ev === 'ended') { player.audio = null; player.id = null; } updateVoiceUi(a); });
    await a.play();
  } catch { if (token === player.token) { stopPlayer(); toast('This voice message could not be played.'); } }
}
function updateVoiceUi() {
  for (const el of document.querySelectorAll('.voice')) {
    const mine = el.dataset.mid === player.id; const a = mine ? player.audio : null;
    const total = Number(el.dataset.dur) || 0; const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : total;
    const prog = a && dur ? Math.min(1, a.currentTime / dur) : 0;
    el.classList.toggle('playing', !!a && !a.paused); el.classList.toggle('loading', mine && player.loading);
    const bars = el.querySelectorAll('.vbars i'); const upto = Math.round(prog * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < upto));
    el.querySelector('.vdur').textContent = fmtDur(a && !a.paused ? a.currentTime : total);
    el.querySelector('.vplay').setAttribute('aria-label', a && !a.paused ? 'Pause voice message' : 'Play voice message');
  }
}
function audioNode(p) {
  const wave = p.wave && p.wave.length ? p.wave : Array.from({ length: 40 }, (_, i) => 25 + ((i * 37) % 55));
  return h('div', { class: 'voice', dataset: { mid: p.mediaId, dur: p.duration || 0 } },
    h('button', { type: 'button', class: 'vplay', 'aria-label': 'Play voice message', on: { click: (e) => { e.stopPropagation(); togglePlay(p); } } }, h('span', { class: 'pl' }, svg('play', 18)), h('span', { class: 'pa' }, svg('pause', 18))),
    h('div', { class: 'vbars', 'aria-hidden': 'true' }, wave.map((v) => h('i', { style: { height: Math.max(12, Math.min(100, v)) + '%' } }))),
    h('span', { class: 'vdur' }, fmtDur(p.duration || 0)));
}

function renderHead() {
  if (!C) return; const p = C.conv.peer;
  const sub = p.online === null ? '' : p.online ? 'Active now' : fmtLastSeen(p.lastSeen);
  clear(C.headEl).append(iconBtn('back', 'Back', closeChat, 'back-btn'),
    avatar(p, 'sm', p.online), h('div', { class: 'who' }, h('div', { class: 'nm' }, p.displayName), h('div', { class: 'sub' }, sub)),
    iconBtn('shield', 'Security', openSecurity));
}
function closeChat() { cancelRec(); stopPlayer(); clearVoiceCache(); C = null; document.querySelector('.shell')?.classList.remove('has-chat'); clear(chatEl).append(h('div', { class: 'pane-empty' }, h('p', {}, 'Select a conversation'))); renderList(); }

function renderBanner() {
  if (!C) return; const ce = C.ce; const n = statusNotice(ce, C.conv.peer.displayName);
  const bits = [];
  if (n) bits.push(h('div', { class: 'secbar' }, h('div', { class: 'grow' }, h('div', {}, n[0]), n[1] ? h('div', { class: 'small muted' }, n[1]) : null), ce.status === 'error' ? btn('Re-pair', { small: true, onClick: () => ce.repair() }) : null));
  if (ce.meta.identityChanged) bits.push(h('div', { class: 'secbar' }, h('div', { class: 'grow' }, `${C.conv.peer.displayName}'s security code changed (new phone or reinstall). Compare it in person if this was unexpected.`), btn('Dismiss', { small: true, kind: 'quiet', onClick: () => { ce.meta.identityChanged = false; ce.persist.mark(); renderBanner(); } })));
  clear(C.secEl).append(...bits);
}
function renderComposerState() {
  if (!C) return; const can = C.ce.ready;
  C.ta.disabled = !can; C.sendB.disabled = !can; C.attachB.disabled = !can; C.emojiB.disabled = !can; C.micB.disabled = !can; C.micB.disabled = !can;
  C.ta.placeholder = can ? 'Message…' : 'Waiting for a secure session…';
}
function renderEmoji() {
  clear(C.emojiEl); if (!C.emojiOpen) return;
  C.emojiEl.append(h('div', { class: 'emoji-grid', role: 'group', 'aria-label': 'Emoji' }, EMOJI.map((e) => h('button', { type: 'button', 'aria-label': e, on: { click: () => { const t = C.ta; const s = t.selectionStart ?? t.value.length; t.setRangeText(e, s, t.selectionEnd ?? s, 'end'); t.focus(); C.syncSend(); } } }, e))));
}

async function decodeInto(row) { C.dec.set(row.id, await C.ce.decodeRow(row)); }
const ts = (r) => r.createdAt;

async function loadChat(refreshOnly) {
  if (!C) return; const mine = C; if (mine.loading) return; mine.loading = true;
  try {
    await mine.ce.bootstrap();
    let page;
    try {
      await mine.ce.catchUp();
      page = await api.fetchMessages(mine.conv.id, { limit: 30 });
      try { await S.engine.sput('rowcache', mine.conv.id, page.messages.slice(0, 50)); } catch { /* ignore */ }
    } catch {
      const cached = (await S.engine.sget('rowcache', mine.conv.id)) || []; // offline: sealed read-only copy
      page = { messages: cached, nextCursor: null }; mine.offlineView = true;
    }
    if (C !== mine) return;
    for (const r of page.messages) mine.rows.set(r.id, r);
    if (!refreshOnly || mine.cursor === null) mine.cursor = page.nextCursor;
    for (const r of [...mine.rows.values()].sort((a, b) => ts(a) - ts(b))) await decodeInto(r);
    for (const r of mine.rows.values()) if (r.senderId === S.user.id && r.deliveredAt) mine.ce.onReceipt([r.clientId]);
    renderBanner(); renderComposerState(); renderMsgs(true); await markRead();
    mine.ce.flush();
  } finally { mine.loading = false; }
}
async function loadOlder() {
  if (!C || !C.cursor) return; const mine = C;
  try { const page = await api.fetchMessages(mine.conv.id, { before: mine.cursor, limit: 30 }); mine.cursor = page.nextCursor; for (const r of page.messages) mine.rows.set(r.id, r); for (const r of page.messages.slice().reverse()) await decodeInto(r); const h0 = mine.msgsEl.scrollHeight; renderMsgs(false); mine.msgsEl.scrollTop += mine.msgsEl.scrollHeight - h0; } catch { toast('Could not load earlier messages'); }
}
async function markRead() {
  if (!C || document.hidden) return;
  const peerRows = [...C.rows.values()].filter((r) => r.senderId !== S.user.id).sort((a, b) => ts(a) - ts(b)); const last = peerRows[peerRows.length - 1];
  if (!last || C.lastRead === last.id) return;
  C.lastRead = last.id;
  try { await api.postReceipt(C.conv.id, last.id, 'read'); const c = S.convs.find((x) => x.id === C.conv.id); if (c) { c.unread = 0; renderList(); } } catch { C.lastRead = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && C) markRead(); });

// ---------------------------------------------------------------- messages
function statusIcon(row, pending) {
  const k = pending ? 'sending' : row.readAt ? 'read' : row.deliveredAt ? 'delivered' : 'sent';
  const label = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read' }[k];
  return h('span', { class: `ds ds-${k}`, role: 'img', 'aria-label': label, title: label }, svg(k === 'sent' || k === 'sending' ? 'check' : 'check2', 14));
}
function snippet(p) { return !p ? '' : p.t === 'text' ? p.body.slice(0, 90) : p.t === 'image' ? 'Photo' : p.t === 'audio' ? 'Voice message' : 'Video'; }
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]*\s*){1,5}$/u;
const GROUP_MS = 5 * 60e3, SEP_MS = 30 * 60e3;

function renderMsgs(stick) {
  if (!C) return; const mine = C; const wasBottom = mine.atBottom;
  const rows = [...mine.rows.values()].sort((a, b) => ts(a) - ts(b) || (a.id < b.id ? -1 : 1));
  const edits = new Map();
  for (const r of rows) { const o = mine.dec.get(r.id); if (r.type === 'edit' && o?.state === 'ok' && !r.deletedAt) edits.set(r.senderId + ':' + o.payload.ref, o.payload.body); }
  const seen = new Set(rows.map((r) => r.clientId)); const pending = mine.pending || [];
  // 1. classify every row into a note (system line), a message, or nothing
  const list = [];
  const add = (r, o, isPending) => {
    const own = r.senderId === S.user.id, when = r.createdAt;
    if (r.deletedAt) return list.push({ note: own ? 'You deleted this message' : 'This message was deleted', when });
    if (!o) return list.push({ note: 'Opening…', when });
    if (o.state === 'pending') return list.push({ note: 'Waiting for the secure session to start…', when });
    if (o.state === 'dead') return list.push({ note: 'No longer readable. ' + (REASONS[o.reason] || ''), when });
    if (o.state === 'failed') return list.push({ note: "This message couldn't be decrypted. " + (REASONS[o.reason] || ''), when });
    const p = o.payload; if (!p || p.t === 'ctl' || p.t === 'edit') return;
    list.push({ r, p, own, when, isPending, edited: edits.get(r.senderId + ':' + r.clientId) });
  };
  for (const r of rows) add(r, mine.dec.get(r.id), false);
  for (const it of pending) if (!seen.has(it.clientId) && it.payload && it.payload.t !== 'ctl' && it.payload.t !== 'edit') add({ id: it.clientId, clientId: it.clientId, senderId: S.user.id, createdAt: it.createdAt }, { state: 'ok', payload: it.payload }, true);
  // 2. group neighbours: same sender, close in time, no separator between them
  const sepBefore = (i) => i === 0 || dayKey(list[i].when) !== dayKey(list[i - 1].when) || list[i].when - list[i - 1].when > SEP_MS;
  const joined = (i, j) => list[i].p && list[j].p && list[i].own === list[j].own && !sepBefore(j) && list[j].when - list[i].when < GROUP_MS;
  const nodes = [];
  if (mine.cursor) nodes.push(h('button', { class: 'btn btn-sm more', on: { click: loadOlder } }, 'Load earlier messages'));
  list.forEach((it, i) => {
    if (sepBefore(i)) nodes.push(h('div', { class: 'day' }, `${fmtDay(it.when)} ${fmtClock(it.when)}`.toUpperCase()));
    if (it.note) return nodes.push(h('div', { class: 'muted-row' }, it.note));
    const first = !(i > 0 && joined(i - 1, i)), last = !(i < list.length - 1 && joined(i, i + 1));
    const text = it.edited ?? it.p.body; const emojiOnly = it.p.t === 'text' && !it.p.reply && EMOJI_ONLY.test(String(text).trim());
    const open = () => openMsgMenu(it.r, it.p, text);
    const body = it.p.t === 'text' ? [it.p.reply ? h('div', { class: 'quote' }, h('b', {}, it.p.reply.who), it.p.reply.snip) : null, text] : it.p.t === 'audio' ? audioNode(it.p) : mediaNode(it.p);
    const bubble = h('div', { class: 'bubble' + (it.p.t === 'audio' ? ' voice-bubble' : it.p.t !== 'text' ? ' media' : '') + (emojiOnly ? ' emoji-only' : ''), tabIndex: 0, role: 'button', 'aria-label': 'Message actions', on: { click: open, keydown: (e) => { if (e.key === 'Enter') open(); } } }, body);
    const meta = last ? h('div', { class: 'meta' }, fmtClock(it.when), it.r.editedAt || it.edited ? 'edited' : null, it.own ? statusIcon(it.r, it.isPending) : null) : null;
    const pos = first && last ? 'g-single' : first ? 'g-first' : last ? 'g-last' : 'g-mid';
    const col = h('div', { class: 'col' }, bubble, meta);
    const av = it.own ? null : last ? avatar(mine.conv.peer, 'xs') : h('span', { class: 'av-gap' });
    nodes.push(h('div', { class: `msg ${it.own ? 'own' : 'peer'} ${pos}` }, av, col));
  });
  clear(mine.msgsEl).append(...nodes); updateVoiceUi();
  if (stick || wasBottom) mine.msgsEl.scrollTop = mine.msgsEl.scrollHeight;
  mine.ce.pendingOutbox().then((p) => { const changed = p.length !== (mine.pending || []).length; mine.pending = p; if (changed && C === mine) renderMsgs(false); });
}

function mediaNode(p) {
  const wrap = h('button', { class: 'thumb-wrap', type: 'button', 'aria-label': p.t === 'image' ? 'Open photo' : 'Play video', on: { click: (e) => { e.stopPropagation(); openMedia(p); } } },
    h('img', { class: 'thumb', src: p.thumb || '', alt: p.t === 'image' ? 'Photo' : 'Video thumbnail', style: p.w && p.h ? { 'aspect-ratio': `${p.w} / ${p.h}` } : {} }),
    p.t === 'video' ? h('div', { class: 'play' }, svg('play', 30), p.duration ? `${Math.floor(p.duration / 60)}:${String(p.duration % 60).padStart(2, '0')}` : null) : null);
  return [wrap, p.caption ? h('div', { class: 'cap' }, p.caption) : null];
}
async function openMedia(p) {
  showViewer(async ({ bar, stage, close }) => {
    stage.append(h('p', { style: { color: '#fff' } }, 'Decrypting…'));
    try {
      const bytes = await C.ce.openMedia(p); const url = URL.createObjectURL(new Blob([bytes], { type: p.mime || 'application/octet-stream' }));
      clear(stage).append(p.t === 'video' ? h('video', { src: url, controls: true, autoplay: true, playsInline: true }) : h('img', { src: url, alt: 'Photo' }));
      bar.append(h('a', { class: 'btn', href: url, download: p.name || 'duet-media' }, h('span', { class: 'label' }, 'Save')));
      const old = close; bar.querySelector('button').addEventListener('click', () => URL.revokeObjectURL(url)); void old;
    } catch { clear(stage).append(h('p', { style: { color: '#fff' } }, 'This attachment could not be opened.')); }
  });
}

function openMsgMenu(row, p, text) {
  const own = row.senderId === S.user.id;
  openSheet('Message', (body, s) => {
    const item = (label, fn, kind) => body.append(btn(label, { kind, onClick: () => { s.close(); fn(); } }));
    item('Reply', () => { C.ctx = { cid: row.clientId, who: own ? 'You' : C.conv.peer.displayName, snip: snippet(p) }; renderCtx(); C.ta.focus(); });
    if (p.t === 'text') item('Copy text', async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Could not copy'); } });
    if (own && p.t === 'text' && !row.id.includes('pending')) item('Edit', () => { C.ctx = { edit: row.clientId, snip: text }; C.ta.value = text; C.syncSend(); renderCtx(); C.ta.focus(); });
    if (own) item('Delete', async () => { if (S.settings.confirmDelete && !(await confirmSheet('Delete message?', 'It will be removed for both of you. This cannot be undone.', 'Delete', { danger: true }))) return; try { await api.deleteMessage(row.id); row.deletedAt = Date.now(); renderMsgs(false); refreshList(); } catch (x) { toast(x.message); } }, 'danger');
  });
}
function renderCtx() {
  clear(C.ctxEl); if (!C.ctx) return;
  C.ctxEl.append(h('div', { class: 'ctx' }, h('div', { class: 'grow' }, h('b', {}, C.ctx.edit ? 'Editing message' : `Replying to ${C.ctx.who}`), h('div', { class: 'small muted' }, C.ctx.snip)),
    btn('Cancel', { small: true, kind: 'quiet', onClick: () => { if (C.ctx.edit) { C.ta.value = ''; C.syncSend(); } C.ctx = null; renderCtx(); } })));
}

async function sendText() {
  if (!C || !C.ce.ready) return; const text = C.ta.value.trim(); if (!text) return;
  const ctx = C.ctx; C.ta.value = ''; C.syncSend(); C.ctx = null; renderCtx(); C.emojiOpen = false; renderEmoji();
  try {
    if (ctx?.edit) await C.ce.send({ t: 'edit', ref: ctx.edit, body: text }, { type: 'edit', editsClientId: ctx.edit });
    else await C.ce.send({ t: 'text', body: text, ...(ctx?.cid ? { reply: ctx } : {}) });
    C.atBottom = true;
  } catch (x) { C.ta.value = text; toast(x.code === 'not-ready' ? 'Secure session is not ready yet' : x.message); }
}
async function attach(input) {
  const f = input.files[0]; input.value = ''; if (!f || !C) return;
  try {
    toast('Encrypting…');
    const m = f.type.startsWith('video/') ? await prepareVideo(f) : await prepareImage(f);
    await C.ce.sendMedia(m); C.atBottom = true; C.ce.flush();
  } catch (x) { toast(x.code === 'not-ready' ? 'Secure session is not ready yet' : x.message || 'Could not send that file'); }
}

// ------------------------------------------------------------------ sheets
async function openSecurity() {
  const sn = await C.ce.safetyNumber();
  openSheet('Security', (body) => {
    body.append(h('div', { class: 'notice' }, 'Messages with ', h('b', {}, C.conv.peer.displayName), ' are end-to-end encrypted. Not even the server can read them.'));
    if (sn) body.append(h('div', { class: 'sec-title' }, 'Safety number'), h('div', { class: 'sn' }, sn), h('p', { class: 'small muted' }, 'If this matches on both phones, nobody is in the middle. Compare it in person or over a call.'));
    else body.append(h('p', { class: 'muted' }, 'A safety number appears once the secure session is established.'));
    body.append(h('p', { class: 'small muted' }, `Session: ${C.ce.status}${C.ce.session ? ' · ' + (C.ce.session.role) : ''}`), btn('Re-pair this conversation', { block: true, onClick: async () => { await C.ce.repair(); toast('Asked to re-pair'); } }));
  });
}

function openInvite() {
  openSheet('Invite someone', async (body) => {
    body.append(h('p', { class: 'muted' }, 'Share this single-use link in any way you like. When they open it and sign in, your private conversation is created. Neither of you sees the other\'s phone number.'));
    const out = h('div', {}, h('p', { class: 'muted' }, 'Creating link…')); body.append(out);
    try {
      const r = await api.createInvite();
      clear(out).append(h('div', { class: 'code-box' }, r.url), h('div', { class: 'row-flex', style: { 'margin-top': '10px' } },
        btn('Copy link', { kind: 'primary', block: true, onClick: async () => { try { await navigator.clipboard.writeText(r.url); toast('Link copied'); } catch { toast('Select the link and copy it'); } } }),
        navigator.share ? btn('Share…', { block: true, onClick: () => navigator.share({ title: 'Duet', text: 'Chat with me privately on Duet', url: r.url }).catch(() => {}) }) : null),
        h('p', { class: 'small muted' }, 'Expires in 7 days. Works once.'));
    } catch (x) { clear(out).append(h('p', { class: 'err' }, x.message)); }
  });
}

function openStartChat() {
  openSheet('Start with a number', (body, s) => {
    const sel = h('select', { class: 'input', 'aria-label': 'Country' }, COUNTRIES.map((c) => h('option', { value: c[0] }, `${flag(c[0])} ${c[1]} (+${c[2]})`))); sel.value = defaultCountry();
    const num = h('input', { class: 'input', type: 'tel', inputMode: 'tel', placeholder: 'Their phone number' });
    const out = h('div', { class: 'stack' }); const err = h('div', { class: 'err', role: 'alert' });
    body.append(h('p', { class: 'muted small' }, 'You can only look up a number you are about to chat with. Results are masked.'),
      h('form', { class: 'stack', on: { submit: async (e) => {
        e.preventDefault(); err.textContent = ''; clear(out);
        let phone; try { phone = toE164(sel.value, num.value); } catch (x) { err.textContent = x.message; return; }
        try {
          const r = await api.lookup(phone);
          if (!r.exists) return void (err.textContent = 'No Duet account for that number yet. Send them an invite link instead.');
          out.append(h('div', { class: 'card' }, h('b', {}, `${r.maskedName} · ${r.maskedPhone}`), h('p', { class: 'small muted' }, r.connected ? 'You already have a conversation with this person.' : 'They will get a request to accept before you can chat.')),
            btn(r.connected ? 'Open conversation' : 'Send request', { kind: 'primary', block: true, onClick: async () => {
              try { const x = await api.connect(phone); s.close(); if (x.conversation) { await refreshAll(); openChat(x.conversation.id); } else { toast('Request sent'); S.connections = await api.connections(); renderList(); } } catch (e2) { err.textContent = e2.message; } } }));
        } catch (x) { err.textContent = x.code === 'rate-limited' ? 'Too many lookups. Try again later.' : x.message; }
      } } }, h('div', { class: 'phone-row' }, sel, num), btn('Look up', { kind: 'primary', block: true, type: 'submit' })), err, out);
  });
}

function openSettings() {
  openSheet('Settings', async (body, sh) => {
    const set = (k, v) => { setSetting(k, v); refreshSettings(); if (k === 'hidePreviews') renderList(); };
    const cur = getSettings();
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' }, ['system', 'light', 'dark'].map((t) => h('button', { type: 'button', 'aria-pressed': String(cur.theme === t), on: { click: (e) => { set('theme', t); seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } } }, t[0].toUpperCase() + t.slice(1))));
    const sw = (label, key, hint, onChange) => { const i = h('input', { type: 'checkbox', checked: !!cur[key], 'aria-label': label, on: { change: async () => { if (onChange) { const ok = await onChange(i.checked); if (ok === false) { i.checked = !i.checked; return; } } set(key, i.checked); } } }); return h('label', { class: 'switch' }, h('span', {}, h('div', {}, label), hint ? h('div', { class: 'small muted' }, hint) : null), i); };
    const lock = h('select', { class: 'input', 'aria-label': 'Auto-lock', on: { change: () => set('autolock', Number(lock.value)) } }, AUTOLOCK_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === cur.autolock }, l)));
    const presence = h('input', { type: 'checkbox', checked: S.user.sharePresence !== false, 'aria-label': 'Share online status', on: { change: async () => { try { const r = await api.updateProfile({ sharePresence: presence.checked }); S.user = r.user; } catch { presence.checked = !presence.checked; } } } });
    const bioRow = h('div', { class: 'switch' });
    const v = await S.store.get('meta', 'vault'); const canBio = await bioAvailable(); const hasBio = !!v?.bio;
    const paintBio = (on) => { clear(bioRow).append(...[h('span', {}, h('div', {}, 'Biometric unlock'), h('div', { class: 'small muted' }, on ? 'Active: a hardware-backed key (WebAuthn PRF) also unlocks your vault.' : canBio ? 'Off: PIN only.' : 'Unavailable on this device or browser: PIN only.')), canBio ? btn(on ? 'Turn off' : 'Turn on', { small: true, onClick: async () => { try { if (on) await S.vault.disableBio(); else await actions.enableBio(); paintBio(!on); } catch (x) { toast(x.message === 'unsupported' ? 'This device cannot protect keys with biometrics' : 'Cancelled'); } } }) : null].filter(Boolean)); };
    paintBio(hasBio);
    const sess = h('div', {}); api.sessions().then((r) => sess.append(...r.sessions.map((x) => h('div', { class: 'sess' }, h('span', {}, (x.ua || 'Unknown device').slice(0, 42), x.current ? ' (this device)' : ''), h('span', { class: 'muted' }, fmtList(x.lastSeen)))))).catch(() => {});
    body.append(
      h('div', { class: 'sec-title' }, 'Appearance'), seg,
      h('div', { class: 'sec-title' }, 'Privacy'),
      sw('Hide message previews', 'hidePreviews', 'In the chat list and notifications.'),
      sw('Confirm before deleting', 'confirmDelete'),
      h('label', { class: 'switch' }, h('span', {}, h('div', {}, 'Share online status'), h('div', { class: 'small muted' }, 'Also hides theirs from you if off.')), presence),
      sw('Notifications', 'notifications', 'Background alerts are opaque: they say only that you have a message.', async (on) => (on ? enableNotifications() : disableNotifications())),
      h('div', { class: 'sec-title' }, 'Security'), field('Auto-lock', lock), bioRow,
      btn('Lock now', { block: true, onClick: () => { sh.close(); actions.lock('manual'); } }),
      ...(S.health?.auth === 'otp' ? [] : [btn('Change password', { block: true, onClick: () => { sh.close(); openChangePassword(); } })]),
      h('div', { class: 'sec-title' }, 'Sessions'), sess, btn('Sign out of all devices', { block: true, kind: 'danger', onClick: async () => { await api.logout(true).catch(() => {}); sh.close(); actions.signOut(); } }),
      h('div', { class: 'sec-title' }, 'Support'), sw('Share anonymous diagnostics', 'diagnostics', 'Event names and counters only, never message content or keys.'),
      h('div', { class: 'notice warn small' }, h('b', {}, 'What Duet protects. '), 'Message bodies, attachments and filenames, identity keys and your local cache are encrypted. The server can see who talks to whom, when, message sizes, and phone numbers. Duet does not defend against a compromised device or a malicious app build.'),
      btn('Sign out', { block: true, onClick: () => { sh.close(); actions.signOut(); } }), btn('Erase this device…', { block: true, kind: 'danger', onClick: () => { sh.close(); actions.eraseDevice(); } }),
      h('p', { class: 'small muted center' }, `Build ${BUILD}${S.health ? ' · ' + S.health.realtime + ' · ' + S.health.store : ''}`));
  });
}

async function enableNotifications() {
  if (!('Notification' in window)) { toast('Notifications are not supported here'); return false; }
  const perm = await Notification.requestPermission(); if (perm !== 'granted') { toast('Notifications are blocked in your browser settings'); return false; }
  try {
    const reg = await navigator.serviceWorker.ready; const { key } = await api.pushKey();
    const pad = '='.repeat((4 - (key.length % 4)) % 4); const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) }));
    await api.pushSubscribe(sub.toJSON());
  } catch { /* in-page notifications still work while the app is open */ }
  return true;
}
async function disableNotifications() {
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await api.pushUnsubscribe(sub.toJSON()).catch(() => {}); await sub.unsubscribe(); } } catch { /* ignore */ }
  return true;
}

function openChangePassword() {
  openSheet('Change password', (body, s) => {
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
    const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
    const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat new password' });
    const err = h('div', { class: 'err', role: 'alert' });
    body.append(h('p', { class: 'muted small' }, 'Changing it signs you out on your other devices. Your messages and vault PIN are not affected.'),
      h('form', { class: 'stack', on: { submit: async (e) => {
        e.preventDefault(); err.textContent = '';
        if (n1.value !== n2.value) { err.textContent = 'The new passwords do not match.'; return; }
        try { await api.changePassword(cur.value, n1.value); s.close(); toast('Password changed'); } catch (x) { err.textContent = x.message; }
      } } }, field('Current password', cur), field('New password (8+ characters)', n1), field('Repeat new password', n2), err, btn('Change password', { kind: 'primary', block: true, type: 'submit' })));
  });
}

