// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
//
// Canvas 2D hookah renderer.
// Everything is drawn in fixed "design units" (DW x DH) and scaled to the window.
// Static parts are pre-rendered into two offscreen layers once per resize, so a
// frame only draws water, bubbles, coals, hose and mouthpiece.

export const DW = 320;
export const DH = 540;
const CX = 150;
const TAU = Math.PI * 2;

export const GEO = {
  cx: CX,
  floor: 532,
  port: { x: CX + 31, y: 302 },
  portBack: { x: CX + 16, y: 302 },
  coals: { x: CX, y: 104 },
  tubeEnd: { x: CX, y: 494 },
  water: 442,
  mouthRest: { x: CX + 96, y: 232 },
  vaseCircles: [
    { x: CX, y: 463, r: 62 },
    { x: CX, y: 404, r: 32 },
    { x: CX, y: 364, r: 18 },
  ],
  bodyRects: [
    { x: CX - 66, y: 94, w: 132, h: 80 },
    { x: CX - 18, y: 172, w: 52, h: 160 },
    { x: CX - 64, y: 324, w: 128, h: 212 },
  ],
};

const COALS = [
  { x: CX - 19, y: 106, w: 12, h: 10, ph: 0.3 },
  { x: CX - 5.5, y: 103.5, w: 12, h: 11, ph: 2.1 },
  { x: CX + 8, y: 106.5, w: 12, h: 10, ph: 4.0 },
];

// Right-hand outline of the vase as two cubic segments (top to bottom).
const VASE_RIGHT = [
  [[CX + 14, 336], [CX + 14, 382], [CX + 62, 398], [CX + 62, 462]],
  [[CX + 62, 462], [CX + 62, 506], [CX + 38, 522], [CX + 22, 524]],
];

const bez = (a, b, c, d, t) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

function buildVasePath() {
  const p = new Path2D();
  p.moveTo(CX - 14, 336);
  p.bezierCurveTo(CX - 14, 382, CX - 62, 398, CX - 62, 462);
  p.bezierCurveTo(CX - 62, 506, CX - 38, 522, CX - 22, 524);
  p.lineTo(CX + 22, 524);
  p.bezierCurveTo(CX + 38, 522, CX + 62, 506, CX + 62, 462);
  p.bezierCurveTo(CX + 62, 398, CX + 14, 382, CX + 14, 336);
  p.closePath();
  return p;
}

