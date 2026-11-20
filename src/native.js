// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
//
// Thin bridge to the Tauri side. Every call is a no-op in a plain browser,
// so the app can also be previewed with `npm run dev`.
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let core = null;
let win = null;
let events = null;

export async function initNative() {
  if (!isTauri) return;
  [core, win, events] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/event"),
  ]);
}

export function invoke(cmd, args) {
  if (!core) return Promise.resolve();
  return core.invoke(cmd, args).catch((err) => console.warn(`[native] ${cmd} failed`, err));
}

export function startDragging() {
  if (win) win.getCurrentWindow().startDragging().catch(() => {});
}

export function listen(name, handler) {
  if (events) events.listen(name, (e) => handler(e.payload));
}
