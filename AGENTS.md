# Recordly working agreement

## Scope

Recordly is an Electron desktop screen recorder/editor. The renderer is React + TypeScript;
PixiJS and canvas compose previews and exported frames. Capture and fast export also have
platform-native helpers. Changes that look renderer-only can therefore affect Windows,
macOS, Linux, MP4, and GIF differently.

## Toolchain and setup

- Use Node.js 22, matching `.github/workflows/quality.yml` and build/release CI.
- For quality-only work, install exactly as CI does: `npm ci --ignore-scripts`.
- A normal `npm install` runs `scripts/postinstall.mjs`, which rebuilds `uiohook-napi` and
  all platform helpers. Do not use it merely to run TypeScript tests; on Windows it can
  invoke Visual Studio/CMake and overwrite tracked helper binaries/manifests.
- `npm run dev` starts the Vite/Electron development app (not verified in this checkout;
  camera and runtime smoke require an interactive desktop session).
- `npm run build` builds native helpers, typechecks, bundles, smokes the Electron main
  entry, and packages the current platform (not verified locally; this is a heavy
  platform build rather than the normal inner-loop check).

On this machine, the PowerShell `npm` shim may fail with:

`Cannot find module 'C:\Users\dodzi\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js'`

That is a broken npm-prefix/shim resolution, not a Recordly failure. Use a repaired Node
22 installation. As a temporary diagnostic workaround, invoke the installed CLI directly:

`node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" <args>`

## Verified quality commands

Run these from the repository root:

- `npx tsc --noEmit` — verified passing on 2026-08-25.
- `npm run lint` — verified exit 0 on 2026-08-25; it currently reports existing hook
  dependency warnings, so inspect new warnings in touched files.
- `npm test` — verified on 2026-08-25: 111 files passed, 1020 tests passed, 1 skipped.
- `npm run i18n:check` — verified passing on 2026-08-25.
- `npm run format:check` — verified failing on 2026-08-25 with 122 pre-existing format
  errors. CI deliberately treats this check as advisory. Do not bulk-format unrelated
  files to make a focused change pass; format touched code and report the baseline debt.

If Vitest/esbuild fails under an agent sandbox with `Cannot read directory "../../..":
Access is denied` and `Could not resolve ... vitest.config.ts`, rerun the same test outside
the filesystem sandbox. Otherwise a sandbox boundary looks like a code/test failure.

Windows Application Control can block freshly built executables or test DLLs with
`0x800711C7` / `Application Control policy has blocked this file`. Rebuild and rerun;
changing product code in response can hide an environmental failure.

## Rendering and export invariants

- Preview/export parity is a product requirement. Editor webcam preview is a DOM video
  layer in `VideoPlayback.tsx`; MP4/WebCodecs uses `modernFrameRenderer.ts`; GIF uses
  `frameRenderer.ts`. A webcam visual effect is incomplete until all three agree.
- `ModernVideoExporter` can bypass JavaScript frame composition through native static-
  layout exporters. When adding an effect unsupported by the native compositors, add an
  explicit native skip reason and test it; otherwise preview is correct but some MP4
  exports silently omit the effect.
- Webcam media is recorded as a separate sidecar with `timeOffsetMs`. Preserve raw media
  and the synchronization logic in `videoPlayback/webcamSync.ts`; destructive processing
  at capture time removes editability and risks screen/webcam drift.
- Extensions have ordered render hooks, including `post-webcam`. Preserve hook ordering
  when moving webcam composition, or extensions will render on the wrong layer.
- Preview and export intentionally have fallback paths for decoder/media-element and
  Pixi WebGPU/WebGL failures. New effects must fail soft (unprocessed webcam plus warning)
  instead of dropping the webcam or aborting an export.
- During WebCodecs shutdown, release held/queued `VideoFrame`s and close the decoder
  before awaiting its feed/flush promise. Retained hardware surfaces can otherwise
  deadlock `flush()`. Wake input-queue backpressure waiters on `dequeue`, as well as
  output and frame consumption.

## Project and settings compatibility

- `.recordly` projects persist `WebcamOverlaySettings`. Add new webcam fields with safe
  defaults in `types.ts` and normalization in `projectPersistence.ts`; old projects must
  continue to load without a version bump unless the wire shape truly becomes incompatible.
- Keep settings non-destructive: raw webcam footage remains the source of truth and editor
  controls determine rendering at preview/export time.
- User-visible settings keys must exist in every locale. Run `npm run i18n:check`; missing
  parity means some localized settings panels show fallback/missing text.
