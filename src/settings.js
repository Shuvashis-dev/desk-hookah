// Desk Hookah, created by Shuvashis Gautam. MIT License (see LICENSE).
// User settings, saved in the app's local storage.
const KEY = "deskHookah.settings.v1";

export const DEFAULTS = {
  size: 1,
  smoke: 1,
  density: 1,
  rings: false, // smoke rings from an "O" mouth (My mouth mode only)
  volume: 0.8,
  muted: false,
  hands: false,
  grabGesture: "fist", // "fist" | "pinch"
  smokeFrom: "pipe", // "pipe" | "mouth"
  onTop: true,
  saver: false,
  hintsSeen: false,
};

// Options that are no longer in the settings panel. They stay at these values so an
// old saved choice can't leave the app in a state you can no longer change.
const FIXED = {
  linger: 1,
  exhaleSound: true,
  preview: false,
  handPointer: true,
  wisps: true,
  smartClick: true,
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    /* corrupt settings: start fresh */
  }
  return { ...DEFAULTS, ...saved, ...FIXED };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage full or unavailable: settings just won't persist */
  }
}
