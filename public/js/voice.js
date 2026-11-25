// Voice-message recorder: MediaRecorder (Opus) + a level meter that becomes the waveform shown in the bubble.
// Audio never leaves the device unencrypted: the caller encrypts the bytes like any other attachment.
export const MAX_MS = 5 * 60 * 1000;
export const voiceSupported = () => !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const MIMES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
export const pickMime = () => MIMES.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
export const fmtDur = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, '0')}`;

/** Reduce raw levels (0..1) to `n` bars (8..100 %), normalised so quiet recordings still show a shape. */
export function toWave(levels, n = 40) {
  if (!levels.length) return Array(n).fill(20);
  const out = []; const max = Math.max(...levels, 0.02);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    const slice = levels.slice(a, b); const avg = slice.reduce((x, y) => x + y, 0) / slice.length;
    out.push(Math.round(8 + 92 * Math.min(1, avg / max)));
  }
  return out;
}

export class Recorder {
  /** @param {{onTick?:(ms:number, level:number)=>void, onLimit?:()=>void}} o */
  constructor(o = {}) { this.o = o; this.levels = []; this.chunks = []; this.done = false; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try {
      const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream); this.an = this.ctx.createAnalyser(); this.an.fftSize = 512; src.connect(this.an);
      this.buf = new Uint8Array(this.an.fftSize);
    } catch { this.an = null; } // no meter: recording still works
    this.mime = pickMime();
    this.mr = new MediaRecorder(this.stream, { ...(this.mime ? { mimeType: this.mime } : {}), audioBitsPerSecond: 32000 });
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start(250); this.t0 = Date.now();
    this.timer = setInterval(() => {
      let level = 0;
      if (this.an) { this.an.getByteTimeDomainData(this.buf); let sum = 0; for (const v of this.buf) { const x = (v - 128) / 128; sum += x * x; } level = Math.sqrt(sum / this.buf.length); }
      this.levels.push(level);
      const ms = Date.now() - this.t0; this.o.onTick?.(ms, Math.min(1, level * 3));
      if (ms >= MAX_MS && !this.done) this.o.onLimit?.();
    }, 100);
  }
  _release() { clearInterval(this.timer); this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close?.().catch(() => {}); }
  /** Finish and return { bytes, mime, duration (s), wave }. */
  stop() {
    return new Promise((resolve, reject) => {
      if (this.done) return reject(new Error('already stopped')); this.done = true;
      const ms = Date.now() - this.t0;
      this.mr.onstop = async () => {
        this._release();
        try {
          const blob = new Blob(this.chunks, { type: this.mr.mimeType || this.mime || 'audio/webm' });
          resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: (blob.type || this.mime || 'audio/webm').split(';')[0], duration: Math.max(0.1, Math.round(ms / 100) / 10), wave: toWave(this.levels) });
        } catch (e) { reject(e); }
      };
      try { this.mr.stop(); } catch (e) { this._release(); reject(e); }
    });
  }
  cancel() { if (this.done) return; this.done = true; try { this.mr.onstop = () => this._release(); this.mr.stop(); } catch { this._release(); } }
}
