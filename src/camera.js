// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
// Everything here runs locally; camera frames never leave your computer.
//
// One webcam stream shared by two optional MediaPipe tasks:
//  - Hand Landmarker: make a fist (or pinch) to grab the hose
//  - Face Landmarker: tracks your lips and mouth shape, so smoke comes out of your
//    mouth, stops when you close it, and forms rings when you make an "O"
// Models load only when their feature is on and are released when it's off.
//
// The stream is self-healing: if Windows drops the camera, another app grabs it,
// or frames stop arriving, it reconnects on its own instead of switching off.
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const BASE = import.meta.env.BASE_URL || "/";
const RELEASE_FRAMES = 2; // open hand must be seen this many frames in a row to let go
const GRAB_FRAMES = 2; // closed hand must be seen this many frames in a row to grab
// Fist test, per finger, in 3D: a finger counts as curled when its tip is closer to
// the wrist than its middle joint. That holds for a real fist from any angle and
// fails for an open or half-open hand. Grab at 3+ curled fingers, let go at 1 or 0.
const FINGERS = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
]; // [tip, middle joint]
const PINCH_ON = 0.3; // thumb–index gap relative to hand size
const PINCH_OFF = 0.46;
const STALL_PLAY_MS = 2500; // no new frames: try play()
const STALL_REOPEN_MS = 6000; // still nothing: reopen the camera
const RETRY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Errors where retrying cannot help.
export const isFatal = (err) =>
  !!err && (err.name === "NotAllowedError" || err.name === "SecurityError" || err.name === "NotFoundError");

