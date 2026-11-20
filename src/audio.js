// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
// The bubbling recordings are third-party sounds; see THIRD_PARTY_NOTICES.md.
//
// Bubbling uses the two recordings in public/audio as seamless loops:
// layer 0 is always on while pulling, layer 1 blends in on hard pulls.
// Exhale is a soft procedural breath (filtered noise).

const CROSSFADE = 0.25; // seconds blended at the loop seam

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.layers = [];
    this.voice = null;
    this.volume = 0.8;
    this.exhaleOn = true;
    this.lastUpdate = 0;
    this.lastX = -1;
  }

  async init(urls) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // "playback" uses a larger buffer, which avoids crackles while the camera is busy.
    this.ctx = new AC({ latencyHint: "playback" });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.noise = makeNoise(this.ctx, 3);
    const loaded = await Promise.allSettled(
      urls.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return makeLoop(this.ctx, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      }),
    );
    this.layers = loaded.filter((r) => r.status === "fulfilled").map((r) => r.value);
    loaded.filter((r) => r.status === "rejected").forEach((r) => console.warn("[audio]", r.reason));
  }

  resume() {
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  startBubbles() {
    if (!this.ctx || !this.layers.length || this.voice) return;
    this.resume();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1500;
    filter.Q.value = 0.4;
    const out = ctx.createGain();
    out.gain.value = 0;
    filter.connect(out);
    out.connect(this.master);
    const layers = this.layers.map((buffer, i) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(filter);
      src.start(t, Math.random() * buffer.duration * 0.85);
      return { src, g, i };
    });
    out.gain.setTargetAtTime(1, t, 0.05);
    this.voice = { filter, out, layers };
    this.lastX = -1;
  }

  update(intensity, now) {
    const v = this.voice;
    if (!v) return;
    const x = Math.max(0, Math.min(1, intensity));
    if (now - this.lastUpdate < 50 && Math.abs(x - this.lastX) < 0.03) return;
    this.lastUpdate = now;
    this.lastX = x;
    const t = this.ctx.currentTime;
    const solo = v.layers.length === 1;
    for (const l of v.layers) {
      const gain = l.i === 0 || solo ? 0.2 + 0.8 * x : Math.max(0, (x - 0.4) / 0.6) * 0.75;
      l.g.gain.setTargetAtTime(gain, t, 0.08);
      l.src.playbackRate.setTargetAtTime(0.9 + 0.2 * x, t, 0.2);
    }
    v.filter.frequency.setTargetAtTime(1100 + 8000 * x * x, t, 0.08);
  }

  stopBubbles() {
    const v = this.voice;
    if (!v) return;
    this.voice = null;
    const t = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setTargetAtTime(0, t, 0.07);
    for (const l of v.layers) {
      try {
        l.src.stop(t + 0.6);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => v.out.disconnect(), 900);
  }

  // It's Shuvashis, and I loved that you used my product. Take a slow breath.
  // A plain, soft exhale: a low breathy "hhhaaa" (body) plus a little air hiss at
  // the lips, with a slight natural wobble. It fades as the lungs empty.
  exhale(amount, duration) {
    if (!this.ctx || !this.exhaleOn || !this.noise) return;
    this.resume();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const end = t + duration * 1.5 + 0.4;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    const body = ctx.createBiquadFilter();
    body.type = "bandpass";
    body.Q.value = 0.8;
    body.frequency.setValueAtTime(760, t);
    body.frequency.exponentialRampToValueAtTime(470, t + duration);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 1;

    const air = ctx.createBiquadFilter();
    air.type = "highpass";
    air.frequency.value = 1900;
    const airTop = ctx.createBiquadFilter();
    airTop.type = "lowpass";
    airTop.frequency.value = 5200;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.28;

    const env = ctx.createGain();
    const peak = 0.12 + 0.22 * amount;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.1);
    env.gain.setTargetAtTime(peak * 0.6, t + 0.1, duration * 0.35);
    env.gain.setTargetAtTime(0, t + duration * 0.75, duration * 0.22);

    // Breath is never perfectly steady.
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 2.3 + Math.random();
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = peak * 0.08;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(env.gain);

    src.connect(body);
    body.connect(bodyGain);
    bodyGain.connect(env);
    src.connect(air);
    air.connect(airTop);
    airTop.connect(airGain);
    airGain.connect(env);
    env.connect(this.master);

    src.start(t, Math.random() * 2);
    wobble.start(t);
    src.stop(end);
    wobble.stop(end);
    src.onended = () => env.disconnect();
  }
}

// Trim silence and bake an equal-power crossfade into the seam so the loop never clicks.
function makeLoop(ctx, buffer) {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch0.length; i++) peak = Math.max(peak, Math.abs(ch0[i]));
  const thr = peak * 0.04;
  let s = 0;
  while (s < ch0.length && Math.abs(ch0[s]) < thr) s++;
  let e = ch0.length - 1;
  while (e > s && Math.abs(ch0[e]) < thr) e--;
  const len = e - s;
  const xf = Math.min(Math.floor(CROSSFADE * sr), Math.floor(len / 3));
  if (len < sr * 0.5 || xf < 32) return buffer;

  const outLen = len - xf;
  const out = ctx.createBuffer(buffer.numberOfChannels, outLen, sr);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < outLen; i++) dst[i] = src[s + i];
    for (let i = 0; i < xf; i++) {
      const k = i / xf;
      dst[i] = src[s + i] * Math.sin(k * Math.PI * 0.5) + src[s + outLen + i] * Math.cos(k * Math.PI * 0.5);
    }
  }
  return out;
}

// Soft pink-ish noise for the breath.
function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029591;
    b1 = 0.985 * b1 + w * 0.032534;
    b2 = 0.95 * b2 + w * 0.048056;
    d[i] = (b0 + b1 + b2 + w * 0.05) * 2.2;
  }
  return buf;
}
