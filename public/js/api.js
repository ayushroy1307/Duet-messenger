export class ApiError extends Error {
  constructor(message, code = 'error', status = 0, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.extra = extra || {};
  }
}

async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    raw = false,
    timeout = 30_000
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const finalHeaders = { ...headers };
  let payload = body;

  if (body !== undefined && body !== null && !raw) {
    finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      body: payload,
      headers: finalHeaders,
      credentials: 'same-origin',
      signal: controller.signal,
      cache: 'no-store'
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      throw new ApiError('Request timed out', 'timeout', 0);
    }
    if (!navigator.onLine) {
      throw new ApiError('You appear to be offline. Duet will retry when you reconnect.', 'offline', 0);
    }
    throw new ApiError('Network error. Check your connection.', 'network', 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('duet:auth-expired'));
    }
    throw new ApiError(
      data?.error || `Request failed (${response.status})`,
      data?.code || `http_${response.status}`,
      response.status,
      data || {}
    );
  }
  return data;
}

export const api = {
  request,
  health: () => request('/api/health'),
  me: () => request('/api/auth/me'),
  register: (username, password, displayName, avatarColor) =>
    request('/api/auth/register', { method: 'POST', body: { username, password, displayName, avatarColor } }),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST', body: {} }),
  logoutAll: () => request('/api/auth/logout-all', { method: 'POST', body: {} }),
  sessions: () => request('/api/auth/sessions'),
  updateProfile: (patch) => request('/api/auth/profile', { method: 'PATCH', body: patch }),
  presence: (visible, online = true) => request('/api/auth/presence', {
    method: 'POST', body: { visible, online }
  }),

  connections: () => request('/api/connections'),
  startConnection: (username) => request('/api/connections', { method: 'POST', body: { username } }),
  respondConnection: (requestId, action) => request('/api/connections/respond', {
    method: 'POST', body: { requestId, action }
  }),

  conversations: () => request('/api/conversations'),
  conversation: (id) => request(`/api/conversations/${id}`),
  messages: (conversationId, { before = null, limit = 40 } = {}) => {
    const params = new URLSearchParams({ conversationId, limit: String(limit) });
    if (before) params.set('before', before);
    return request(`/api/messages?${params.toString()}`);
  },
  sendMessage: (payload) => request('/api/messages', { method: 'POST', body: payload }),
  patchMessage: (id, payload) => request(`/api/messages/${id}`, { method: 'PATCH', body: payload }),
  markRead: (conversationId) => request('/api/messages/read', {
    method: 'POST', body: { conversationId }
  }),

  keys: (conversationId) => request(`/api/keys?conversationId=${encodeURIComponent(conversationId)}`),
  consumeKeys: (conversationId) => request('/api/keys/consume', {
    method: 'POST', body: { conversationId }
  }),
  publishKeys: (bundle) => request('/api/keys', { method: 'POST', body: bundle }),
  selfBundle: (deviceId) => request(`/api/keys/self?deviceId=${encodeURIComponent(deviceId)}`),
  repair: (conversationId) => request('/api/keys/repair', {
    method: 'POST', body: { conversationId }
  }),

  uploadMedia: (conversationId, bytes, mime) => request(
    `/api/media/upload?conversationId=${encodeURIComponent(conversationId)}`,
    {
      method: 'POST',
      body: bytes,
      raw: true,
      timeout: 120_000,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Mime-Hint': mime || 'application/octet-stream'
      }
    }
  ),
  mediaUrl: (id) => `/api/media/${id}`,

  createInvite: (expiresInHours = 72) => request('/api/invites', {
    method: 'POST', body: { expiresInHours }
  }),
  redeemInvite: (token) => request('/api/invites/redeem', {
    method: 'POST', body: { token }
  }),

  pushKey: () => request('/api/push/public-key'),
  subscribePush: (subscription) => request('/api/push/subscribe', {
    method: 'POST', body: subscription
  }),
  unsubscribePush: (endpoint) => request('/api/push/unsubscribe', {
    method: 'POST', body: { endpoint }
  }),

  putVault: (payload) => request('/api/vault', { method: 'PUT', body: payload, timeout: 60_000 }),
  recovery: () => request('/api/vault/recovery'),

  diag: (events, build) => request('/api/diag', {
    method: 'POST', body: { events, build }, timeout: 15_000
  })
};