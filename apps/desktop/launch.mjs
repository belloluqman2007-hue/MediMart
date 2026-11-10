/**
 * MediMart desktop launcher.
 *
 * `MediMart.exe` is a copy of the Electron runtime binary, so launching it runs the Electron
 * default app unless it is told which application to load. This file is that entry point:
 *
 *   resources\app\package.json   { "main": "launch.mjs", "type": "module" }
 *
 * It exists because the packaged tree is a *plain folder* (no asar archive, no installer) and on
 * Windows the runtime only falls back to `resources\app` when its own `resources\default_app.asar`
 * is absent. Rather than depending on that implicit fallback, the packaging script writes the
 * launcher name into `resources\app\package.json` and this file forwards to the real shell.
 *
 * Keeping the forwarded module ESM means a packaging mistake fails immediately and visibly instead
 * of leaving the shop with a window that never appears.
 */
import './main.mjs';
