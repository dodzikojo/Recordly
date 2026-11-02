# Local MCP recording control and agent-driven cursor

**Date:** 2026-11-02 · **Repos:** Recordly (this one) and ORCA (`C:\Users\dodzi\source\repos\ORCA`)
**Deadline:** working end to end today (Nov 2). ORCA's demo footage is recorded at its Nov 3 freeze and submitted
Nov 4 before noon ET (`ORCA/docs/demo-video.md`).

## Why

Recordly records what a person does: it polls the real cursor and hooks real OS clicks (`uiohook-napi`), and those
clicks become auto-zooms on a fresh recording. The first job for this feature is ORCA's 3-minute hackathon video,
where a **Playwright script** drives a browser app. Playwright's clicks happen inside the browser and never reach the
OS, so today Recordly sees no clicks (no zooms) and draws a cursor parked wherever the real mouse is.

Two things fix that, and both stay useful after the hackathon (ClashWise demos are next):

1. **Local control:** an agent or script can start, pause, resume, stop and cancel Recordly takes without a person at
   the HUD, over MCP for agents and plain HTTP for scripts.
2. **Agent-driven cursor:** for a take that opts in, Recordly ignores the real mouse and draws its cursor (moves,
   clicks, cursor shape) from events it is sent. The existing auto-zoom then works unchanged.

## Goals

- From any app state (HUD showing, editor open from the last take, tray only), a client can start a recording of a
  chosen screen or window, and the call returns only once capture is actually live.
- A stop call returns the finished video path after finalisation; the editor opens as it does today, and the take is
  saved as a `.recordly` project with its auto-zooms (retake flow, below).
- Takes can be scripted back to back: start → stop → start never needs a person to close a dialog, and no take's
  zooms or edits are lost.
- In an agent-cursor take, the drawn cursor in the editor follows the sent events, clicks land where the page was
  clicked, and fresh-recording auto-zooms are generated from those clicks.
- A Playwright script gets this by attaching one helper to its page; its choreography stays ordinary Playwright.
- ORCA has a take script that records the demo's shots, one recording per shot, each retakeable alone.

## Non-goals (today)

- A settings-panel toggle for the server (needs strings in every locale); today it is enabled at launch (below).
- Real OS mouse/keyboard synthesis. Markers only.
- Automating editor work: speed regions, the 4× badges, captions, narration, export and final assembly stay manual.
- macOS and Linux verification. The code must not break them, but only Windows is exercised today.
- Shots that are not screen recordings of ORCA in the browser: the 0:00–0:12 motion graphic, and the "your own AI
  agent" half of 2:42–2:50.

## Anti-goals (a failure even if it technically works)

- Normal, human-driven recordings change behaviour in any way.
- Any process or web page on the machine can start a recording: the server must be off by default, bound to
  `127.0.0.1`, token-protected, and refuse browser-originated requests (DNS rebinding / cross-origin).
- Clicks drawn or zoomed somewhere other than where they happened in the page. A cursor that is visibly off
  target is worse than no cursor.
- Recordly crashing or a take aborting because a control call or a cursor event was malformed. Bad input is
  rejected with an error; the take carries on.

## Constraints

- Recording is orchestrated in the HUD renderer (`src/hooks/useScreenRecorder.ts`, hosted by
  `src/components/launch/LaunchWindow.tsx`). The main process steers it over IPC, as the tray's Stop does
  (`electron/main.ts` `updateTrayMenu` → `stop-recording-from-tray` → `onStopRecordingFromTray`). Control must use
  the same path, not a second recorder.
- Cursor telemetry has one sink: `pushCursorSample` (`electron/ipc/cursor/telemetry.ts`). Real input enters through
  `sampleCursorPoint` (polling), `recordCursorMouseDown/Up` (uiohook) and the native cursor monitor's
  `currentCursorVisualType`. Capture starts and stops in the `set-recording-state` handler
  (`electron/ipc/register/recording.ts`).