function buildHalfWidthTable() {
  const pts = [];
  for (const [p0, p1, p2, p3] of VASE_RIGHT) {
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      pts.push([bez(p0[0], p1[0], p2[0], p3[0], t) - CX, bez(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  return pts;
}

function linear(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

const BRASS = [
  [0, "#4f340b"],
  [0.25, "#c8963f"],
  [0.42, "#fde9ad"],
  [0.58, "#d29d45"],
  [0.8, "#8a5f1d"],
  [1, "#3e2807"],
];
const COBALT = [
  [0, "#0a1240"],
  [0.28, "#243ea8"],
  [0.43, "#6f8cec"],
  [0.58, "#2a43ac"],
  [1, "#081038"],
];

const brass = (ctx, x0, x1) => linear(ctx, x0, 0, x1, 0, BRASS);
const brassV = (ctx, y0, y1) => linear(ctx, 0, y0, 0, y1, BRASS);
const cobalt = (ctx, x0, x1) => linear(ctx, x0, 0, x1, 0, COBALT);

function heartPath(ctx, x, y, sx, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale((sx * size) / 20, size / 20);
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.bezierCurveTo(-12, 0, -9, -10, 0, -5);
  ctx.bezierCurveTo(9, -10, 12, 0, 0, 8);
  ctx.closePath();
  ctx.restore();
}

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.back = document.createElement("canvas");
    this.front = document.createElement("canvas");
    this.vase = buildVasePath();
    this.hwTable = buildHalfWidthTable();
    this.s = 1;
    this.ox = 0;
    this.oy = 0;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.bubbles = [];
    this.embers = [];
    this.bubbleAcc = 0;
    this.emberAcc = 0;
    this.surfaceKick = 0;

    const c = this.ctx;
    this.waterFill = linear(c, 0, GEO.water - 4, 0, 528, [
      [0, "rgba(255,185,200,0.26)"],
      [0.35, "rgba(200,60,95,0.20)"],
      [1, "rgba(90,0,22,0.38)"],
    ]);
    this.coalEmber = COALS.map((k) =>
      linear(c, 0, k.y + k.h, 0, k.y, [
        [0, "rgba(255,120,30,1)"],
        [0.45, "rgba(255,70,15,0.85)"],
        [1, "rgba(160,30,8,0.15)"],
      ]),
    );
    const halo = c.createRadialGradient(CX, 108, 2, CX, 108, 52);
    halo.addColorStop(0, "rgba(255,170,70,0.55)");
    halo.addColorStop(0.35, "rgba(255,95,25,0.22)");
    halo.addColorStop(1, "rgba(255,60,10,0)");
    this.halo = halo;
    this.trayGlow = c.createRadialGradient(CX, 160, 4, CX, 160, 64);
    this.trayGlow.addColorStop(0, "rgba(255,140,60,0.35)");
    this.trayGlow.addColorStop(1, "rgba(255,120,40,0)");
    this.mpFill = linear(c, 0, -7, 0, 7, [
      [0, "#4f340b"],
      [0.28, "#f7dd98"],
      [0.5, "#c79a45"],
      [0.8, "#7a5418"],
      [1, "#3a2506"],
    ]);
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.s = Math.min(w / DW, h / DH);
    this.ox = (w - DW * this.s) / 2;
    this.oy = h - DH * this.s;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    for (const c of [this.canvas, this.back, this.front]) {
      c.width = pw;
      c.height = ph;
    }
    this.prerender();
  }

  design(ctx) {
    const k = this.s * this.dpr;
    ctx.setTransform(k, 0, 0, k, this.ox * this.dpr, this.oy * this.dpr);
  }

  toDesign(x, y) {
    return [(x - this.ox) / this.s, (y - this.oy) / this.s];
  }

  toCss(x, y) {
    return [this.ox + x * this.s, this.oy + y * this.s];
  }

  rectToCss(r, pad = 0) {
    return {
      x: this.ox + (r.x - pad) * this.s,
      y: this.oy + (r.y - pad) * this.s,
      w: (r.w + pad * 2) * this.s,
      h: (r.h + pad * 2) * this.s,
    };
  }

  hw(y) {
    const p = this.hwTable;
    if (y <= p[0][1]) return p[0][0];
    for (let i = 1; i < p.length; i++) {
      if (p[i][1] >= y) {
        const a = p[i - 1];
        const b = p[i];
        const t = (y - a[1]) / (b[1] - a[1] || 1);
        return a[0] + (b[0] - a[0]) * t;
      }
    }
    return p[p.length - 1][0];
  }

  hitBody(x, y) {
    return GEO.bodyRects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  busy() {
    return this.bubbles.length > 0 || this.embers.length > 0 || this.surfaceKick > 0.02;
  }

  // ---------------------------------------------------------------- static layers

  prerender() {
    for (const [canvas, fn] of [
      [this.back, (c) => this.drawBack(c)],
      [this.front, (c) => this.drawFront(c)],
    ]) {
      const c = canvas.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      this.design(c);
      fn(c);
    }
  }

  drawBack(b) {
    // Soft contact shadow so the hookah sits on the desktop.
    b.save();
    b.translate(CX + 6, GEO.floor - 1);
    b.scale(1, 0.13);
    const sh = b.createRadialGradient(0, 0, 0, 0, 0, 100);
    sh.addColorStop(0, "rgba(0,0,0,0.5)");
    sh.addColorStop(0.6, "rgba(0,0,0,0.22)");
    sh.addColorStop(1, "rgba(0,0,0,0)");
    b.fillStyle = sh;
    b.beginPath();
    b.arc(0, 0, 100, 0, TAU);
    b.fill();
    b.restore();

    // Tinted red glass: thicker (darker) at the edges, thinner in the middle.
    b.fillStyle = linear(b, CX - 62, 0, CX + 62, 0, [
      [0, "rgba(100,4,24,0.86)"],
      [0.16, "rgba(165,18,48,0.62)"],
      [0.5, "rgba(205,48,84,0.46)"],
      [0.84, "rgba(160,16,44,0.64)"],
      [1, "rgba(90,3,20,0.88)"],
    ]);
    b.fill(this.vase);

    b.save();
    b.clip(this.vase);
    const depth = b.createRadialGradient(CX + 8, 456, 10, CX, 462, 80);
    depth.addColorStop(0, "rgba(255,130,160,0.12)");
    depth.addColorStop(0.7, "rgba(60,0,16,0.08)");
    depth.addColorStop(1, "rgba(30,0,8,0.5)");
    b.fillStyle = depth;
    b.fillRect(CX - 70, 330, 140, 200);

    // Down-tube seen through the glass.
    b.globalAlpha = 0.78;
    b.fillStyle = brass(b, CX - 4, CX + 4);
    b.fillRect(CX - 3.6, 334, 7.2, GEO.tubeEnd.y - 334);
    b.fillStyle = "#3a2508";
    b.fillRect(CX - 4.4, GEO.tubeEnd.y - 2, 8.8, 3);
    b.restore();
  }

  drawFront(f) {
    const vase = this.vase;

    // Glass sheen and painted decoration, clipped to the vase.
    f.save();
    f.clip(vase);

    f.fillStyle = linear(f, CX - 58, 0, CX - 24, 0, [
      [0, "rgba(255,255,255,0)"],
      [0.45, "rgba(255,255,255,0.26)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    f.beginPath();
    f.ellipse(CX - 40, 462, 12, 50, 0, 0, TAU);
    f.fill();
    f.fillStyle = "rgba(255,255,255,0.5)";
    f.beginPath();
    f.ellipse(CX - 45, 452, 2.6, 26, -0.05, 0, TAU);
    f.fill();
    f.fillStyle = "rgba(255,255,255,0.14)";
    f.beginPath();
    f.ellipse(CX + 49, 474, 5, 30, 0.12, 0, TAU);
    f.fill();
    f.fillStyle = "rgba(255,255,255,0.32)";
    f.fillRect(CX - 10, 344, 2.6, 36);

    // Gold bands.
    f.strokeStyle = "#e7b95a";
    f.lineWidth = 2.2;
    for (const y of [352, 509]) {
      const hw = this.hw(y);
      f.beginPath();
      f.ellipse(CX, y, hw, hw * 0.12, 0, 0, Math.PI);
      f.stroke();
    }
    f.lineWidth = 1;
    f.strokeStyle = "rgba(240,200,110,0.8)";
    const hw414 = this.hw(414);
    f.beginPath();
    f.ellipse(CX, 414, hw414, hw414 * 0.13, 0, 0, Math.PI);
    f.stroke();

    // Scalloped arches under the top band.
    f.strokeStyle = "rgba(240,200,110,0.85)";
    f.lineWidth = 1.1;
    for (let i = -3; i <= 3; i++) {
      const th = i * 0.42;
      const x = CX + this.hw(420) * Math.sin(th);
      const sx = Math.cos(th);
      f.beginPath();
      f.ellipse(x, 420, 7 * sx, 5, 0, 0, Math.PI);
      f.stroke();
    }

    // It's Shuvashis, and I loved that you used my product. These hearts are for you.
    // Heart motifs (gold outline, turquoise inlay) around the bulb.
    for (const th of [-1.15, -0.58, 0, 0.58, 1.15]) {
      const x = CX + 52 * Math.sin(th);
      const sx = Math.max(0.25, Math.cos(th));
      heartPath(f, x, 462, sx, 18);
      f.fillStyle = "rgba(38,180,175,0.92)";
      f.fill();
      f.strokeStyle = "#f1c46a";
      f.lineWidth = 1.5;
      f.stroke();
      heartPath(f, x, 461, sx, 8);
      f.fillStyle = "#f6d585";
      f.fill();
      f.fillStyle = "#f1c46a";
      for (const dy of [-16, 15]) {
        f.beginPath();
        f.arc(x, 462 + dy, 1.4, 0, TAU);
        f.fill();
      }
    }
    // Dots between hearts.
    f.fillStyle = "rgba(245,205,120,0.9)";
    for (const th of [-0.87, -0.29, 0.29, 0.87]) {
      const x = CX + 54 * Math.sin(th);
      for (const dy of [-6, 0, 6]) {
        f.beginPath();
        f.arc(x, 462 + dy, 1.1 * Math.cos(th) + 0.3, 0, TAU);
        f.fill();
      }
    }
    // Turquoise dots along the bottom band.
    f.fillStyle = "rgba(60,200,195,0.9)";
    for (let i = -5; i <= 5; i++) {
      const th = i * 0.27;
      const x = CX + this.hw(500) * Math.sin(th);
      f.beginPath();
      f.arc(x, 500 + Math.cos(th) * 2.5, 1.5 * Math.cos(th) + 0.3, 0, TAU);
      f.fill();
    }
    // Neck diamonds.
    f.fillStyle = "#f1c46a";
    for (let i = 0; i < 3; i++) {
      const y = 362 + i * 9;
      f.beginPath();
      f.moveTo(CX, y - 3.5);
      f.lineTo(CX + 2.6, y);
      f.lineTo(CX, y + 3.5);
      f.lineTo(CX - 2.6, y);
      f.closePath();
      f.fill();
    }
    f.restore();

    f.strokeStyle = "rgba(255,180,195,0.38)";
    f.lineWidth = 0.9;
    f.stroke(vase);

    // Pink glass foot.
    f.beginPath();
    f.moveTo(CX - 23, 521);
    f.bezierCurveTo(CX - 27, 526, CX - 34, 528, CX - 38, 530);
    f.lineTo(CX + 38, 530);
    f.bezierCurveTo(CX + 34, 528, CX + 27, 526, CX + 23, 521);
    f.closePath();
    f.fillStyle = linear(f, CX - 38, 0, CX + 38, 0, [
      [0, "#6e0a1f"],
      [0.35, "#d65a80"],
      [0.5, "#f08aa6"],
      [0.7, "#b8325a"],
      [1, "#5e0718"],
    ]);
    f.fill();
    f.beginPath();
    f.ellipse(CX, 530, 38, 3, 0, 0, TAU);
    f.fillStyle = "#7d1027";
    f.fill();
    f.strokeStyle = "#e7b95a";
    f.lineWidth = 1.1;
    f.beginPath();
    f.ellipse(CX, 524, 25, 1.8, 0, 0, Math.PI);
    f.stroke();

    // Gold collar on the vase mouth.
    f.fillStyle = brass(f, CX - 20, CX + 20);
    f.beginPath();
    f.roundRect(CX - 19, 325, 38, 14, 3);
    f.fill();
    f.fillStyle = "rgba(255,240,190,0.6)";
    f.beginPath();
    f.ellipse(CX, 325.5, 18, 2.6, 0, 0, TAU);
    f.fill();
    f.fillStyle = "rgba(60,35,5,0.55)";
    f.fillRect(CX - 19, 331, 38, 1.4);

    // Hose port.
    f.fillStyle = brassV(f, 297, 307);
    f.beginPath();
    f.roundRect(CX + 9, 297.5, 20, 9, 2.5);
    f.fill();
    f.fillStyle = brass(f, CX + 27, CX + 33);
    f.beginPath();
    f.ellipse(CX + 29.5, 302, 3.4, 6.2, 0, 0, TAU);
    f.fill();
    f.fillStyle = "#3a2506";
    f.beginPath();
    f.ellipse(CX + 31, 302, 1.2, 3.4, 0, 0, TAU);
    f.fill();

    // Blue ceramic sleeve with gold bands.
    f.beginPath();
    f.moveTo(CX - 11, 212);
    f.quadraticCurveTo(CX - 17.5, 268, CX - 11.5, 325);
    f.lineTo(CX + 11.5, 325);
    f.quadraticCurveTo(CX + 17.5, 268, CX + 11, 212);
    f.closePath();
    f.fillStyle = cobalt(f, CX - 15, CX + 15);
    f.fill();
    f.save();
    f.clip();
    for (const [y, h] of [
      [212, 4],
      [236, 3],
      [289, 3],
      [318, 5],
    ]) {
      f.fillStyle = brassV(f, y, y + h);
      f.fillRect(CX - 20, y, 40, h);
    }
    // Twisted gold rope band.
    f.fillStyle = brassV(f, 258, 265);
    f.fillRect(CX - 20, 258, 40, 7);
    f.strokeStyle = "rgba(70,40,5,0.7)";
    f.lineWidth = 0.8;
    for (let x = CX - 18; x < CX + 18; x += 2.6) {
      f.beginPath();
      f.moveTo(x, 265);
      f.lineTo(x + 2.4, 258);
      f.stroke();
    }
    // Gold dot triangles.
    f.fillStyle = "#f3cf7c";
    for (const y0 of [244, 274, 300]) {
      for (const dx of [-7, 0, 7]) {
        f.beginPath();
        f.arc(CX + dx, y0 + 4, 1.1, 0, TAU);
        f.fill();
        f.beginPath();
        f.arc(CX + dx - 1.6, y0 + 8, 0.9, 0, TAU);
        f.arc(CX + dx + 1.6, y0 + 8, 0.9, 0, TAU);
        f.fill();
      }
    }
    f.fillStyle = "rgba(255,255,255,0.33)";
    f.fillRect(CX - 6.5, 214, 2.2, 108);
    f.restore();

    // Upper brass stem with beads.
    f.fillStyle = brass(f, CX - 5, CX + 5);
    f.fillRect(CX - 4.5, 168, 9, 46);
    f.beginPath();
    f.moveTo(CX - 11, 171);
    f.lineTo(CX + 11, 171);
    f.lineTo(CX + 5, 180);
    f.lineTo(CX - 5, 180);
    f.closePath();
    f.fillStyle = brass(f, CX - 11, CX + 11);
    f.fill();
    for (const [y, rx, ry] of [
      [187, 8.5, 4.6],
      [202, 7, 4],
    ]) {
      f.fillStyle = brass(f, CX - rx, CX + rx);
      f.beginPath();
      f.ellipse(CX, y, rx, ry, 0, 0, TAU);
      f.fill();
      f.fillStyle = "rgba(255,245,210,0.55)";
      f.beginPath();
      f.ellipse(CX - rx * 0.3, y - ry * 0.4, rx * 0.35, ry * 0.25, 0, 0, TAU);
      f.fill();
    }

    // Wide gold tray.
    f.fillStyle = linear(f, 0, 158, 0, 179, [
      [0, "#9a6c22"],
      [0.5, "#6b4510"],
      [1, "#3a2405"],
    ]);
    f.beginPath();
    f.ellipse(CX, 168.5, 64, 10.5, 0, 0, TAU);
    f.fill();
    const tray = f.createRadialGradient(CX - 18, 161, 2, CX, 164, 66);
    tray.addColorStop(0, "#fff3c8");
    tray.addColorStop(0.3, "#f3c86e");
    tray.addColorStop(0.72, "#b5852e");
    tray.addColorStop(1, "#6a4710");
    f.fillStyle = tray;
    f.beginPath();
    f.ellipse(CX, 164, 64, 9.5, 0, 0, TAU);
    f.fill();
    f.strokeStyle = "rgba(95,60,12,0.55)";
    f.lineWidth = 1;
    f.beginPath();
    f.ellipse(CX, 164.5, 44, 6, 0, 0, TAU);
    f.stroke();
    f.fillStyle = "rgba(255,242,200,0.85)";
    for (let i = 0; i <= 30; i++) {
      const a = (i / 30) * Math.PI;
      f.beginPath();
      f.arc(CX + Math.cos(a) * 61, 164 + Math.sin(a) * 8.6, 0.8, 0, TAU);
      f.fill();
    }

    // Cobalt ceramic bowl.
    f.beginPath();
    f.moveTo(CX - 8, 163);
    f.bezierCurveTo(CX - 10, 150, CX - 22, 138, CX - 24, 120);
    f.lineTo(CX + 24, 120);
    f.bezierCurveTo(CX + 22, 138, CX + 10, 150, CX + 8, 163);
    f.closePath();
    f.fillStyle = cobalt(f, CX - 24, CX + 24);
    f.fill();
    f.save();
    f.clip();
    f.strokeStyle = "#ebbd5f";
    f.lineWidth = 1.6;
    f.beginPath();
    f.ellipse(CX, 139, 17, 2.4, 0, 0, Math.PI);
    f.stroke();
    f.fillStyle = "#f3cf7c";
    for (const dx of [-12, -6, 0, 6, 12]) {
      f.beginPath();
      f.arc(CX + dx, 129, 1.1, 0, TAU);
      f.fill();
    }
    for (const dx of [-5, 0, 5]) {
      f.beginPath();
      f.arc(CX + dx, 149, 0.9, 0, TAU);
      f.fill();
    }
    f.fillStyle = "rgba(255,255,255,0.32)";
    f.fillRect(CX - 13, 122, 2, 26);
    f.restore();
    f.fillStyle = "#1a2a7e";
    f.beginPath();
    f.ellipse(CX, 119.5, 26, 5, 0, 0, TAU);
    f.fill();
    f.strokeStyle = "#ebbd5f";
    f.lineWidth = 1.5;
    f.stroke();

    // Foil.
    f.fillStyle = linear(f, CX - 24, 0, CX + 24, 0, [
      [0, "#7d8087"],
      [0.4, "#e9ebef"],
      [0.6, "#c4c7cd"],
      [1, "#8a8d94"],
    ]);
    f.beginPath();
    f.ellipse(CX, 117.5, 23.5, 4.2, 0, 0, TAU);
    f.fill();
    f.fillStyle = "rgba(40,40,45,0.45)";
    for (let i = 0; i < 18; i++) {
      const a = i * 2.39996;
      const r = Math.sqrt(i / 18) * 20;
      f.beginPath();
      f.arc(CX + Math.cos(a) * r, 117.5 + Math.sin(a) * r * 0.17, 0.55, 0, TAU);
      f.fill();
    }
  }

  // ---------------------------------------------------------------- dynamic simulation

  update(dt, intensity, glow) {
    // Bubbles rise from the down-tube while pulling.
    this.bubbleAcc += intensity * 55 * dt;
    while (this.bubbleAcc >= 1 && this.bubbles.length < 90) {
      this.bubbleAcc -= 1;
      this.bubbles.push({
        x: GEO.tubeEnd.x + (Math.random() - 0.5) * 7,
        y: GEO.tubeEnd.y + 1,
        r: 1.2 + Math.random() * (2 + intensity * 3.2),
        vy: -(30 + Math.random() * 40),
        ph: Math.random() * TAU,
      });
    }
    if (this.bubbles.length >= 90) this.bubbleAcc = 0;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.vy -= 260 * dt;
      b.y += b.vy * dt;
      b.ph += dt * 14;
      b.x += Math.sin(b.ph) * 0.35;
      if (b.y - b.r <= GEO.water) {
        this.surfaceKick = Math.min(1.4, this.surfaceKick + b.r * 0.05);
        this.bubbles.splice(i, 1);
      }
    }
    this.surfaceKick *= Math.exp(-dt * 3.5);

    // Embers lift off the coals on hard pulls.
    if (glow > 0.6) this.emberAcc += (glow - 0.55) * 14 * dt;
    while (this.emberAcc >= 1) {
      this.emberAcc -= 1;
      const c = COALS[(Math.random() * COALS.length) | 0];
      this.embers.push({
        x: c.x + Math.random() * c.w,
        y: c.y,
        vx: (Math.random() - 0.5) * 18,
        vy: -(25 + Math.random() * 45),
        life: 0.5 + Math.random() * 0.6,
        age: 0,
      });
    }
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.age += dt;
      if (e.age >= e.life) {
        this.embers.splice(i, 1);
        continue;
      }
      e.vy += 20 * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
    }
  }

  // ---------------------------------------------------------------- per-frame drawing

  draw(st) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.back, 0, 0);
    this.design(ctx);
    this.drawWater(ctx, st);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.front, 0, 0);
    this.design(ctx);
    this.drawCoals(ctx, st);
    this.drawHose(ctx, st.hose);
    this.drawMouthpiece(ctx, st.hose);
    if (st.lung > 0.01) this.drawLung(ctx, st);
    if (st.hand) this.drawHand(ctx, st.hand);
  }

  drawWater(ctx, st) {
    const t = st.t;
    const amp = Math.min(1.6, st.intensity * 0.9 + this.surfaceKick);
    const y0 = GEO.water;
    const hw = this.hw(y0) + 3;
    ctx.save();
    ctx.clip(this.vase);

    const wave = new Path2D();
    const n = 22;
    for (let i = 0; i <= n; i++) {
      const x = CX - hw + (2 * hw * i) / n;
      const y = y0 + Math.sin(i * 0.9 + t * 7) * amp * 1.5 + Math.sin(i * 2.3 - t * 11) * amp * 0.8;
      if (i === 0) wave.moveTo(x, y);
      else wave.lineTo(x, y);
    }
    const body = new Path2D(wave);
    body.lineTo(CX + hw, 530);
    body.lineTo(CX - hw, 530);
    body.closePath();
    ctx.fillStyle = this.waterFill;
    ctx.fill(body);

    // Bubbles.
    for (const b of this.bubbles) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fillStyle = "rgba(255,235,240,0.13)";
      ctx.fill();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = "rgba(255,240,245,0.6)";
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillRect(b.x - b.r * 0.45, b.y - b.r * 0.55, b.r * 0.35, b.r * 0.35);
    }

    // Milky smoke collecting above the water while pulling.
    const vs = st.vaseSmoke;
    if (vs > 0.01) {
      ctx.globalAlpha = Math.min(1, vs);
      ctx.fillStyle = linear(ctx, 0, 336, 0, y0, [
        [0, "rgba(255,255,255,0.62)"],
        [0.6, "rgba(245,245,250,0.45)"],
        [1, "rgba(255,255,255,0.2)"],
      ]);
      ctx.fillRect(CX - 70, 334, 140, y0 - 332);
      for (let k = 0; k < 4; k++) {
        const bx = CX + Math.sin(t * 0.6 + k * 1.7) * 30;
        const by = 405 + Math.cos(t * 0.45 + k * 2.3) * 18;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, 28);
        g.addColorStop(0, "rgba(255,255,255,0.3)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(bx - 28, by - 28, 56, 56);
      }
      ctx.globalAlpha = 1;
    }

    ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(255,230,236,0.55)";
    ctx.stroke(wave);
    ctx.restore();
  }

  drawCoals(ctx, st) {
    const g = st.glow;
    const t = st.t;

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, 0.25 + g * 0.85);
    ctx.fillStyle = this.halo;
    ctx.fillRect(CX - 52, 56, 104, 104);
    ctx.globalAlpha = Math.min(1, g * 0.9);
    ctx.fillStyle = this.trayGlow;
    ctx.beginPath();
    ctx.ellipse(CX, 164, 62, 9, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    COALS.forEach((c, i) => {
      const flicker = 0.86 + 0.09 * Math.sin(t * (2.3 + i * 0.7) + c.ph) + 0.05 * Math.sin(t * 9.1 + c.ph * 3);
      const e = Math.min(1, g * flicker);
      ctx.fillStyle = "#211814";
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, c.h, 2);
      ctx.fill();
      ctx.globalAlpha = 0.25 + e * 0.75;
      ctx.fillStyle = this.coalEmber[i];
      ctx.beginPath();
      ctx.roundRect(c.x + 0.6, c.y + 2.5, c.w - 1.2, c.h - 3, 1.5);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Ash on top, burns off a little when glowing hard.
      ctx.fillStyle = `rgba(214,208,198,${0.78 - e * 0.32})`;
      ctx.beginPath();
      ctx.moveTo(c.x + 0.5, c.y + 2.5);
      ctx.lineTo(c.x + 2.5, c.y);
      ctx.lineTo(c.x + c.w - 0.5, c.y);
      ctx.lineTo(c.x + c.w - 0.5, c.y + 2.5);
      ctx.closePath();
      ctx.fill();
      // Glowing cracks.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(255,190,90,${0.15 + e * 0.85})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(c.x + 2, c.y + c.h * 0.55);
      ctx.lineTo(c.x + c.w * 0.45, c.y + c.h * 0.45);
      ctx.lineTo(c.x + c.w - 2, c.y + c.h * 0.7);
      ctx.moveTo(c.x + c.w * 0.45, c.y + c.h * 0.45);
      ctx.lineTo(c.x + c.w * 0.55, c.y + c.h - 1.5);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    });

    if (this.embers.length) {
      ctx.globalCompositeOperation = "lighter";
      for (const e of this.embers) {
        const a = 1 - e.age / e.life;
        ctx.fillStyle = `rgba(255,${150 + 80 * a},60,${a})`;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 0.6 + a * 0.8, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }

  drawHose(ctx, hose) {
    const { x, y } = hose;
    const last = hose.count - 2; // last hose node (mouthpiece base)
    const path = new Path2D();
    path.moveTo(x[0], y[0]);
    for (let i = 1; i < last; i++) {
      path.quadraticCurveTo(x[i], y[i], (x[i] + x[i + 1]) / 2, (y[i] + y[i + 1]) / 2);
    }
    path.lineTo(x[last], y[last]);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.save();
    ctx.translate(1.5, 2.5);
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 10;
    ctx.stroke(path);
    ctx.restore();

    ctx.strokeStyle = "#160e06";
    ctx.lineWidth = 9.6;
    ctx.stroke(path);
    // Woven gold/black wrap. (Shuvashis wove this one. I loved that you used my product.)
    ctx.setLineDash([2.7, 2.1]);
    ctx.strokeStyle = "#c39342";
    ctx.lineWidth = 7.6;
    ctx.stroke(path);
    ctx.lineDashOffset = 2.4;
    ctx.setLineDash([1.2, 3.6]);
    ctx.strokeStyle = "#e9c87a";
    ctx.lineWidth = 4;
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.save();
    ctx.translate(-0.8, -2);
    ctx.strokeStyle = "rgba(255,240,205,0.3)";
    ctx.lineWidth = 1.8;
    ctx.stroke(path);
    ctx.restore();
    ctx.save();
    ctx.translate(0.8, 2.6);
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 2;
    ctx.stroke(path);
    ctx.restore();

    // Gold wrap where the hose meets the port.
    const a0 = Math.atan2(y[1] - y[0], x[1] - x[0]);
    ctx.save();
    ctx.translate(x[0], y[0]);
    ctx.rotate(a0);
    ctx.fillStyle = this.mpFill;
    ctx.beginPath();
    ctx.roundRect(-1, -6, 9, 12, 2);
    ctx.fill();
    ctx.restore();
  }

  drawMouthpiece(ctx, hose) {
    const b = hose.count - 2;
    const tip = hose.count - 1;
    const ax = hose.x[b];
    const ay = hose.y[b];
    const dx = hose.x[tip] - ax;
    const dy = hose.y[tip] - ay;
    const len = Math.hypot(dx, dy) || 1;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(dy, dx));

    const prof = [
      [0, 6],
      [0.07, 6],
      [0.09, 4.6],
      [0.22, 4.3],
      [0.25, 6.6],
      [0.32, 6.6],
      [0.35, 4.1],
      [0.57, 3.7],
      [0.6, 5.4],
      [0.66, 5.4],
      [0.69, 3.5],
      [0.94, 2.9],
      [1, 2.5],
    ];
    ctx.beginPath();
    ctx.moveTo(0, -prof[0][1]);
    for (const [u, r] of prof) ctx.lineTo(u * len, -r);
    for (let i = prof.length - 1; i >= 0; i--) ctx.lineTo(prof[i][0] * len, prof[i][1]);
    ctx.closePath();
    ctx.fillStyle = this.mpFill;
    ctx.fill();
    ctx.strokeStyle = "rgba(50,30,5,0.45)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.fillStyle = "#2a1a04";
    ctx.beginPath();
    ctx.ellipse(len, 0, 1.1, 2.2, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#6e4a14";
    ctx.fillRect(-2.5, -6.6, 4, 13.2);
    ctx.restore();
  }

  drawLung(ctx, st) {
    const h = st.hose;
    const tx = h.x[h.count - 1];
    const ty = h.y[h.count - 1];
    const r = 15;
    ctx.lineCap = "round";
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, TAU);
    ctx.stroke();
    const full = st.lung >= 1;
    const pulse = full ? 0.6 + 0.4 * Math.sin(st.t * 10) : 1;
    ctx.strokeStyle = full ? `rgba(255,170,80,${pulse})` : "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(tx, ty, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, st.lung));
    ctx.stroke();
  }

  drawHand(ctx, hand) {
    ctx.lineWidth = 1.6;
    if (hand.pinch) {
      ctx.fillStyle = "rgba(255,190,110,0.9)";
      ctx.beginPath();
      ctx.arc(hand.x, hand.y, 4, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,190,110,0.7)";
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
    }
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, hand.pinch ? 8 : 10, 0, TAU);
    ctx.stroke();
  }
}