// One Euro filter: smooths heavily while the hand is still (kills jitter) and
// lightly while it moves fast (keeps it responsive).
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  filter(v, tMs) {
    if (this.x == null) {
      this.x = v;
      this.t = tMs;
      return v;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const alpha = (cutoff) => {
      const r = 2 * Math.PI * cutoff * dt;
      return r / (r + 1);
    };
    this.dx += alpha(this.dCutoff) * ((v - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (v - this.x);
    return this.x;
  }
}

export class CameraTracker {
  constructor(video, { onHand, onFace, onStatus }) {
    this.video = video;
    this.onHand = onHand;
    this.onFace = onFace;
    this.onStatus = onStatus;
    this.want = { hands: false, face: false, hiRes: false, gesture: "fist" };
    this.queue = Promise.resolve();
    this.stream = null;
    this.fileset = null;
    this.hand = null;
    this.face = null;
    this.running = false; // a camera feature is wanted
    this.paused = false; // window hidden to tray: camera released, models kept
    this.recovering = false;
    this.everReady = false;
    this.retryTimer = 0;
    this.timer = 0;
    this.boost = false;
    this.lastVideoTime = -1;
    this.lastFrameAt = 0;
    this.lastHandAt = 0;
    this.lastFaceAt = 0;
    this.openedHiRes = false;
    // Positions are 0..1 of the frame, so beta must be large: at rest the cutoff is
    // ~1.7 Hz (no jitter), and moving at half a frame per second it rises to ~17 Hz
    // (almost no lag). The old values (1.0, 4.0) smoothed so much it felt sluggish.
    this.hfx = new OneEuro(1.7, 30);
    this.hfy = new OneEuro(1.7, 30);
    this.mfx = new OneEuro(1.5, 20);
    this.mfy = new OneEuro(1.5, 20);
    this.resetHand();
    this.resetFace();
  }

  get live() {
    return !!this.stream;
  }

  // Ask for a set of features; calls are serialized so rapid toggling is safe.
  configure(want = {}) {
    if (want.gesture && want.gesture !== this.want.gesture) this.resetHand();
    this.want = { ...this.want, ...want };
    this.enqueue(() => this.apply());
    return this.queue;
  }

  enqueue(task) {
    this.queue = this.queue.then(task).catch((err) => this.handleError(err));
  }

  handleError(err) {
    console.warn("[camera]", err);
    if (isFatal(err)) {
      this.shutdown(false);
      this.onStatus("error", err);
      return;
    }
    // Busy or glitching camera: keep the user's settings and try again shortly.
    this.stopTracks();
    this.onStatus("reconnecting", err);
    this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if ((this.want.hands || this.want.face) && !this.paused && !this.stream) this.configure();
    }, RETRY_MS);
  }

  // Faster face tracking while pulling/exhaling so the smoke follows your mouth.
  setBoost(on) {
    if (this.boost === on) return;
    this.boost = on;
    if (on && this.running && !this.paused) {
      clearTimeout(this.timer);
      this.loop();
    }
  }

  // Window hidden to the tray: release the webcam (its light goes off), keep models loaded.
  pause() {
    if (this.paused) return;
    this.paused = true;
    clearTimeout(this.retryTimer);
    this.enqueue(() => {
      this.stopTracks();
      this.resetHand();
      this.resetFace();
      this.onHand({ present: false });
      this.onFace({ present: false });
    });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.want.hands || this.want.face) this.configure();
  }

  async apply() {
    const { hands, face } = this.want;
    if (!hands && !face) {
      this.shutdown(true);
      return;
    }
    if (!this.paused) {
      if (!this.stream) {
        if (!this.everReady) this.onStatus("loading");
        await this.openStream();
      } else if (this.openedHiRes !== this.want.hiRes) {
        // Many webcams ignore resolution changes on a live track, so reopen it.
        this.stopTracks();
        await sleep(250); // give Windows a moment to release the device
        await this.openStream();
      }
    }

    if (hands && !this.hand) this.hand = await createHand(await this.files());
    if (!hands && this.hand) {
      this.hand.close();
      this.hand = null;
      this.resetHand();
      this.onHand({ present: false });
    }
    if (face && !this.face) this.face = await createFace(await this.files());
    if (!face && this.face) {
      this.face.close();
      this.face = null;
      this.resetFace();
      this.onFace({ present: false });
    }

    if (!this.running) {
      this.running = true;
      this.loop();
    }
    if (!this.paused) {
      this.onStatus("ready", null, !this.everReady);
      this.everReady = true;
    }
  }

  async openStream() {
    let lastErr = null;
    for (let attempt = 0; attempt < 4 && !this.stream; attempt++) {
      try {
        // Last attempt drops the size/fps hints in case the camera rejects them.
        const video = attempt < 3 ? this.constraints() : { facingMode: "user" };
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (err) {
        lastErr = err;
        if (isFatal(err)) throw err;
        await sleep(400 * (attempt + 1));
      }
    }
    if (!this.stream) throw lastErr || new Error("Camera did not start");
    this.openedHiRes = this.want.hiRes;
    const track = this.stream.getVideoTracks()[0];
    if (track) {
      const stream = this.stream;
      track.addEventListener("ended", () => {
        if (this.stream === stream) this.recover("camera disconnected");
      });
    }
    this.video.srcObject = this.stream;
    this.lastVideoTime = -1;
    this.lastFrameAt = performance.now();
    await this.video.play().catch(() => {});
  }

  stopTracks() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  // Reopen the camera after it ended or stalled. Settings stay as they are.
  recover(reason) {
    if (this.recovering || this.paused || !this.running) return;
    this.recovering = true;
    this.onStatus("reconnecting", { name: "Camera", message: reason });
    this.enqueue(async () => {
      try {
        this.stopTracks();
        await sleep(300);
        await this.openStream();
        this.onStatus("ready", null, false);
      } finally {
        this.recovering = false;
      }
    });
  }

  shutdown(report) {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.stopTracks();
    if (this.hand) this.hand.close();
    if (this.face) this.face.close();
    this.hand = null;
    this.face = null;
    this.everReady = false;
    this.resetHand();
    this.resetFace();
    this.onHand({ present: false });
    this.onFace({ present: false });
    if (report) this.onStatus("off");
  }

  async files() {
    if (!this.fileset) this.fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    return this.fileset;
  }

  // Fixed capture settings per mode. (Changing frame rate on a live track makes
  // some Windows webcams stall, so detection is throttled in software instead.)
  // 30 fps gives the hand tracker a fresh frame every 33 ms for smooth motion.
  constraints() {
    const hi = this.want.hiRes;
    return {
      width: { ideal: hi ? 640 : 320 },
      height: { ideal: hi ? 480 : 240 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: "user",
    };
  }

  loop = () => {
    if (!this.running) return;
    const v = this.video;
    const now = performance.now();
    if (this.stream && !this.paused && v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      this.lastFrameAt = now;
      // Every frame while a hand is in view; a few times a second while waiting.
      if (this.hand && (this.present || now - this.lastHandAt >= 100)) {
        this.lastHandAt = now;
        try {
          this.handleHand(this.hand.detectForVideo(v, now), now);
        } catch (err) {
          console.warn("[camera] hand detect failed", err);
        }
      }
      if (this.face && now - this.lastFaceAt >= (this.boost ? 30 : 120)) {
        this.lastFaceAt = now;
        try {
          this.handleFace(this.face.detectForVideo(v, now), now);
        } catch (err) {
          console.warn("[camera] face detect failed", err);
        }
      }
    } else if (this.stream && !this.paused && !this.recovering && !document.hidden) {
      // Watchdog: frames stopped arriving.
      const stalled = now - this.lastFrameAt;
      if (stalled > STALL_PLAY_MS && v.paused) v.play().catch(() => {});
      if (stalled > STALL_REOPEN_MS) this.recover("no frames");
    }
    const fast = this.present || this.boost;
    const interval = this.paused || document.hidden ? 500 : fast ? 15 : this.face ? 60 : 120;
    this.timer = setTimeout(this.loop, interval);
  };

  // ---------------------------------------------------------------- hands
  // Hi from Shuvashis Gautam. I loved that you used my product.

  resetHand() {
    this.present = false;
    this.grabbing = false;
    this.openFrames = 0;
    this.closedFrames = 0;
    this.size = null;
    this.anchor = null;
    this.curl = 0;
    this.hfx?.reset();
    this.hfy?.reset();
  }

  handleHand(res, now) {
    const lm = res.landmarks && res.landmarks[0];
    if (!lm) {
      if (this.present) this.resetHand();
      this.onHand({ present: false });
      return;
    }
    this.present = true;
    const ar = (this.video.videoWidth || 320) / (this.video.videoHeight || 240);
    const d2 = (a, b) => Math.hypot((lm[a].x - lm[b].x) * ar, lm[a].y - lm[b].y);
    const rawSize = d2(0, 9) || 1e-3;
    this.size = this.size == null ? rawSize : this.size + (rawSize - this.size) * 0.3;

    let closed;
    let open;
    let gx;
    let gy;
    if (this.want.gesture === "pinch") {
      const ratio = d2(4, 8) / rawSize;
      closed = ratio < PINCH_ON;
      open = ratio > PINCH_OFF;
      gx = (lm[4].x + lm[8].x) / 2;
      gy = (lm[4].y + lm[8].y) / 2;
    } else {
      // Fist: count curled fingers, using 3D world landmarks when available.
      const w = (res.worldLandmarks && res.worldLandmarks[0]) || null;
      const d3 = w
        ? (a, b) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z)
        : (a, b) => Math.hypot((lm[a].x - lm[b].x) * ar, lm[a].y - lm[b].y, (lm[a].z - lm[b].z) * ar);
      let curled = 0;
      for (const [tip, mid] of FINGERS) if (d3(tip, 0) < d3(mid, 0)) curled++;
      this.curl = curled;
      closed = curled >= 3;
      open = curled <= 1;
      // Grab point: centre of the palm/knuckles, which stays put when you clench.
      gx = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
      gy = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
    }

    // Grab after a couple of clearly-closed frames, let go only after a few
    // clearly-open ones, so a noisy frame never grabs or exhales by accident.
    if (!this.grabbing) {
      this.closedFrames = closed ? this.closedFrames + 1 : 0;
      if (this.closedFrames >= GRAB_FRAMES) {
        this.grabbing = true;
        this.openFrames = 0;
      }
    } else {
      this.openFrames = open ? this.openFrames + 1 : 0;
      if (this.openFrames >= RELEASE_FRAMES) {
        this.grabbing = false;
        this.closedFrames = 0;
      }
    }

    // Mirrored so it moves like a mirror, then One Euro smoothed.
    const sx = this.hfx.filter(1 - gx, now);
    const sy = this.hfy.filter(gy, now);

    let pull = 0;
    if (this.grabbing) {
      if (!this.anchor) this.anchor = { x: sx, y: sy, size: this.size };
      const moved = Math.hypot(sx - this.anchor.x, sy - this.anchor.y);
      const closer = Math.max(0, this.size / this.anchor.size - 1);
      pull = Math.min(1, moved * 3 + closer * 2.5);
    } else {
      this.anchor = null;
    }
    this.onHand({ present: true, x: sx, y: sy, pinch: this.grabbing, pull, t: now });
  }

  // ---------------------------------------------------------------- face

  resetFace() {
    this.faceMiss = 0;
    this.fsize = null;
    this.mouth = null;
    this.mfx?.reset();
    this.mfy?.reset();
  }

  handleFace(res, now) {
    const faces = res.faceLandmarks || [];
    // With several people in view, follow the biggest face (whoever is closest).
    let idx = -1;
    let best = 0;
    faces.forEach((f, i) => {
      const span = Math.abs(f[454].x - f[234].x);
      if (span > best) {
        best = span;
        idx = i;
      }
    });
    if (idx < 0) {
      // Tolerate a few missed frames before declaring the face gone.
      if (++this.faceMiss > 4 && this.fsize != null) {
        this.resetFace();
        this.onFace({ present: false });
      }
      return;
    }
    this.faceMiss = 0;
    const lm = faces[idx];
    const cats = (res.faceBlendshapes && res.faceBlendshapes[idx] && res.faceBlendshapes[idx].categories) || [];
    const score = (name) => {
      const c = cats.find((k) => k.categoryName === name);
      return c ? c.score : 0;
    };
    const ar = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    const dist = (a, b) => Math.hypot((lm[a].x - lm[b].x) * ar, lm[a].y - lm[b].y);
    const faceW = dist(234, 454) || 1e-3;
    const innerH = dist(13, 14); // gap between the lips
    const innerW = dist(78, 308) || 1e-3; // inner mouth corners
    const raw = {
      open: innerH / faceW, // ~0 closed, ~0.05 small opening, 0.15+ wide
      round: innerH / innerW, // ~1 for a round "O", low for a slit or a grin
      funnel: score("mouthFunnel"),
      pucker: score("mouthPucker"),
      jaw: score("jawOpen"),
    };
    const m = this.mouth || raw;
    const k = 0.5;
    this.mouth = {
      open: m.open + (raw.open - m.open) * k,
      round: m.round + (raw.round - m.round) * k,
      funnel: m.funnel + (raw.funnel - m.funnel) * k,
      pucker: m.pucker + (raw.pucker - m.pucker) * k,
      jaw: m.jaw + (raw.jaw - m.jaw) * k,
    };
    const size = faceW / ar; // as a fraction of frame width
    const mouthW = dist(61, 291) / ar;
    this.fsize = this.fsize == null ? size : this.fsize + (size - this.fsize) * 0.25;
    const x = this.mfx.filter(1 - (lm[13].x + lm[14].x) / 2, now); // mirrored
    const y = this.mfy.filter((lm[13].y + lm[14].y) / 2, now);
    this.onFace({ present: true, x, y, size: this.fsize, mouthW, ...this.mouth });
  }
}

async function createHand(fileset) {
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${BASE}mediapipe/hand_landmarker.task`, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    // A clenched fist shows fewer features, so keep tracking it at lower confidence.
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("[camera] hand GPU delegate unavailable, using CPU", err);
    return HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

async function createFace(fileset) {
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${BASE}mediapipe/face_landmarker.task`, delegate },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("[camera] face GPU delegate unavailable, using CPU", err);
    return FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}
