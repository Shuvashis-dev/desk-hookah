// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
//
// Verlet-rope hose with a rigid brass mouthpiece on the end.
// Works in scene design units. Goes to sleep when settled so idle costs nothing.
import { DW, GEO } from "./scene.js";

const STEP = 1 / 60;
const GRAVITY = 1100;
const DAMP = 0.988;
const ITER = 14;

export class Hose {
  constructor() {
    this.segs = 22;
    this.segLen = 14;
    this.mpLen = 58;
    this.rad = 4.8;
    this.count = this.segs + 2; // hose nodes 0..segs, plus the mouthpiece tip
    const n = this.count;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.inv = new Float32Array(n).fill(1);
    this.inv[0] = 0;
    this.tipInv = 0.35; // the brass mouthpiece is heavier than the hose
    this.inv[n - 1] = this.tipInv;
    this.grabbed = false;
    this.follow = 0.32;
    this.tx = 0;
    this.ty = 0;
    this.acc = 0;
    this.still = 0;
    this.awake = true;
    this.reset();
  }

  get tip() {
    return this.count - 1;
  }

  get length() {
    return this.segs * this.segLen + this.mpLen;
  }

  reset() {
    const { x: ax, y: ay } = GEO.port;
    for (let i = 0; i < this.count; i++) {
      this.x[i] = this.px[i] = Math.min(DW - 10, ax + i * 7);
      this.y[i] = this.py[i] = Math.min(GEO.floor - 6, ay + i * 12);
    }
    for (let k = 0; k < 500; k++) this.sim(STEP);
    this.awake = true;
    this.still = 0;
  }

  wake() {
    this.awake = true;
    this.still = 0;
  }

  // `follow` = how tightly the mouthpiece tracks the target per step
  // (tight for the mouse, softer for noisy hand tracking).
  grab(x, y, follow = 0.32) {
    this.grabbed = true;
    this.follow = follow;
    this.inv[this.tip] = 0;
    this.setTarget(x, y);
    this.wake();
  }

  setTarget(x, y) {
    const { x: ax, y: ay } = GEO.port;
    let dx = x - ax;
    let dy = y - ay;
    const d = Math.hypot(dx, dy);
    const reach = this.length * 0.94;
    if (d > reach) {
      dx *= reach / d;
      dy *= reach / d;
    }
    this.tx = ax + dx;
    this.ty = ay + dy;
  }

  release() {
    if (!this.grabbed) return;
    this.grabbed = false;
    this.inv[this.tip] = this.tipInv;
    this.wake();
  }

  // Distance from a point to the hose (design units), used for mouse grabbing.
  hit(px, py) {
    const t = this.tip;
    if (segDist(px, py, this.x[t - 1], this.y[t - 1], this.x[t], this.y[t]) < 16) return true;
    for (let i = 2; i < t; i++) {
      if (Math.hypot(px - this.x[i], py - this.y[i]) < 11) return true;
    }
    return false;
  }

  update(dt) {
    if (!this.awake) return;
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= STEP && steps < 4) {
      this.sim(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === 4) this.acc = 0;
  }

