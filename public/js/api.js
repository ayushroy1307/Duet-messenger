// Thin fetch wrapper for the Duet server. Same module is used by the browser and by the Node e2e tests.
export function createApi(f = (...a) => globalThis.fetch(...a), base = '') {
  async function call(method, path, body, opts = {}) {
    let res;
    try {
      res = await f(base + path, {
        method,
        headers: { 'x-duet': '1', ...(body !== undefined && !opts.raw ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch (e) { const err = new Error('Network unavailable'); err.code = 'net'; err.offline = true; throw err; }
    if (opts.binary && res.ok) return new Uint8Array(await res.arrayBuffer());
    let data = {};
    try { data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {}; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || 'Request failed');
      err.code = data.code || 'http-' + res.status; err.status = res.status;
      err.permanent = res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status);
      throw err;
    }
    return data;
  }
  const qs = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined))).toString();
  return {
    call,
    health: () => call('GET', '/api/health'),
    sendOtp: (phone) => call('POST', '/api/auth/otp/send', { phone }),
    verifyOtp: (phone, code) => call('POST', '/api/auth/otp/verify', { phone, code }),
    register: (phone, password, signupCode) => call('POST', '/api/auth/register', { phone, password, signupCode }),
    login: (phone, password) => call('POST', '/api/auth/login', { phone, password }),
    changePassword: (current, next) => call('PUT', '/api/auth/password', { current, next }),
    me: () => call('GET', '/api/auth/me'),
    logout: (all = false) => call('POST', '/api/auth/logout', { all }),
    sessions: () => call('GET', '/api/auth/sessions'),
    updateProfile: (p) => call('PUT', '/api/users/me', p),
    lookup: (phone) => call('GET', '/api/lookup?' + qs({ phone })),
    connections: () => call('GET', '/api/connections'),
    connect: (phone) => call('POST', '/api/connections', { phone }),
    respondConnection: (requestId, accept) => call('POST', '/api/connections', { requestId, accept }),
    createInvite: () => call('POST', '/api/invites', {}),
    redeemInvite: (token) => call('POST', '/api/invites/redeem', { token }),
    conversations: () => call('GET', '/api/conversations'),
    publishKeys: (bundle) => call('POST', '/api/keys', bundle),
    getPeerBundle: (conversationId) => call('GET', '/api/keys?' + qs({ conversationId })),
    requestRepair: (conversationId, kind) => call('POST', '/api/keys/repair', { conversationId, kind }),
    fetchMessages: (conversationId, { before = null, limit = 30 } = {}) => call('GET', '/api/messages?' + qs({ conversationId, before, limit })),
    postMessage: (m) => call('POST', '/api/messages', m),
    postReceipt: (conversationId, upTo, kind) => call('POST', '/api/messages/receipts', { conversationId, upTo, kind }),
    deleteMessage: (id) => call('POST', '/api/messages/delete', { id }),
    uploadMedia: (conversationId, blob, kind) => call('POST', '/api/media/upload', blob, { raw: true, headers: { 'x-conversation': conversationId, 'x-kind': kind, 'content-type': 'application/octet-stream' } }),
    downloadMedia: (id) => call('GET', '/api/media/' + encodeURIComponent(id), undefined, { binary: true }),
    pushKey: () => call('GET', '/api/push/key'),
    pushSubscribe: (subscription) => call('POST', '/api/push/subscribe', { subscription }),
    pushUnsubscribe: (subscription) => call('POST', '/api/push/subscribe', { subscription, unsubscribe: true }),
    diag: (build, events) => call('POST', '/api/diag', { build, events }),
  };
}
