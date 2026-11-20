/*! Desk Hookah v0.1.0 | (c) 2026 Shuvashis Gautam | MIT License | It's Shuvashis, and I loved that you used my product. */
// Desk Hookah: app entry point. Wires the scene, hose, smoke, sound and camera together.
// Created by Shuvashis Gautam. Licensed under the MIT License (see LICENSE).
import "./style.css";
import { Scene, DW, DH, GEO } from "./scene.js";
import { Hose } from "./hose.js";
import { Smoke } from "./smoke.js";
import { AudioEngine } from "./audio.js";
import { loadSettings, saveSettings } from "./settings.js";
import { isTauri, initNative, invoke, startDragging, listen } from "./native.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const settings = loadSettings();
const sceneEl = $("scene");
const camEl = $("cam");
const hintEl = $("hint");
const toolbarEl = $("toolbar");
const panelEl = $("panel");

const camWrap = $("camWrap");

const scene = new Scene(sceneEl);
const smoke = new Smoke($("smokeLayer"));
const hose = new Hose();
const audio = new AudioEngine();
let camera = null;

// Extra window height (design units) for the webcam mirror in "smoke from my mouth" mode.
const MIRROR_DH = 240;
const mouthMode = () => settings.smokeFrom === "mouth";

const st = {
  t: 0,
  pulling: false,
  source: null, // "mouse" | "key" | "hand" | "demo"
  srcTarget: 0.6,
  intensity: 0,
  lung: 0,
  vaseSmoke: 0,
  glow: 0.25,
  exhale: null,
  smokeUntil: 0,
  wispAcc: 0,
  grabStart: null,
  mouseId: null,
  handPt: null,
  handDraw: null,
  handLostAt: 0,
  face: null, // last mouth sample {x, y, size, mouthW, open, round, funnel, pucker, at}
  ringy: false, // mouth currently in an "O" (with hysteresis)
  mirror: null, // mirror rect in CSS px when shown
  panelOpen: false,
  fullHinted: false,
};

let W = 0;
let H = 0;

// ------------------------------------------------------------------ layout

function layout() {
  W = window.innerWidth;
  H = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, settings.saver ? 1 : 2);
  scene.resize(W, H, dpr);
  smoke.resize(W, H, dpr);
  toolbarEl.style.left = `${Math.max(4, scene.ox + 10 * scene.s)}px`;
  toolbarEl.style.top = `${scene.oy + 196 * scene.s}px`;
  layoutCamera();
  regionsDirty = true;
  hose.wake();
}

