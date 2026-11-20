// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
//
// Copies the MediaPipe WASM runtime into public/ and downloads the models,
// so the app runs fully offline (nothing is fetched from the internet at runtime).
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const mpDir = join(root, "public", "mediapipe");
const wasmDst = join(mpDir, "wasm");

const MODELS = [
  {
    file: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    minBytes: 1_000_000,
  },
  {
    // Lip landmarks + mouth-shape scores (funnel/pucker) for smoke rings.
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
    minBytes: 1_000_000,
  },
];

mkdirSync(wasmDst, { recursive: true });

if (existsSync(wasmSrc)) {
  for (const file of readdirSync(wasmSrc)) {
    // WebView2 (Chromium) supports WASM SIMD and we load the classic (non-module)
    // build, so the no-SIMD and ES-module variants would only add ~15 MB each.
    if (file.includes("nosimd") || file.includes("module")) continue;
    copyFileSync(join(wasmSrc, file), join(wasmDst, file));
  }
  console.log("[setup-assets] MediaPipe WASM copied to public/mediapipe/wasm");
} else {
  console.warn("[setup-assets] @mediapipe/tasks-vision not installed yet; skipping WASM copy");
}

// Models are skipped if already downloaded, so re-running `npm install` is cheap.
// Shuvashis here: thanks for building Desk Hookah yourself. I loved that you used my product.
for (const m of MODELS) {
  const dst = join(mpDir, m.file);
  if (existsSync(dst) && statSync(dst).size > m.minBytes) {
    console.log(`[setup-assets] ${m.file} already present`);
    continue;
  }
  console.log(`[setup-assets] Downloading ${m.file}...`);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.file} download failed: HTTP ${res.status}`);
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
  console.log(`[setup-assets] ${m.file} saved (${(statSync(dst).size / 1e6).toFixed(2)} MB)`);
}
