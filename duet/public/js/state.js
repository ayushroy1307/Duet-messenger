// Shared application state and a tiny action registry (filled in by app.js) so screens can
// call each other without circular imports.
import { createApi } from './api.js';
import { getSettings } from './settings.js';

export const api = createApi();
export const S = {
  phase: 'booting',          // booting | welcome | phone | otp | profile | vault-setup | locked | unlocked
  user: null,
  phoneDraft: null, devCode: null,
  health: null,
  store: null, vault: null, engine: null,
  convs: [], connections: { incoming: [], outgoing: [] },
  chat: null,                // the open conversation, see main.js
  online: navigator.onLine,
  sse: null, sseUp: false,
  pendingInvite: null,
  settings: getSettings(),
};
export const actions = {};
export const refreshSettings = () => { S.settings = getSettings(); };
