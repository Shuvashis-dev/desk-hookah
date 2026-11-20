// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
import { defineConfig } from "vite";

// Credit line kept at the top of the main bundle after minification.
const BANNER =
  "/*! Desk Hookah v0.1.0 | (c) 2026 Shuvashis Gautam | MIT License | It's Shuvashis, and I loved that you used my product. */";

// Tauri expects a fixed dev port and a static build in dist/.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      output: {
        postBanner: (chunk) => (chunk.isEntry ? BANNER : ""),
      },
    },
  },
});
