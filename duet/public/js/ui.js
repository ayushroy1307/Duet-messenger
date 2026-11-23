// Tiny DOM toolkit. Text is only ever set via textContent / text nodes, never innerHTML.
// The supplied image is used for EVERY icon; each icon is paired with a visible text label or an
// accessible name so the app stays usable when all icons look the same.
const ICON = { xs: '/icons/icon-32.png', sm: '/icons/icon-64.png', md: '/icons/icon-64.png', lg: '/icons/icon-128.png', xl: '/icons/icon-256.png', hero: '/icons/icon-256.png' };

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => { if (Array.isArray(k)) k.forEach(add); else if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k))); };
  kids.forEach(add);
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function ic(size = 'md', cls = '') {
  return h('img', { class: `ic ic-${size} ${cls}`.trim(), src: ICON[size] || ICON.md, alt: '', 'aria-hidden': 'true', draggable: false, decoding: 'async' });
}
/** Button = icon + visible label. */
export function btn(label, { kind = '', onClick, type = 'button', disabled = false, small = false, block = false, icon = 'md', title } = {}) {
  return h('button', { type, class: ['btn', kind && `btn-${kind}`, small && 'btn-sm', block && 'btn-block'].filter(Boolean).join(' '), disabled, title: title || label, on: onClick ? { click: onClick } : {} }, icon ? ic(icon) : null, h('span', { class: 'label' }, label));
}
export function field(label, input, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 8);
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'small muted' }, hint) : null);
}
export function initials(name) { const p = String(name || '?').trim().split(/\s+/); return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
export function avatar(u, size = '', online = false) {
  const cls = `avatar ${size ? 'avatar-' + size : ''}`.trim();
  if (u && u.avatar) return h('img', { class: cls, src: u.avatar, alt: '' });
  return h('div', { class: cls, 'aria-hidden': 'true' }, initials(u?.displayName || u?.name), online ? h('span', { class: 'pdot', title: 'Online' }) : null);
}

// ---- sheets / overlay
const overlay = () => document.getElementById('overlay');
const stack = [];
export function openSheet(title, build, { onClose } = {}) {
  const prevFocus = document.activeElement;
  const body = h('div', { class: 'stack' });
  const close = () => { const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1); scrim.remove(); document.removeEventListener('keydown', onKey); onClose?.(); prevFocus?.focus?.(); };
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), btn('Close', { kind: 'quiet', small: true, onClick: close })), body);
  const scrim = h('div', { class: 'scrim', on: { click: (e) => { if (e.target === scrim) close(); } } }, sheet);
  const onKey = (e) => { if (e.key === 'Escape' && stack[stack.length - 1] === api) close(); };
  const api = { close, body, sheet };
  stack.push(api); document.addEventListener('keydown', onKey);
  overlay().append(scrim);
  build(body, api);
  (sheet.querySelector('input,textarea,select') || sheet.querySelector('button'))?.focus();
  return api;
}
export function closeAllSheets() { for (const s of [...stack]) s.close(); }
export function confirmSheet(title, message, confirmLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    openSheet(title, (body, s) => {
      body.append(h('p', { class: 'muted' }, message), h('div', { class: 'row-flex' },
        btn('Cancel', { kind: '', block: true, onClick: () => { done = true; s.close(); resolve(false); } }),
        btn(confirmLabel, { kind: danger ? 'danger' : 'primary', block: true, onClick: () => { done = true; s.close(); resolve(true); } })));
    }, { onClose: () => { if (!done) resolve(false); } });
  });
}
export function toast(msg, ms = 3200) {
  const t = h('div', { class: 'toast' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
export function showViewer(build) {
  const close = () => { v.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const bar = h('div', { class: 'bar' }); const stage = h('div', { class: 'stage' });
  const v = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer' }, bar, stage);
  document.addEventListener('keydown', onKey); overlay().append(v);
  bar.append(btn('Close', { onClick: close }));
  build({ bar, stage, close });
  return close;
}

// ---- formatting
const pad = (n) => String(n).padStart(2, '0');
export const fmtClock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
export function fmtDay(ms) {
  const d = new Date(ms), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  if (dayKey(ms) === dayKey(t.getTime())) return 'Today';
  if (dayKey(ms) === dayKey(y.getTime())) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
export function fmtList(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (dayKey(ms) === dayKey(Date.now())) return fmtClock(ms);
  if (diff < 6 * 86400e3) return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export function fmtLastSeen(ms) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'last seen just now';
  if (m < 60) return `last seen ${m} min ago`;
  if (dayKey(ms) === dayKey(Date.now())) return `last seen today at ${fmtClock(ms)}`;
  return `last seen ${fmtDay(ms).toLowerCase()} at ${fmtClock(ms)}`;
}
