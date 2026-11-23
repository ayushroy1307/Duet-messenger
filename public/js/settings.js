// Per-device settings (non-secret). Account-level ones (presence sharing) live on the server.
const KEY = 'duet.settings';
const DEFAULTS = { theme: 'system', autolock: 5, hidePreviews: false, notifications: false, confirmDelete: true, diagnostics: false };

export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function setSetting(k, v) {
  const s = { ...getSettings(), [k]: v };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage may be blocked */ }
  if (k === 'theme') applyTheme();
  return s;
}
export function applyTheme() {
  const t = getSettings().theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101117' : '#F7F7FA');
}
export const AUTOLOCK_OPTIONS = [[0, 'Immediately when I leave'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [30, 'After 30 minutes']];