  // It's Shuvashis. I loved that you used my product; enjoy the rope physics.
  sim(h) {
    const { x, y, px, py, inv, count } = this;
    const g = GRAVITY * h * h;
    const tip = count - 1;
    let moved = 0;

    for (let i = 1; i < count; i++) {
      if (inv[i] === 0) continue;
      const vx = (x[i] - px[i]) * DAMP;
      const vy = (y[i] - py[i]) * DAMP;
      px[i] = x[i];
      py[i] = y[i];
      x[i] += vx;
      y[i] += vy + g;
      moved = Math.max(moved, Math.abs(vx) + Math.abs(vy));
    }

    x[0] = px[0] = GEO.port.x;
    y[0] = py[0] = GEO.port.y;
    if (this.grabbed) {
      // Ease the mouthpiece toward the hand/cursor so jitter never reaches the rope.
      const nx = x[tip] + (this.tx - x[tip]) * this.follow;
      const ny = y[tip] + (this.ty - y[tip]) * this.follow;
      moved = Math.max(moved, Math.abs(nx - x[tip]) + Math.abs(ny - y[tip]));
      x[tip] = px[tip] = nx;
      y[tip] = py[tip] = ny;
    }

    const bendHose = this.segLen * 1.6;
    const bendTip = (this.segLen + this.mpLen) * 0.92;
    for (let it = 0; it < ITER; it++) {
      for (let i = 0; i < count - 1; i++) {
        this.solve(i, i + 1, i === count - 2 ? this.mpLen : this.segLen, false);
      }
      for (let i = 0; i < count - 2; i++) {
        this.solve(i, i + 2, i === count - 3 ? bendTip : bendHose, true);
      }
      // The hose leaves the port sideways instead of dropping straight down.
      this.pushFrom(GEO.portBack.x, GEO.portBack.y, 1, this.segLen * 1.9);
      this.collide();
    }

    // Floor friction, applied once per step.
    for (let i = 1; i < count; i++) {
      const r = i === tip ? 4 : this.rad;
      // Light friction while you drag it, so it slides instead of sticking; stronger
      // once released, so it still comes to rest quickly.
      if (y[i] >= GEO.floor - r - 0.05) px[i] += (x[i] - px[i]) * (this.grabbed ? 0.12 : 0.35);
    }

    // Sleep once the rope has actually stopped moving (net motion after constraints).
    let settled = 0;
    for (let i = 1; i < count; i++) {
      settled = Math.max(settled, Math.abs(x[i] - px[i]) + Math.abs(y[i] - py[i]));
    }
    if (!this.grabbed && settled < 0.03 && moved < 1) {
      if (++this.still > 45) {
        this.awake = false;
        px.set(x);
        py.set(y);
      }
    } else {
      this.still = 0;
    }
  }

  solve(i, j, rest, minOnly) {
    const { x, y, inv } = this;
    const dx = x[j] - x[i];
    const dy = y[j] - y[i];
    const d = Math.hypot(dx, dy) || 1e-6;
    if (minOnly && d >= rest) return;
    const w = inv[i] + inv[j];
    if (w === 0) return;
    const k = (d - rest) / (d * w);
    x[i] += dx * k * inv[i];
    y[i] += dy * k * inv[i];
    x[j] -= dx * k * inv[j];
    y[j] -= dy * k * inv[j];
  }

  pushFrom(fx, fy, j, rest) {
    if (this.inv[j] === 0) return;
    const dx = this.x[j] - fx;
    const dy = this.y[j] - fy;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (d >= rest) return;
    this.x[j] = fx + (dx / d) * rest;
    this.y[j] = fy + (dy / d) * rest;
  }

  // Floor and window edges only. The vase is handled by slideOffVase(): a hard
  // collision against its round shape is what used to snag and wrap the hose.
  collide() {
    const { x, y, inv, count } = this;
    const tip = count - 1;
    for (let i = 1; i < count; i++) {
      if (inv[i] === 0) continue;
      const r = i === tip ? 4 : this.rad;
      if (y[i] > GEO.floor - r) y[i] = GEO.floor - r;
      if (y[i] < r) y[i] = r;
      if (x[i] < r + 2) x[i] = r + 2;
      if (x[i] > DW - r - 2) x[i] = DW - r - 2;
      if (!this.grabbed) this.slideOffVase(i, r);
    }
  }

  // After letting go, any part of the hose overlapping the vase is pushed out to the
  // port side only (never up), so it can't end up balanced on top of the bottle or
  // wrapped around it. While held, the hose simply passes in front of the glass.
  // Runs inside the solver iterations so it agrees with the rope constraints and the
  // hose comes fully to rest.
  slideOffVase(i, r) {
    const { x, y, px } = this;
    for (const c of GEO.vaseCircles) {
      const dy = y[i] - c.y;
      const min = c.r + r;
      if (Math.abs(dy) >= min) continue;
      const surface = c.x + Math.sqrt(min * min - dy * dy);
      const depth = surface - x[i];
      if (depth <= 0) continue;
      if (depth < 6) {
        x[i] = surface; // touching the glass: hard contact
      } else {
        // Far inside (e.g. dropped on the other side): glide across over a few frames.
        const step = depth * 0.04;
        x[i] += step;
        px[i] += step; // no added velocity, so it doesn't get flung
      }
    }
  }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1e-6;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
