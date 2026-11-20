// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
//
// WebGL2 smoke: instanced soft sprites with procedural noise textures.
// One draw call per frame; positions are in CSS pixels.

const MAX = 1600;
const MAX_RINGS = 14;
const RING_SPRITES = 96; // max sprites drawn around one ring
const STRIDE = 7; // x, y, size, rot, alpha, shade, variant
const TAU = Math.PI * 2;

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA;
layout(location=2) in vec3 aB;
uniform vec2 uRes;
out vec2 vUv;
out vec2 vCorner;
out float vAlpha;
out float vShade;
out float vRound;
void main() {
  float c = cos(aA.w), s = sin(aA.w);
  vec2 p = vec2(c * aCorner.x - s * aCorner.y, s * aCorner.x + c * aCorner.y) * aA.z * 0.5;
  vec2 pos = aA.xy + p;
  gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
  // Variants 0-3 = cloud puffs, 4-7 = soft round blobs (used to build smoke rings).
  float v = mod(aB.z, 4.0);
  vec2 cell = vec2(mod(v, 2.0), floor(v / 2.0));
  vUv = (aCorner * 0.5 + 0.5 + cell) * 0.5;
  vCorner = aCorner;
  vRound = aB.z >= 3.5 ? 1.0 : 0.0;
  vAlpha = aB.x;
  vShade = aB.y;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec2 vCorner;
in float vAlpha;
in float vShade;
in float vRound;
uniform sampler2D uTex;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUv);
  float a;
  if (vRound > 0.5) {
    float soft = clamp(1.0 - length(vCorner), 0.0, 1.0);
    a = soft * soft * (0.65 + 0.7 * t.a) * vAlpha;
  } else {
    a = t.a * vAlpha;
  }
  vec3 col = mix(vec3(0.70, 0.71, 0.75), vec3(1.0), clamp(vShade * 0.55 + t.r * 0.6, 0.0, 1.0));
  o = vec4(col * a, a);
}`;

// Small value-noise fBm for the puff textures (generated once at startup).
function makeNoise(seed) {
  const N = 64;
  const v = new Float32Array(N * N);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < v.length; i++) {
    s = (s * 9301 + 49297) % 233280;
    v[i] = s / 233280;
  }
  const at = (x, y) => v[(y & (N - 1)) * N + (x & (N - 1))];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * ux;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * ux;
    return a + (b - a) * uy;
  };
}

function buildAtlas() {
  const C = 128;
  const S = C * 2;
  const data = new Uint8Array(S * S * 4);
  for (let cell = 0; cell < 4; cell++) {
    const noise = makeNoise(cell + 1);
    const ox = (cell % 2) * C;
    const oy = Math.floor(cell / 2) * C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = (x + 0.5) / C - 0.5;
        const v = (y + 0.5) / C - 0.5;
        const r = Math.sqrt(u * u + v * v) * 2;
        let f = 0;
        let amp = 0.5;
        let fr = 4;
        for (let o = 0; o < 4; o++) {
          f += noise(x / (C / fr) + cell * 7, y / (C / fr) + cell * 3) * amp;
          amp *= 0.5;
          fr *= 2;
        }
        // Warp the edge with noise so puffs are cloudy, not circular.
        const edge = Math.max(0, 1 - r * (0.75 + f * 0.55));
        const fall = edge * edge * (3 - 2 * edge);
        const billow = Math.max(0, f - 0.22) * 1.6;
        const alpha = Math.max(0, Math.min(1, fall * (0.2 + billow * billow * 1.6)));
        const i = ((oy + y) * S + ox + x) * 4;
        const shade = Math.max(0, Math.min(1, 0.35 + f * 0.9 - v * 0.35));
        data[i] = shade * 255;
        data[i + 1] = shade * 255;
        data[i + 2] = shade * 255;
        data[i + 3] = r >= 0.98 ? 0 : alpha * 255;
      }
    }
  }
  return { data, size: S };
}

export class Smoke {
  constructor(canvas) {
    this.canvas = canvas;
    this.n = 0;
    this.w = 1;
    this.h = 1;
    this.t = 0;
    this.cleared = true;
    const f = () => new Float32Array(MAX);
    this.px = f();
    this.py = f();
    this.vx = f();
    this.vy = f();
    this.age = f();
    this.life = f();
    this.size0 = f();
    this.grow = f();
    this.rot = f();
    this.rotv = f();
    this.amax = f();
    this.shade = f();
    this.seed = f();
    this.variant = f();
    this.wispy = new Uint8Array(MAX);
    this.rings = [];
    this.inst = new Float32Array((MAX + MAX_RINGS * RING_SPRITES) * STRIDE);

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    this.gl = gl;
    if (gl) this.setup();
    else console.warn("[smoke] WebGL2 unavailable; smoke disabled");
  }

  setup() {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uRes = gl.getUniformLocation(prog, "uRes");

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE * 4, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    const { data, size } = buildAtlas();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.n = 0;
    this.rings.length = 0;
    this.cleared = false;
  }

  clear() {
    this.n = 0;
    this.rings.length = 0;
  }

  get busy() {
    return this.rings.length > 0;
  }

  // A smoke ring leaving your mouth. `o.mouthW` = mouth width in CSS px.
  ring(x, y, o) {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    const s = o.scale;
    const r = Math.random;
    const r0 = Math.max(7 * s, (o.mouthW || 20 * s) * 0.5);
    const dense = Math.min(1.6, o.density ?? 1);
    // Blown toward the camera, a ring mostly widens as it comes closer and only
    // rises slowly, so it stays in view.
    this.rings.push({
      x,
      y: y - 2 * s,
      vx: (r() - 0.5) * 12 * s,
      vy: -(12 + r() * 10) * s * (o.strength ?? 1),
      rad: r0,
      grow: (30 + r() * 16) * s * (o.strength ?? 1),
      thick: Math.max(8 * s, r0 * 0.8),
      age: 0,
      life: (3.4 + r() * 1.2) * Math.min(1.8, o.linger ?? 1),
      alpha: Math.min(0.95, 0.5 + 0.25 * dense),
      squash: 0.8 + r() * 0.15,
      spin: (r() - 0.5) * 0.8,
      seed: r() * 10,
    });
  }

  add(x, y, vx, vy, size0, grow, life, amax, shade, wispy) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size0;
    this.grow[i] = grow;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotv[i] = (Math.random() - 0.5) * 0.7;
    this.amax[i] = amax;
    this.shade[i] = shade;
    this.seed[i] = Math.random() * 100;
    this.variant[i] = (Math.random() * 4) | 0;
    this.wispy[i] = wispy ? 1 : 0;
  }

  // A chunk of exhaled smoke. `o.scale` = CSS px per design unit.
  // Shuvashis Gautam: I loved that you used my product, and I hope the clouds are thick enough.
  puff(x, y, o) {
    const s = o.scale;
    const r = Math.random;
    const a = o.angle + (r() - 0.5) * (o.spread ?? 0.75);
    const sp = (80 + r() * 130) * s * o.strength;
    // `amount` = how much smoke, `density` = how thick/opaque each cloud is.
    const fill = Math.min(1.35, 0.7 + 0.3 * o.amount);
    const dense = o.density ?? 1;
    const jitter = o.jitter ?? 8 * s;
    this.add(
      x + (r() - 0.5) * jitter,
      y + (r() - 0.5) * jitter * 0.6,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      (15 + r() * 20) * s * (o.sizeMul ?? 1),
      // Dense smoke stays together longer; wispy smoke spreads out fast.
      (1.0 + r() * 1.3) / (0.7 + 0.3 * dense),
      (3.6 + r() * 3.6) * o.linger,
      (0.16 + r() * 0.16) * fill * Math.pow(dense, 0.9),
      0.7 + r() * 0.3,
      false,
    );
  }

  // Thin idle wisp rising off the coals.
  wisp(x, y, o) {
    const s = o.scale;
    const r = Math.random;
    this.add(
      x + (r() - 0.5) * 14 * s,
      y,
      (r() - 0.5) * 5 * s,
      -(13 + r() * 10) * s,
      (4 + r() * 3) * s,
      1.5 + r() * 1.2,
      (2.2 + r() * 1.6) * Math.min(1.5, o.linger),
      (0.04 + 0.035 * Math.min(1.6, o.amount)) * Math.pow(o.density ?? 1, 0.8),
      0.9,
      true,
    );
  }

  update(dt, scale) {
    this.t += dt;
    const t = this.t;
    const s = scale;
    const drag = Math.exp(-1.5 * dt);
    const buoy = 22 * s * dt;
    for (let i = this.n - 1; i >= 0; i--) {
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const sd = this.seed[i];
      const x = this.px[i];
      const y = this.py[i];
      let vx = this.vx[i] * drag;
      let vy = this.vy[i] * drag - buoy * (this.wispy[i] ? 0.55 : 1);
      // Cheap swirling turbulence field.
      vx += (Math.sin(y / s * 0.035 + t * 0.8 + sd) + 0.6 * Math.sin(y / s * 0.011 - t * 0.5 + sd * 2)) * 14 * s * dt;
      vy += Math.cos(x / s * 0.03 + t * 0.6 + sd) * 8 * s * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.px[i] = x + vx * dt;
      this.py[i] = y + vy * dt;
      this.rot[i] += this.rotv[i] * dt;
    }

    // Rings drift up, slow down, widen and thicken as they age.
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const g = this.rings[i];
      g.age += dt;
      if (g.age >= g.life) {
        this.rings.splice(i, 1);
        continue;
      }
      const k = g.age / g.life;
      g.vx *= Math.exp(-0.6 * dt);
      g.vy = g.vy * Math.exp(-0.45 * dt) - 3 * s * dt;
      g.vx += Math.sin(g.y / s * 0.02 + t * 0.7 + g.seed) * 4 * s * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.rad += g.grow * dt * (1 - 0.6 * k);
      g.thick += 4 * s * dt;
    }
  }

  // Lay the rings out as sprites around their circumference.
  writeRings(start) {
    const inst = this.inst;
    let n = start;
    for (const g of this.rings) {
      const k = g.age / g.life;
      // Holds its shape most of its life, then dissolves.
      const fade = Math.min(1, g.age / 0.12) * (k < 0.55 ? 1 : Math.pow((1 - k) / 0.45, 1.4));
      // Tight overlap so the ring reads as one solid band even when it's wide.
      const count = Math.max(18, Math.min(RING_SPRITES, Math.round((TAU * g.rad) / (g.thick * 0.3))));
      const turn = g.spin * g.age;
      for (let j = 0; j < count; j++) {
        const th = (j / count) * TAU + turn;
        const wob = 1 + 0.06 * Math.sin(3 * th + g.seed + g.age * 2) * (0.3 + k);
        const o = n * STRIDE;
        inst[o] = g.x + Math.cos(th) * g.rad * wob;
        inst[o + 1] = g.y + Math.sin(th) * g.rad * g.squash * wob;
        inst[o + 2] = g.thick * (1.8 + 0.35 * Math.sin(5 * th + g.seed));
        inst[o + 3] = th + g.seed;
        // Near side of the ring catches more light.
        // Overlapping blobs add up, so each one is fairly faint.
        inst[o + 4] = g.alpha * 0.42 * fade * (0.8 + 0.2 * Math.sin(th));
        inst[o + 5] = 0.82 + 0.18 * Math.sin(th);
        inst[o + 6] = 4 + (j % 4); // soft round blob

        n++;
      }
    }
    return n;
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (const arr of [
      this.px, this.py, this.vx, this.vy, this.age, this.life, this.size0,
      this.grow, this.rot, this.rotv, this.amax, this.shade, this.seed, this.variant, this.wispy,
    ]) {
      arr[i] = arr[j];
    }
  }

  render(scale) {
    const gl = this.gl;
    if (!gl) return;
    if (this.n === 0 && this.rings.length === 0) {
      if (!this.cleared) {
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.cleared = true;
      }
      return;
    }
    this.cleared = false;
    const maxSize = 190 * scale;
    const inst = this.inst;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i];
      const life = this.life[i];
      const fadeIn = Math.min(1, age / 0.18);
      const fade = Math.pow(1 - age / life, 1.5);
      const o = i * STRIDE;
      inst[o] = this.px[i];
      inst[o + 1] = this.py[i];
      inst[o + 2] = Math.min(maxSize, this.size0[i] * (1 + this.grow[i] * age));
      inst[o + 3] = this.rot[i];
      inst[o + 4] = this.amax[i] * fadeIn * fade;
      inst[o + 5] = this.shade[i];
      inst[o + 6] = this.variant[i];
    }
    const total = this.writeRings(this.n);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this.w, this.h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, total * STRIDE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, total);
    gl.bindVertexArray(null);
  }
}
