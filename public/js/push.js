import { api } from './api.js';

let registrationPromise = null;

function urlBase64ToBytes(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupportStatus() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return { supported: false, permission: 'unsupported', reason: 'This browser does not support Web Push.' };
  return {
    supported: true,
    permission: Notification.permission,
    reason: Notification.permission === 'denied'
      ? 'Notifications are blocked in your browser settings.'
      : null
  };
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (registrationPromise) return registrationPromise;
  registrationPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch((error) => {
      registrationPromise = null;
      console.warn('Service worker registration failed', error.message);
      return null;
    });
  return registrationPromise;
}

async function ensureRegistration() {
  if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers.');
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  const created = await registerServiceWorker();
  if (created) return created;
  return navigator.serviceWorker.ready;
}

export async function enablePush() {
  const status = pushSupportStatus();
  if (!status.supported) return { enabled: false, reason: status.reason };
  if (!window.isSecureContext) {
    return { enabled: false, reason: 'Notifications need an https:// connection.' };
  }
  if (Notification.permission === 'denied') {
    return { enabled: false, reason: 'Notifications are blocked in your browser settings.' };
  }
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { enabled: false, reason: 'Notification permission was not granted.' };
    }
  }
  const keyResponse = await api.pushKey();
  if (!keyResponse?.enabled || !keyResponse.publicKey) {
    return { enabled: false, reason: 'This deployment has not configured push notifications.' };
  }
  const registration = await ensureRegistration();
  if (!registration) return { enabled: false, reason: 'The service worker is not ready yet.' };

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(keyResponse.publicKey)
    });
  }
  const json = subscription.toJSON();
  await api.subscribePush({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth
    }
  });
  return { enabled: true };
}

export async function disablePush() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager?.getSubscription?.();
  if (subscription) {
    try { await api.unsubscribePush(subscription.endpoint); } catch { /* session may be gone */ }
    try { await subscription.unsubscribe(); } catch { /* best effort */ }
  }
}
