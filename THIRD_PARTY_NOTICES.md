# Third-party notices

Desk Hookah is created by **Shuvashis Gautam** and released under the [MIT License](LICENSE).
It includes or downloads the third-party works below, which keep their own licenses.

## Sound effects (included in `public/audio`)

These recordings are **not** covered by the MIT License.

| File in this repo | Original title | Creator | Source |
| --- | --- | --- | --- |
| `public/audio/hookah-bubbling.mp3` | Hookah bubling | freesound_community | [Pixabay](https://pixabay.com/sound-effects/) (ID 69642) |
| `public/audio/water-pipe-bubbling.mp3` | Bongwaterpipe bubbling sound | alex_jauk | [Pixabay](https://pixabay.com/sound-effects/) (ID 191124) |

Both are used under the [Pixabay Content License](https://pixabay.com/service/license-summary/).
That license allows using them inside an app like this one. It does not allow selling or
distributing the files on their own (as standalone sound files). If you fork this project,
keep them inside the app or replace them with your own sounds.

## MediaPipe (downloaded at install time, bundled in the installer)

- `@mediapipe/tasks-vision` (WebAssembly runtime), copyright Google LLC, Apache License 2.0.
- Hand Landmarker model (`hand_landmarker.task`), copyright Google LLC, Apache License 2.0.
- Face Landmarker model (`face_landmarker.task`), copyright Google LLC, Apache License 2.0.

These files are not stored in this repository. `npm install` runs `scripts/setup-assets.mjs`,
which copies the runtime from `node_modules` and downloads the models from Google's
official model storage.

## Frameworks and tools

- [Tauri](https://tauri.app), MIT or Apache License 2.0.
- [Vite](https://vite.dev), MIT License.

The full license texts of the npm and Cargo dependencies are included in their packages
under `node_modules` and the Cargo registry.