- `LICENSE.md` and the README identify Recordly as AGPL-3.0; `CONTRIBUTING.md` currently
  and incorrectly points contributors to an MIT `LICENSE` path. Treat the canonical license
  file as authoritative, and verify the license and redistribution terms of bundled ML
  runtimes or model assets before committing them.

## Native helper rules

- Windows helper sources and the tracked binaries under `electron/native/bin/win32-x64`
  are tied to `helpers-manifest.json` fingerprints. Use the corresponding
  `scripts/build-*.mjs` command after source changes; hand-copying a binary without the
  manifest makes builds reject or unknowingly reuse stale helpers.
- Full package validation is platform-specific. Follow `.github/workflows/build.yml` for
  FFmpeg installation, Electron native dependency rebuilds, packaging targets, and
  `npm run smoke:packaged-binaries` rather than inventing a local release sequence.

## Local control server

Lets scripts and agents record screens/windows without touching the HUD. Code is in
`electron/control/`; the Playwright helper is in `tools/playwright/`.

- Off by default. Enable with `RECORDLY_CONTROL=1` (or `--control`), e.g.
  `$env:RECORDLY_CONTROL = "1"; npm run dev`. Port `47821`, override with
  `RECORDLY_CONTROL_PORT`. A failure to listen is logged and never blocks startup.
- Discovery file `control-server.json` (`{ port, token, pid }`, owner-only, deleted on quit)
  in Electron `userData`: `%APPDATA%\Recordly-dev` in dev, `%APPDATA%\Recordly` packaged.
  The token is new on every launch.
- HTTP: `GET /v1/status`, `GET /v1/sources`, `POST /v1/recording/{start,pause,resume,stop,cancel}`,
  `POST /v1/cursor-events`. MCP (streamable HTTP) at `/mcp` with tools `recordly_status`,
  `recordly_list_sources`, `recordly_start_recording`, `recordly_pause_recording`,
  `recordly_resume_recording`, `recordly_stop_recording`, `recordly_cancel_recording`,
  `recordly_send_cursor_events`. Window titles match as a case-insensitive substring; a unique
  exact title wins; an ambiguous title is refused with the candidates listed.
- Security (do not loosen): bind `127.0.0.1` only; every request needs
  `Authorization: Bearer <token>` (401); any `Origin` header is refused (403, even Recordly's
  own); a `Host` other than `127.0.0.1:<port>`/`localhost:<port>` is refused (403). Bad JSON is
  400; stop or cursor events with no take is 409. Control calls must never reach the native
  "Unsaved Changes" dialog in `electron/main.ts`.
- Add to Claude Code (re-run after each Recordly launch, the token rotates):
  `claude mcp add --transport http recordly http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token from control-server.json>"`
- Agent-cursor takes (`agentCursor: true`): Recordly ignores the real mouse and draws its
  cursor from posted events; injected clicks feed the normal auto-zoom. The cursor clock is
  backdated to native capture start (moved past any countdown pause, which the helpers drop
  from the video) so drawn clicks line up with the video. Human HUD takes are meant to keep the
  real cursor poller, uiohook, real-click zooms and no auto-save: code paths unchanged
  (reviewed); not live-verified.
- Auto-zoom merges clicks closer than 2.5 s (`CLICK_CLUSTER_MERGE_GAP_MS`); space scripted
  clicks at least 3 s apart for one zoom each.
- Controlled takes auto-save as `<recordings>\Projects\<video name>.recordly` (dev:
  `%APPDATA%\Recordly-dev\recordings\Projects\`) with their zooms. Retakes from an open editor
  need no dialog.
- Calibration: `cd tools/playwright && npm install --ignore-scripts` once, start Recordly with
  control on, then `node tools/playwright/calibrate.cjs [--offset-x N --offset-y N]`. It prints
  `videoPath` and `projectPath`; fix a consistent cursor offset in the helper's
  `pageEventToScreen` (or the offset flags), not in Recordly. See `tools/playwright/README.md`.
- Gotchas: a controlled `stop` returns only after the editor settles and the project is saved,
  so it is slow by design; drawn clicks land about 0.1 s before the page visibly reacts
  (normal paint/capture latency); at 125% DPI Chrome cannot hit exactly 1440x900 (gets
  1440x899), so the helper accepts +/-4 px with a warning. Human takes very likely still show
  a ~0.9 s cursor lead (the cursor clock starts at `set-recording-state`, after native capture
  starts); this is pre-existing and not fixed.

## Onboarding provenance

This guide was derived from repository files and freshly run commands on 2026-08-25.
No Recordly-specific auto-memory entries existed, and the repository owner had just forked
the project, so there is no human-supplied tribal-knowledge tier yet. Add only recurring,
expensive-to-rediscover lessons here as they emerge.
