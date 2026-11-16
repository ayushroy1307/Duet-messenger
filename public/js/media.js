import { useEffect, useState } from './preact.js';
import { api } from './api.js';
import { decryptMedia } from './crypto.js';
import { getVault } from './store.js';

/**
 * Attachments are downloaded as opaque ciphertext and decrypted on-device.
 * The decrypted copy is kept only in the vault's encrypted media cache.
 */
export async function loadMediaBytes(payload) {
  if (!payload?.mediaId || !payload.key || !payload.nonce) {
    throw new Error('This attachment is missing its decryption key.');
  }
  const mime = payload.mime || 'application/octet-stream';
  const vault = getVault();
  if (vault) {
    const cached = await vault.readMediaCache(payload.mediaId).catch(() => null);
    if (cached?.bytes) return { bytes: cached.bytes, mime: cached.mime || mime };
  }
  const response = await fetch(api.mediaUrl(payload.mediaId), {
    credentials: 'same-origin',
    cache: 'no-store'
  });
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('duet:auth-expired'));
    throw new Error('Sign in again to open this attachment.');
  }
  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'This attachment is no longer on the server.'
      : 'The attachment could not be downloaded.');
  }
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  const bytes = decryptMedia(ciphertext, payload.key, payload.nonce);
  if (vault && bytes.length <= 8 * 1024 * 1024) {
    void vault.writeMediaCache(payload.mediaId, bytes, mime).catch(() => {});
  }
  return { bytes, mime };
}

export function useMediaSource(payload) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: 'loading', url: null, bytes: null, mime: null, error: null });

  useEffect(() => {
    if (!payload?.mediaId) {
      setState({ status: 'error', url: null, bytes: null, mime: null, error: 'This attachment is unavailable.' });
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    setState((current) => ({ ...current, status: current.url ? 'ready' : 'loading', error: null }));

    loadMediaBytes(payload)
      .then(({ bytes, mime }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setState({ status: 'ready', url: objectUrl, bytes, mime, error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ status: 'error', url: null, bytes: null, mime: null, error: error.message || 'This attachment could not be opened.' });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [payload?.mediaId, payload?.key, payload?.nonce, attempt]);

  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
