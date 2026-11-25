// Tiny DOM toolkit. Text is only ever set via textContent / text nodes, never innerHTML.
// The supplied app image is the brand mark (welcome screen, favicon, home-screen icons). Buttons use small
// drawn line icons (svg()) or plain text; every icon-only button carries an aria-label.
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
const SVG_NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14.2s1.4 2.2 4 2.2 4-2.2 4-2.2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  check2: '<path d="M1.5 13.5l4 4L15 8"/><path d="M9.5 16.5l1 1L21 7"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3.4"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7"/>',
};
/** Small line icon drawn in currentColor (not the app image). */
export function svg(name, size = 22) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('width', size); el.setAttribute('height', size);
  el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round'); el.setAttribute('aria-hidden', 'true');
  el.innerHTML = PATHS[name] || ''; // constant, trusted markup from the table above
  return el;
}
export function iconBtn(name, label, onClick, cls = '') {
  return h('button', { type: 'button', class: ('icon-btn ' + cls).trim(), 'aria-label': label, title: label, on: { click: onClick } }, svg(name, 22));
}
/** Text button; pass icon: 'sm' etc. only if you really want the app image on it (nothing does now). */
export function btn(label, { kind = '', onClick, type = 'button', disabled = false, small = false, block = false, icon = null, title } = {}) {
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
