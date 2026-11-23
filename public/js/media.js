// Client-side media preparation. Everything here happens before encryption and upload.
const MAX_BYTES = 25 * 1024 * 1024 - 1024; // server cap minus the 12-byte IV and tag headroom

function canvasBlob(canvas, type, q) { return new Promise((res) => canvas.toBlob(res, type, q)); }
function scaleDims(w, h, max) { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; }

export async function prepareImage(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error('That image is too large.');
  const bmp = await createImageBitmap(file);
  const [tw, th] = scaleDims(bmp.width, bmp.height, 320);
  const tc = document.createElement('canvas'); tc.width = tw; tc.height = th; tc.getContext('2d').drawImage(bmp, 0, 0, tw, th);
  const thumb = tc.toDataURL('image/jpeg', 0.7);
  let bytes, mime = 'image/jpeg', w = bmp.width, h = bmp.height;
  if (file.type === 'image/gif' && file.size <= MAX_BYTES) { bytes = new Uint8Array(await file.arrayBuffer()); mime = 'image/gif'; }
  else {
    const [fw, fh] = scaleDims(bmp.width, bmp.height, 1600); w = fw; h = fh;
    const c = document.createElement('canvas'); c.width = fw; c.height = fh; c.getContext('2d').drawImage(bmp, 0, 0, fw, fh);
    bytes = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.85)).arrayBuffer());
  }
  bmp.close?.();
  if (bytes.length > MAX_BYTES) throw new Error('That image is too large.');
  return { kind: 'image', bytes, mime, name: file.name || 'image', w, h, thumb };
}

export async function prepareVideo(file) {
  if (file.size > MAX_BYTES) throw new Error('Videos are limited to 25 MB.');
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('That video format is not supported here.')); });
    try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); await new Promise((r) => { v.onseeked = r; setTimeout(r, 800); }); } catch { /* use first frame */ }
    const [tw, th] = scaleDims(v.videoWidth || 320, v.videoHeight || 240, 320);
    const c = document.createElement('canvas'); c.width = tw; c.height = th; c.getContext('2d').drawImage(v, 0, 0, tw, th);
    return { kind: 'video', bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || 'video/mp4', name: file.name || 'video', w: v.videoWidth, h: v.videoHeight, thumb: c.toDataURL('image/jpeg', 0.7), duration: Math.round(v.duration || 0) };
  } finally { URL.revokeObjectURL(url); }
}

/** Square avatar as a small JPEG data URL (<= ~20 KB). */
export async function prepareAvatar(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height); const c = document.createElement('canvas'); c.width = c.height = 160;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 160, 160);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.8);
}