- Normalisation from screen points to the captured frame lives in `getNormalizedCursorPoint` (window sources use
  `selectedWindowBounds` and per-display scale factors). Injected points must go through the same mapping, so that
  code is refactored to accept an explicit point rather than duplicated.
- Telemetry time is `getCursorCaptureElapsedMs(nowMs)`, which already accounts for pauses. Injected events carry a
  wall-clock `atMs` from the same machine and are converted with it, so transport latency and batching don't shift
  them.
- Electron main is bundled by Vite into CommonJS (`vite.config.ts`, `normalize:electron-main-cjs`,
  `smoke:electron-main-cjs`). A new dependency bundled into main must survive both scripts.
- Repo rules in `AGENTS.md` apply: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run i18n:check` stay green; format
  touched files only; no native helper rebuilds are needed for this work.
- Today Recordly runs from source (`npm run dev`) on Windows; a packaged build is not required.

## Design (decided)

### 1. Recordly: one controller, two doors

- **Controller** (main process): `status`, `listSources`, `start`, `pause`, `resume`, `stop`, `cancel`,
  `sendCursorEvents`. It reuses the existing source logic (`get-sources` / `select-source` in
  `electron/ipc/register/sources.ts`, refactored into callable functions), shows the HUD if it is not up, sends a
  control message to the HUD renderer, and resolves on the state change main already observes (`set-recording-state`
  for start; the recording session / video path for stop), with timeouts that return errors.
- **Sources** can be named by id, by display, or by a case-insensitive window-title substring (a script doesn't know
  desktop-capturer ids). An ambiguous or missing match is an error listing the candidates.
- **HTTP server** on `127.0.0.1`, serving:
  - `/mcp`: MCP over Streamable HTTP via the official `@modelcontextprotocol/sdk`, one tool per controller action.
    Claude Code connects with `claude mcp add --transport http recordly http://127.0.0.1:<port>/mcp --header
    "Authorization: Bearer <token>"`.
  - `/v1/...`: the same actions as plain JSON, for scripts with no MCP client. Cursor events go here at volume.
  - Every request needs `Authorization: Bearer <token>`; requests with an `Origin` header or a `Host` other than
    `127.0.0.1:<port>` / `localhost:<port>` are refused.
- **Enablement and discovery:** off unless Recordly starts with `RECORDLY_CONTROL=1` (or `--control`). When on, it
  generates a token, listens on a fixed default port (overridable by `RECORDLY_CONTROL_PORT`), and writes
  `{ port, token, pid }` to `control-server.json` in Electron `userData`, removed on quit. Clients read that file.

### 2. Agent-cursor takes

- `start` takes `agentCursor: true`. For that take only, the `set-recording-state` path skips the cursor poller,
  the uiohook hook and the native cursor monitor's shape, and accepts `sendCursorEvents`. Outside such a take,
  cursor events are rejected. Human takes are untouched.
- An event is `{ atMs, x, y, kind: "move" | "down" | "up", button?: "left" | "right" | "middle", cursor? }`, with
  `x, y` in screen DIP (Electron's screen coordinate space). `down` is classified exactly as real clicks are today
  (click, double-click, right-click, middle-click), by sharing that logic rather than copying it. `cursor` maps CSS
  cursor values to Recordly's `CursorVisualType` (pointer, text, grab → open-hand, grabbing → closed-hand, the
  resize cursors, not-allowed, crosshair, else arrow).
- Events while paused are dropped, as real input is. Events must be in time order within a batch; out-of-order or
  non-finite values are rejected per event, never crashing the take.

### 2b. Retake flow (owner decision: auto-save, never discard)

Facts from the code: a stop reuses an open editor window without reloading it (`createEditorWindowWrapper`,
`electron/main.ts`), and the editor ignores a session whose video path differs (`onRecordingSessionChanged`,
`VideoEditor.tsx`), so a stale editor must be gone before the next stop. Closing an editor with unsaved changes runs
`dialog.showMessageBoxSync`, which blocks the main process and with it the control server. A fresh take always counts
as unsaved, and its first save opens a save dialog (`saveProject` → `openProjectSaveDialog`). Fresh-recording auto-zooms
are applied only while the editor holds the take it just opened. On Windows, closing the last window quits the app
(`window-all-closed`).

So:
- **At stop**, for controlled takes: once the editor has opened the take *and applied its fresh auto-zooms*, it saves
  the take without prompting, as a `.recordly` project named after the video, in Recordly's projects folder
  (`<recordings>/Projects/`, via the editor's existing named save, which is trusted and dialog-free). `stop` returns both
  the video path and the project path. A save failure is reported in the result; the video is kept either way.
- **At start**, if an editor is open: if it has unsaved changes (a person edited after the stop), save it the same way
  (to its existing project path if it has one). Then bring up the HUD **before** closing the editor, so the app never
  has zero windows, and close the editor bypassing the unsaved prompt. If that save fails, `start` returns an error and
  closes nothing.
- The native "unsaved changes" dialog must never be reachable from a control call.
- Human-driven recordings keep today's behaviour (no auto-save).

### 3. Playwright helper (lives in Recordly, reusable)

- A single dependency-free CommonJS file (Node 18+ `fetch`) that reads `control-server.json` and exposes: start /
  stop / cancel / status wrappers, and `attachCursor(page)`.
- `attachCursor(page)` injects capture-phase `mousemove` / `mousedown` / `mouseup` listeners (Playwright's mouse
  actions fire these), reads the computed CSS cursor of the target, converts client coordinates to screen DIP from the
  window's position and chrome offset, timestamps in the page, and streams batches to `/v1`. It also attaches to
  popups the page opens.
- `glideClick(page, locator, { durationMs })`: moves the mouse in steps from its last position to the target's centre,
  pauses briefly, then clicks, so the drawn cursor travels instead of teleporting. Plain `locator.click()` still works.
- A **calibration page and script**: a headed Chromium page with targets at its corners and centre, a short agent-cursor
  take that glides to and clicks each, then stops. Its recording is the proof that mapping and zoom are right (below).

### 4. ORCA take script (lives in ORCA)

- `web/scripts/record-demo.cjs` on a `feature/…` branch in ORCA, built on `capture-proposals.cjs`'s selectors.
- **Licence (owner decision):** the helper stays in Recordly (AGPL-3.0); nothing from Recordly is copied into ORCA
  (MIT, public hackathon repo that holds only event-built work). The take script loads the helper from the Recordly
  checkout: path from `--recordly <dir>` or `RECORDLY_DIR`, defaulting to the sibling `../Recordly` of the ORCA repo, with
  a clear error if it's missing. Follow ORCA's own rules (`CLAUDE.md`, `AGENTS.md`, `BUILT_DURING_HACKATHON.md`) for
  adding the script itself.
- Headed Chromium via a persistent profile kept outside git, window opened in `--app` mode with a 1440×900 viewport,
  `--url` for local or live. `--login` opens that profile with no recording so the owner signs in once and switches on
  the open-weights model and Show it built; the profile keeps it for every take.
- Operation (agreed with the owner): Recordly (`RECORDLY_CONTROL=1`, `npm run dev`) and, if local, the ORCA server
  are started once and left running; the take script does not launch Recordly. Each run is one command
  (`node web/scripts/record-demo.cjs [--url …] [--only <shot>]`); the script starts and stops every Recordly take
  and prints each take's video and project path.
- One function per shot from the script in `demo-video.md`, each its own Recordly agent-cursor take; `--only <shot>`
  retakes one. Shots: Northbank opens (with the proposed filter beats behind a flag, since the owner hasn't agreed them),
  triage, #1 propose and Before/After, the later-revision compare, Show it built, Accept and Export, cell #29 propose and
  better fix, cell #13 no verified fix, the typed "Isolate the services and colour them by system."
- Workings is floated inside the page, never opened in its own window: a window recording wouldn't capture it.
- Filters are cleared before the clash shots, as `demo-video.md` requires.

## How we know it works

- Unit tests for: event validation and classification; screen-point → normalised mapping for display and window
  sources; agent-cursor gating (poller and hook off, events accepted only in such a take); token, Host and Origin
  checks.
- **Runtime smoke, required before calling it done:** run Recordly from source with the server on, run the calibration
  script, open the take in the editor, and confirm (screenshot) that the drawn cursor hits each target and an auto-zoom
  lands on each click. Then one human-driven take, to show nothing changed. Then a real ORCA shot.
- Claude Code connects to `/mcp` and can start and stop a take.

## Risks

- **Coordinate mapping.** Chromium's window position and frame on Windows (invisible resize borders, DPI scaling,
  the automation infobar) may offset points. The calibration take catches it; fix in the helper, not in Recordly.
- **Retakes from the editor state.** After a stop the editor is open; `start` must save, bring the HUD back, then close
  the editor. Exercise start → stop → start → stop in the smoke and confirm both projects exist with their zooms.
- **Saving before the zooms land.** The fresh auto-zooms are applied asynchronously after the editor loads the take;
  the stop-time save must wait for them, not race them.
- **Bundling the MCP SDK into CommonJS main.** Check `smoke:electron-main-cjs` early, before building on it.
- **ORCA's long waits** (triage ~86 s, Show it built ~85 s) and Muse variability (#29 sometimes fails first) make takes
  slow. Script those shots so a retake is one command.

## Left to the builder

Module and file names in Recordly; the exact HTTP routes and MCP tool names; the default port; IPC channel names; how
the renderer reports start/stop failures back to main; batching interval for cursor events; glide timing defaults;
ORCA selectors for each shot (from `capture-proposals.cjs` and the running app).

## Rejected alternatives (and why)

- **"Playwright aims, the real mouse clicks"** (move and click the OS mouse with a small SendInput helper, so Recordly
  needs no changes): offered on Nov 2 as the lowest-risk path before the freeze. The owner chose to build the full
  feature today instead, because markers and local control are wanted beyond this video (ClashWise demos next) and a
  real-click take needs hands off the mouse and an unobscured window.
- **An agent (Claude via the Playwright MCP) clicking live during takes:** rejected for takes because agent pacing
  leaves 5–20 s gaps; agents use the MCP for control, a script does the choreography.
- **Playwright's own video recording / CDP screencast** (what `capture-proposals.cjs` uses): no drawn-cursor effects
  or click zooms, and Playwright's recorder starved the page of CPU under SwiftShader in ORCA's earlier captures.
- **Discarding or refusing on retake:** discarding loses each take's fresh auto-zooms (they're only applied to a fresh
  session); refusing makes every scripted retake need a person. The owner chose auto-save.
- **Copying the helper into ORCA:** would put AGPL code in an MIT hackathon repo; ORCA loads it from Recordly instead.
- **The take script launching Recordly itself:** offered (~15–20 min more); the owner chose to start Recordly once by
  hand, keeping one less moving part on the recording day.

## Owner decisions

- Build all of it today: MCP server, click markers, Playwright helper, ORCA take script.
- Click markers (not real OS clicks), Playwright driving the browser.
- Retakes auto-save the previous take as a project; never discard.
- The helper stays in Recordly; ORCA loads it from the Recordly checkout.

## Calls made in brainstorming (not the owner's explicit choices)

- Saving at stop as well as at the next start, so the last take of a session is saved too.

- A script runs the takes, not an agent clicking live (live agent pacing leaves 5–20 s gaps).
- Plain HTTP beside MCP, so the Playwright helper needs no MCP client for high-rate cursor events.
- Enabled by launch flag or env var today; settings toggle later.
- One Recordly recording per shot; assembly, speed-ups and badges in the edit.
- Recording the browser window, `--app` mode, Workings floated in-page.
- Proposed filter beats included behind a flag until the owner agrees them.