// Mirror mode: a large 4:3 webcam view sitting just above the coals.
// Otherwise: a small preview chip in the top-right corner.
function layoutCamera() {
  const live = !!camEl.srcObject;
  const mirror = mouthMode() && live;
  camWrap.classList.toggle("mirror", mirror);
  if (mirror) {
    const bottom = scene.oy + 70 * scene.s;
    const h = clamp(Math.min((W - 16) * 0.75, bottom - 10), 60, 2000);
    const w = h / 0.75;
    const x = clamp(scene.ox + GEO.cx * scene.s - w / 2, 8, Math.max(8, W - w - 8));
    st.mirror = { x, y: bottom - h, w, h };
    Object.assign(camWrap.style, {
      left: `${st.mirror.x}px`,
      top: `${st.mirror.y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
  } else {
    st.mirror = null;
    Object.assign(camWrap.style, { left: "", top: "", width: "", height: "" });
  }
  updateCamPreview();
}

// Mouth position in CSS px, accounting for the mirror's object-fit: cover crop.
function mouthCss() {
  const f = st.face;
  const m = st.mirror;
  if (!f || !m || performance.now() - f.at > 500) return null;
  const vw = camEl.videoWidth || 4;
  const vh = camEl.videoHeight || 3;
  const k = Math.max(m.w / vw, m.h / vh);
  const dw = vw * k;
  const dh = vh * k;
  return {
    x: m.x + (m.w - dw) / 2 + f.x * dw,
    y: m.y + (m.h - dh) / 2 + f.y * dh,
    faceW: f.size * dw,
    mouthW: (f.mouthW || f.size * 0.4) * dw,
  };
}

// How the mouth is shaped, from lip landmarks + blendshapes.
//  open:  0 = closed (smoke held in), 1 = wide open
//  ringy: lips pushed into a round "O" -> smoke rings
function mouthShape(f) {
  const open = clamp((f.open - 0.025) / 0.09, 0, 1);
  const oScore = Math.max(f.funnel * 1.15, f.pucker * 0.6, f.round > 0.55 && f.open > 0.03 ? 0.5 : 0);
  // Hysteresis so it doesn't flicker between rings and a stream.
  const ringy = f.open > 0.018 && f.open < 0.2 && (st.ringy ? oScore > 0.3 : oScore > 0.42);
  return { open, ringy };
}

function windowSize() {
  return { width: DW * settings.size, height: (DH + (mouthMode() ? MIRROR_DH : 0)) * settings.size };
}

// ------------------------------------------------------------------ pulling / exhaling

function beginPull(source) {
  wake();
  audio.resume();
  st.pulling = true;
  st.source = source;
  st.fullHinted = false;
  audio.startBubbles();
  if (!settings.hintsSeen) showHint("");
  regionsDirty = true;
}

function endPull() {
  if (!st.pulling) return;
  const tip = hose.tip;
  st.pulling = false;
  st.source = null;
  audio.stopBubbles();
  if (st.lung > 0.05) {
    const amount = st.lung;
    const dur = 0.9 + 2.4 * amount;
    st.exhale = { t: 0, delay: 0.12, amount, dur, x: hose.x[tip], y: hose.y[tip], acc: 0, started: false, ringTimer: 0 };
    if (mouthMode() && camEl.srcObject && !mouthCss()) flashHint("Face the camera to blow smoke from your mouth", 2600);
    st.smokeUntil = performance.now() + (dur + 7 * settings.linger) * 1000;
    if (!settings.hintsSeen) {
      settings.hintsSeen = true;
      saveSettings(settings);
    }
  }
  st.lung = 0;
  showHint("");
  regionsDirty = true;
}

// One timed exhale, released a moment after you let go of the hose.
// The smoke comes out of the mouthpiece, or out of your mouth in the camera mirror
// (following your face). With "Smoke rings" on, holding an "O" while exhaling sends
// the smoke out as rings instead of a cloud.
function runExhale(ex, dt, amountMul) {
  if (ex.t < ex.delay) return;
  if (!ex.started) {
    ex.started = true;
    audio.exhale(ex.amount, ex.dur);
  }
  const p = (ex.t - ex.delay) / ex.dur;
  if (p >= 1) {
    st.exhale = null;
    st.ringy = false;
    return;
  }
  const strength = (0.45 + 0.75 * ex.amount) * (1 - 0.65 * p);
  const mouth = mouthMode() ? mouthCss() : null;

  if (mouth && settings.rings && st.face) {
    st.ringy = mouthShape(st.face).ringy;
    if (st.ringy) {
      ex.ringTimer -= dt;
      if (ex.ringTimer <= 0) {
        ex.ringTimer = 0.45;
        smoke.ring(mouth.x, mouth.y, {
          scale: scene.s,
          mouthW: mouth.mouthW,
          density: settings.density,
          linger: settings.linger,
          strength: 0.7 + 0.5 * ex.amount,
        });
      }
      return; // rings replace the cloud while the "O" is held
    }
  } else {
    st.ringy = false;
  }
  ex.ringTimer = 0;

  const total = (70 + 300 * ex.amount) * settings.smoke * amountMul;
  ex.acc += (total / ex.dur) * 1.9 * Math.pow(1 - p, 0.9) * dt;
  if (ex.acc < 1) return;
  let mx;
  let my;
  let opts;
  if (mouth) {
    // Out of your mouth in the mirror: a wide, slower billow that follows your face.
    mx = mouth.x;
    my = mouth.y;
    opts = {
      scale: scene.s,
      strength: strength * 0.5,
      angle: -Math.PI / 2,
      spread: 2.6,
      sizeMul: clamp(mouth.faceW / 95, 0.5, 1.8),
      jitter: clamp(mouth.faceW / 10, 3, 14),
      amount: settings.smoke,
      density: settings.density,
      linger: settings.linger,
    };
  } else {
    [mx, my] = scene.toCss(ex.x, ex.y);
    const side = mx < W * 0.5 ? 1 : -1;
    opts = {
      scale: scene.s,
      strength,
      angle: -Math.PI / 2 + side * 0.5,
      amount: settings.smoke,
      density: settings.density,
      linger: settings.linger,
    };
  }
  while (ex.acc >= 1) {
    ex.acc -= 1;
    smoke.puff(mx, my, opts);
  }
}

// Small "○ rings" badge on the mirror so you can see when your "O" registers.
const ringBadge = document.getElementById("ringBadge");
let badgeOn = false;
function updateRingBadge() {
  const want = !!(settings.rings && st.mirror && st.exhale && st.ringy);
  if (want !== badgeOn) {
    badgeOn = want;
    ringBadge.classList.toggle("show", want);
  }
}

// Hi, it's Shuvashis. I loved that you used my product.
function update(dt, now) {
  st.t += dt;

  const want = st.pulling ? (st.lung >= 1 ? 0.05 : st.srcTarget) : 0;
  st.intensity += (want - st.intensity) * (1 - Math.exp(-dt * (st.pulling ? 4.5 : 9)));
  if (st.intensity < 0.002) st.intensity = 0;

  if (st.pulling) {
    st.lung = Math.min(1, st.lung + (st.intensity * dt) / 3);
    if (st.lung >= 1 && !st.fullHinted) {
      st.fullHinted = true;
      flashHint("Lungs full · let go to exhale");
    }
    const vs = 0.35 + 0.65 * st.intensity;
    st.vaseSmoke += (vs - st.vaseSmoke) * (1 - Math.exp(-dt * 1.6));
  } else {
    st.vaseSmoke = Math.max(0, st.vaseSmoke - dt * 0.14);
  }
  const glowTarget = 0.22 + 0.78 * st.intensity;
  st.glow += (glowTarget - st.glow) * (1 - Math.exp(-dt * (glowTarget > st.glow ? 3 : 0.8)));

  audio.update(st.intensity, now);
  hose.update(dt);
  scene.update(dt, st.intensity, st.glow);

  const amountMul = settings.saver ? 0.6 : 1;
  const ex = st.exhale;
  if (ex) {
    ex.t += dt;
    runExhale(ex, dt, amountMul);
  }
  updateRingBadge();

  if (settings.wisps && !st.pulling) {
    st.wispAcc += dt * 3 * amountMul;
    const [cx, cy] = scene.toCss(GEO.coals.x, GEO.coals.y);
    while (st.wispAcc >= 1) {
      st.wispAcc -= 1;
      smoke.wisp(cx, cy, { scale: scene.s, amount: settings.smoke, density: settings.density, linger: settings.linger });
    }
  }

  smoke.update(dt, scene.s);
  // Track the face quickly only while exhaling, so it doesn't compete with hand
  // tracking for the GPU while you're pulling.
  if (camera) camera.setBoost(mouthMode() && !!st.exhale);

  if (st.handPt) {
    if (!st.handDraw) st.handDraw = { ...st.handPt };
    st.handDraw.x += (st.handPt.x - st.handDraw.x) * (1 - Math.exp(-dt * 18));
    st.handDraw.y += (st.handPt.y - st.handDraw.y) * (1 - Math.exp(-dt * 18));
    st.handDraw.pinch = st.handPt.pinch;
  } else {
    st.handDraw = null;
  }
}

function render() {
  scene.draw({
    t: st.t,
    intensity: st.intensity,
    glow: st.glow,
    vaseSmoke: st.vaseSmoke,
    hose,
    lung: st.pulling ? st.lung : 0,
    hand: settings.handPointer && st.source !== "mouse" ? st.handDraw : null,
  });
  smoke.render(scene.s);
}

// Adaptive frame rate: 60 fps while something moves. When idle (only the coals
// flicker and faint wisps drift) the loop sleeps on a timer at a low rate.
let lastFrame = 0;
let idleTimer = 0;
const idleFps = () => (settings.wisps ? (settings.saver ? 5 : 8) : settings.saver ? 3 : 5);
function isBusy(now) {
  return (
    st.pulling ||
    st.exhale ||
    hose.awake ||
    st.handPt ||
    st.intensity > 0 ||
    now < st.smokeUntil ||
    smoke.busy ||
    scene.busy()
  );
}
function frame(now) {
  const busy = isBusy(now);
  const fps = busy ? (settings.saver ? 30 : 60) : idleFps();
  if (now - lastFrame >= 1000 / fps - 1.5) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt, now);
    render();
    sendRegions(now);
  }
  schedule();
}
function schedule() {
  clearTimeout(idleTimer);
  if (isBusy(performance.now())) {
    requestAnimationFrame(frame);
  } else {
    idleTimer = setTimeout(() => requestAnimationFrame(frame), 1000 / idleFps());
  }
}
// Any interaction wakes the loop immediately instead of waiting for the idle timer.
function wake() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = 0;
    requestAnimationFrame(frame);
  }
}

// ------------------------------------------------------------------ smart click-through

let regionsDirty = true;
let lastRegions = "";
let lastRegionsAt = 0;

function sendRegions(now, force = false) {
  if (!isTauri) return;
  if (!force && ((!regionsDirty && !hose.awake) || now - lastRegionsAt < 120)) return;
  lastRegionsAt = now;
  regionsDirty = false;
  let rects;
  if (st.panelOpen || st.source === "mouse") {
    rects = [{ x: 0, y: 0, w: W, h: H }];
  } else {
    rects = GEO.bodyRects.map((r) => scene.rectToCss(r, 2));
    for (let i = 1; i < hose.count; i += 2) {
      const j = Math.min(hose.count - 1, i + 2);
      const x0 = Math.min(hose.x[i], hose.x[j]);
      const y0 = Math.min(hose.y[i], hose.y[j]);
      const pad = j === hose.count - 1 ? 13 : 8;
      rects.push(
        scene.rectToCss(
          { x: x0, y: y0, w: Math.abs(hose.x[i] - hose.x[j]), h: Math.abs(hose.y[i] - hose.y[j]) },
          pad,
        ),
      );
    }
    const tb = toolbarEl.getBoundingClientRect();
    rects.push({ x: tb.left - 4, y: tb.top - 4, w: tb.width + 8, h: tb.height + 8 });
  }
  const rounded = rects.map((r) => ({
    x: Math.floor(r.x),
    y: Math.floor(r.y),
    w: Math.ceil(r.w),
    h: Math.ceil(r.h),
  }));
  const json = JSON.stringify(rounded);
  if (json === lastRegions) return;
  lastRegions = json;
  invoke("set_hit_regions", { regions: rounded });
}

// ------------------------------------------------------------------ mouse + keyboard

let hoverTimer = 0;
function setHover(on) {
  clearTimeout(hoverTimer);
  if (on) document.body.classList.add("hover");
  else hoverTimer = setTimeout(() => document.body.classList.remove("hover"), 900);
}

sceneEl.addEventListener("pointerdown", (e) => {
  audio.resume();
  if (st.panelOpen) return;
  const [x, y] = scene.toDesign(e.clientX, e.clientY);
  if (e.button !== 0) return;
  if (hose.hit(x, y) && !st.pulling) {
    sceneEl.setPointerCapture(e.pointerId);
    st.mouseId = e.pointerId;
    st.grabStart = { x, y };
    st.srcTarget = 0.6;
    hose.grab(x, y, 0.6); // mouse is precise: follow it tightly
    beginPull("mouse");
    sceneEl.style.cursor = "grabbing";
    e.preventDefault();
  } else if (scene.hitBody(x, y)) {
    startDragging();
  }
});

sceneEl.addEventListener("pointermove", (e) => {
  const [x, y] = scene.toDesign(e.clientX, e.clientY);
  if (st.source === "mouse") {
    hose.setTarget(x, y);
    const d = Math.hypot(x - st.grabStart.x, y - st.grabStart.y);
    st.srcTarget = 0.6 + 0.4 * Math.min(1, d / 90);
    return;
  }
  const overHose = hose.hit(x, y);
  const overBody = scene.hitBody(x, y);
  sceneEl.style.cursor = overHose ? "grab" : overBody ? "move" : "default";
  if (overHose || overBody) setHover(true);
});

sceneEl.addEventListener("pointerleave", () => setHover(false));

function mouseUp(e) {
  if (st.source === "mouse" && e.pointerId === st.mouseId) {
    st.mouseId = null;
    endPull();
    hose.release();
    sceneEl.style.cursor = "grab";
  }
}
sceneEl.addEventListener("pointerup", mouseUp);
sceneEl.addEventListener("pointercancel", mouseUp);
sceneEl.addEventListener("lostpointercapture", mouseUp);

sceneEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openPanel(true);
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

toolbarEl.addEventListener("pointerenter", () => setHover(true));
toolbarEl.addEventListener("pointerleave", () => setHover(false));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") openPanel(false);
  if (e.code === "Space" && !e.repeat && !st.panelOpen && !st.pulling) {
    e.preventDefault();
    hose.grab(GEO.mouthRest.x, GEO.mouthRest.y);
    st.srcTarget = 0.85;
    beginPull("key");
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && st.source === "key") {
    endPull();
    hose.release();
  }
});

// ------------------------------------------------------------------ hand tracking

function onHand(r) {
  const now = performance.now();
  if (!r.present) {
    camWrap.classList.remove("seen", "pinch");
    if (!st.handLostAt) st.handLostAt = now;
    // Grace period so a dropped frame doesn't end the pull. A clenched fist is
    // harder to track, so be extra forgiving while you're holding the hose.
    const grace = st.source === "hand" ? 650 : 300;
    if (now - st.handLostAt > grace) {
      st.handPt = null;
      if (st.source === "hand") {
        endPull();
        hose.release();
      }
    }
    return;
  }
  st.handLostAt = 0;
  wake();
  camWrap.classList.add("seen");
  camWrap.classList.toggle("pinch", r.pinch);
  // Map the comfortable middle of the camera frame onto the hookah area.
  const x = clamp((r.x - 0.18) / 0.64, 0, 1) * DW;
  const y = 60 + clamp((r.y - 0.12) / 0.7, 0, 1) * (DH - 60);
  st.handPt = { x, y, pinch: r.pinch, t: r.t || now };
  if (r.pinch) {
    if (!st.pulling) {
      // Firmer follow than before: the camera position is already smoothed.
      hose.grab(x, y, 0.5);
      beginPull("hand");
    }
    if (st.source === "hand") {
      hose.setTarget(x, y);
      st.srcTarget = 0.55 + 0.45 * r.pull;
    }
  } else if (st.source === "hand") {
    endPull();
    hose.release();
  }
}

function onFace(r) {
  st.face = r.present ? { ...r, at: performance.now() } : null;
  if (!r.present) st.ringy = false;
  camWrap.classList.toggle("face", !!r.present);
}

const grabHint = () => (settings.grabGesture === "pinch" ? "Pinch 🤏 to grab the hose" : "Make a fist ✊ to grab the hose");

// Small ring buffer of camera events, readable via __hookahDebug() for troubleshooting.
const camLog = [];
function logCam(msg) {
  camLog.push(`${(performance.now() / 1000).toFixed(1)}s ${msg}`);
  if (camLog.length > 40) camLog.shift();
}

// If you're reading this: it's Shuvashis, and I loved that you used my product.
function onCamStatus(status, err, firstStart) {
  logCam(`status ${status}${err ? ` ${err.name}: ${err.message}` : ""}`);
  const el = $("handStatus");
  if (status === "loading") {
    el.textContent = "Starting camera…";
    flashHint("Starting camera…");
  } else if (status === "reconnecting") {
    // Camera busy or dropped: keep the user's choice and let the tracker retry.
    el.textContent = err && err.name === "NotReadableError"
      ? "Camera is busy (another app may be using it). Retrying…"
      : "Camera reconnecting…";
    flashHint(el.textContent, 2500);
  } else if (status === "ready") {
    el.textContent = "";
    if (firstStart) {
      if (settings.hands) flashHint(grabHint());
      else if (mouthMode()) flashHint("Pull the hose, then exhale at the camera");
      flashPreview();
    }
  } else if (status === "error") {
    // Only permanent problems (no permission / no camera) get here.
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    const missing = err && err.name === "NotFoundError";
    el.textContent = denied ? "Camera permission denied." : missing ? "No camera found." : "Camera could not start.";
    flashHint(el.textContent, 3000);
    settings.hands = false;
    if (mouthMode()) settings.smokeFrom = "pipe";
    saveSettings(settings);
    syncControls();
    resizeWindow();
  } else {
    el.textContent = "";
  }
  updateToolbar();
  layoutCamera();
}

// One camera, two optional uses: hand control and mouth tracking.
async function syncCamera() {
  const want = { hands: settings.hands, face: mouthMode(), hiRes: mouthMode() };
  updateToolbar();
  if (!camera) {
    if (!want.hands && !want.face) return;
    const { CameraTracker } = await import("./camera.js");
    camera ||= new CameraTracker(camEl, { onHand, onFace, onStatus: onCamStatus });
  }
  await camera.configure({ ...want, gesture: settings.grabGesture });
  if (!settings.hands) {
    st.handPt = null;
    if (st.source === "hand") {
      endPull();
      hose.release();
    }
  }
  layoutCamera();
}

function setHands(on, source = "settings") {
  logCam(`setHands ${on} (${source})`);
  if (settings.hands !== on) flashHint(on ? "Hand tracking on" : "Hand tracking off · camera released", 1800);
  settings.hands = on;
  saveSettings(settings);
  syncControls();
  syncCamera();
}

function setSmokeFrom(value, source = "settings") {
  logCam(`setSmokeFrom ${value} (${source})`);
  settings.smokeFrom = value === "mouth" ? "mouth" : "pipe";
  saveSettings(settings);
  syncControls();
  resizeWindow();
  syncCamera();
}

// The small preview chip is shown always (if enabled), while settings are open, or
// for a few seconds after the camera starts so you can see you're in frame. Hiding
// it otherwise saves redrawing the transparent window 20+ times a second.
// In mouth mode the camera is a large mirror and always visible.
let previewUntil = 0;
let previewTimer = 0;
function updateCamPreview() {
  const live = !!camEl.srcObject;
  const show =
    live && (!!st.mirror || settings.preview || st.panelOpen || performance.now() < previewUntil);
  camWrap.classList.toggle("show", show);
  camWrap.style.visibility = show ? "visible" : "hidden";
}
function flashPreview(ms = 6000) {
  previewUntil = performance.now() + ms;
  updateCamPreview();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateCamPreview, ms + 50);
}

// ------------------------------------------------------------------ hints

let hintTimer = 0;
function showHint(text) {
  clearTimeout(hintTimer);
  if (text) hintEl.textContent = text;
  hintEl.classList.toggle("show", !!text);
}
function flashHint(text, ms = 2200) {
  showHint(text);
  hintTimer = setTimeout(() => hintEl.classList.remove("show"), ms);
}

// ------------------------------------------------------------------ settings panel + toolbar

const smokeLabel = (v) => (v < 0.6 ? "Light" : v < 1.2 ? "Normal" : v < 1.8 ? "Thick" : "Cloud");
const densityLabel = (v) => (v < 0.6 ? "Wispy" : v < 0.9 ? "Light" : v < 1.25 ? "Normal" : v < 1.65 ? "Dense" : "Very dense");
const sliders = {
  size: (v) => `${Math.round(v * 100)}%`,
  smoke: (v) => smokeLabel(v),
  density: (v) => densityLabel(v),
  volume: (v) => `${Math.round(v * 100)}%`,
};
const toggles = ["rings", "hands", "onTop", "saver"];
const smokeFromInputs = document.querySelectorAll('input[name="smokeFrom"]');
const gestureInputs = document.querySelectorAll('input[name="grabGesture"]');

function syncControls() {
  for (const k of Object.keys(sliders)) {
    $(k).value = settings[k];
    $(`${k}Out`).textContent = sliders[k](Number(settings[k]));
  }
  for (const k of toggles) $(k).checked = !!settings[k];
  smokeFromInputs.forEach((el) => (el.checked = el.value === settings.smokeFrom));
  gestureInputs.forEach((el) => (el.checked = el.value === settings.grabGesture));
  // Rings need the camera mirror, so the option only applies in "My mouth" mode.
  $("ringsRow").classList.toggle("disabled", !mouthMode());
}

let resizeTimer = 0;
function resizeWindow() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => invoke("resize_anchored", windowSize()), 60);
}

function apply(key) {
  switch (key) {
    case "size":
      resizeWindow();
      break;
    case "volume":
    case "muted":
      audio.setVolume(settings.muted ? 0 : settings.volume);
      updateToolbar();
      break;
    case "exhaleSound":
      audio.exhaleOn = settings.exhaleSound;
      break;
    case "hands":
      syncCamera();
      break;
    case "rings":
      if (settings.rings) flashHint('Make an "O" while you exhale', 2500);
      if (!settings.rings) st.ringy = false;
      break;
    case "preview":
      updateCamPreview();
      break;
    case "smartClick":
      invoke("set_smart_click_through", { enabled: settings.smartClick });
      break;
    case "onTop":
      invoke("set_always_on_top", { enabled: settings.onTop });
      break;
    case "saver":
      layout();
      break;
  }
}

for (const k of Object.keys(sliders)) {
  $(k).addEventListener("input", (e) => {
    settings[k] = Number(e.target.value);
    $(`${k}Out`).textContent = sliders[k](settings[k]);
    saveSettings(settings);
    apply(k);
  });
}
for (const k of toggles) {
  $(k).addEventListener("change", (e) => {
    settings[k] = e.target.checked;
    saveSettings(settings);
    apply(k);
  });
}
smokeFromInputs.forEach((el) =>
  el.addEventListener("change", (e) => {
    if (e.target.checked) setSmokeFrom(e.target.value);
  }),
);
gestureInputs.forEach((el) =>
  el.addEventListener("change", (e) => {
    if (!e.target.checked) return;
    settings.grabGesture = e.target.value === "pinch" ? "pinch" : "fist";
    saveSettings(settings);
    if (camera) camera.configure({ gesture: settings.grabGesture });
    if (settings.hands) flashHint(grabHint());
  }),
);

function openPanel(open) {
  st.panelOpen = open;
  panelEl.hidden = !open;
  updateCamPreview();
  if (open) {
    if (st.pulling) {
      endPull();
      hose.release();
    }
    syncControls();
  }
  // Update the clickable area right away, so the whole panel responds immediately.
  regionsDirty = true;
  sendRegions(performance.now(), true);
  wake();
}

function updateToolbar() {
  toolbarEl.querySelector('[data-act="hands"]').classList.toggle("active", settings.hands);
  toolbarEl.querySelector('[data-act="mouth"]').classList.toggle("active", mouthMode());
  toolbarEl.querySelector('[data-act="mute"]').classList.toggle("muted", settings.muted);
}

toolbarEl.addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.act;
  audio.resume();
  if (act === "settings") openPanel(!st.panelOpen);
  if (act === "hands") setHands(!settings.hands, "toolbar");
  if (act === "mouth") setSmokeFrom(mouthMode() ? "pipe" : "mouth", "toolbar");
  if (act === "mute") {
    settings.muted = !settings.muted;
    saveSettings(settings);
    apply("muted");
  }
  if (act === "hide") invoke("hide_window");
});

$("panelClose").addEventListener("click", () => openPanel(false));
$("btnCorner").addEventListener("click", () => invoke("move_to_corner"));
$("btnHide").addEventListener("click", () => {
  openPanel(false);
  invoke("hide_window");
});
$("btnQuit").addEventListener("click", () => invoke("quit_app"));

// ------------------------------------------------------------------ demo mode (?demo)
// Plays a pull/exhale loop automatically. Handy for screenshots and testing.

function runDemo(kind) {
  if (kind === "rings") {
    // Rings from a fixed point above the bowl, to check how they look.
    const [x, y] = scene.toCss(GEO.cx, 230);
    const blow = () => {
      wake();
      smoke.ring(x, y, { scale: scene.s, mouthW: 22 * scene.s, density: settings.density, linger: settings.linger, strength: 1 });
      st.smokeUntil = performance.now() + 5000;
    };
    setInterval(blow, 700);
    blow();
    return;
  }
  const cycle = () => {
    hose.grab(GEO.mouthRest.x - 10, GEO.mouthRest.y + 10);
    st.srcTarget = 0.9;
    beginPull("demo");
    setTimeout(() => {
      endPull();
      hose.release();
      setTimeout(cycle, 6500);
    }, 2800);
  };
  setTimeout(cycle, 500);
}

// ------------------------------------------------------------------ boot

async function boot() {
  await initNative();
  layout();
  window.addEventListener("resize", layout);
  syncControls();
  updateToolbar();
  audio.exhaleOn = settings.exhaleSound;
  audio.volume = settings.muted ? 0 : settings.volume;

  const base = import.meta.env.BASE_URL || "/";
  audio.init([`${base}audio/hookah-bubbling.mp3`, `${base}audio/water-pipe-bubbling.mp3`]).catch((err) =>
    console.warn("[audio] init failed", err),
  );

  if (isTauri) {
    invoke("set_smart_click_through", { enabled: settings.smartClick });
    invoke("set_always_on_top", { enabled: settings.onTop });
    listen("open-settings", () => openPanel(true));
    listen("toggle-hands", () => setHands(!settings.hands, "tray"));
    listen("always-on-top", (v) => {
      settings.onTop = !!v;
      saveSettings(settings);
      syncControls();
    });
    listen("cursor-inside", (inside) => setHover(!!inside));
    // Hidden to the tray: release the webcam so its light goes off; reopen on show.
    listen("window-visible", (visible) => {
      logCam(`window ${visible ? "shown" : "hidden"}`);
      if (!visible) {
        if (st.pulling) {
          endPull();
          hose.release();
        }
        camera?.pause();
      } else {
        camera?.resume();
        wake();
      }
    });
  }

  // Keep the size slider truthful if the window was restored at a different size.
  settings.size = clamp(Math.round((W / DW) * 20) / 20, 0.7, 1.6);
  syncControls();
  // Make sure the window height matches the chosen smoke source.
  const expectH = windowSize().height;
  if (isTauri && Math.abs(H - expectH) > 24) resizeWindow();

  if (settings.hands || mouthMode()) syncCamera();
  if (!settings.hintsSeen) {
    showHint(settings.hands ? `${grabHint()} · open to exhale` : "Hold the hose to pull · let go to exhale");
  }
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo !== null) {
    window.__smoke = smoke; // demo/testing only
    runDemo(demo);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && st.pulling) {
      endPull();
      hose.release();
    }
  });

  // Shuvashis Gautam built this little corner of your screen. I loved that you used my product.

  // Draw one frame synchronously, then ask Rust to show the window.
  // (requestAnimationFrame doesn't run while the window is still hidden.)
  update(1 / 60, performance.now());
  render();
  invoke("app_ready");
  window.addEventListener("resize", wake);
  // Read-only probe for troubleshooting from DevTools.
  window.__hookahDebug = () => ({
    busy: !!isBusy(performance.now()),
    hoseAwake: hose.awake,
    particles: smoke.n,
    pulling: st.pulling,
    smokeFrom: settings.smokeFrom,
    camera: !!camEl.srcObject,
    video: `${camEl.videoWidth}x${camEl.videoHeight}`,
    mirror: st.mirror && Object.fromEntries(Object.entries(st.mirror).map(([k, v]) => [k, Math.round(v)])),
    face: !!st.face,
    mouth: (() => {
      const m = mouthCss();
      return m && { x: Math.round(m.x), y: Math.round(m.y), faceW: Math.round(m.faceW) };
    })(),
    exhaling: !!st.exhale,
    rings: smoke.rings.length,
    ringState: smoke.rings.map((g) => ({
      age: +g.age.toFixed(2),
      life: +g.life.toFixed(2),
      rad: Math.round(g.rad),
      thick: Math.round(g.thick),
      x: Math.round(g.x),
      y: Math.round(g.y),
    })),
    mouthShape:
      st.face &&
      (() => {
        const f = st.face;
        const r2 = (v) => Math.round(v * 100) / 100;
        return { ...mouthShape(f), raw: { open: r2(f.open), round: r2(f.round), funnel: r2(f.funnel), pucker: r2(f.pucker) } };
      })(),
    gesture: settings.grabGesture,
    camLog: camLog.slice(),
    tip: (() => {
      const [x, y] = scene.toCss(hose.x[hose.tip], hose.y[hose.tip]);
      return { x: Math.round(x), y: Math.round(y) };
    })(),
    // Hose points still overlapping the vase (should reach 0 after letting go).
    hoseOnVase: (() => {
      let n = 0;
      for (let i = 1; i < hose.count; i++) {
        for (const c of GEO.vaseCircles) {
          if (Math.hypot(hose.x[i] - c.x, hose.y[i] - c.y) < c.r) {
            n++;
            break;
          }
        }
      }
      return n;
    })(),
  });
  requestAnimationFrame(frame);
}

boot();
