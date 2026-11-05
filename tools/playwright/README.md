# Recordly Playwright helper

Lets a Playwright script drive an agent-cursor take in Recordly: Recordly ignores the real
mouse and draws its cursor from the events this helper posts to the local control server. Setup, security rules and gotchas are in the
"Local control server" section of the repo-root `AGENTS.md`.

## Install

```
cd tools/playwright
npm install --ignore-scripts
```

It uses your installed Chrome (`channel: "chrome"`), so no browser download is needed. Launch
Chrome with `chromiumSandbox: true`; otherwise Playwright adds `--no-sandbox` and Chrome shows a
warning bar inside the recorded window.

## Smoke-test timeline editing

After building the renderer/Electron main with `npx vite build --config vite.config.ts`, run
`node tools/playwright/smoke-timeline-editing.cjs --phase gaps` from the repository root.
The script generates a short synthetic recording and narration with FFmpeg, opens a temporary
project in an isolated Electron profile, and exercises gap controls, Undo/Redo and save/reopen.
It prints the temporary artifact directory and leaves the current app and user projects untouched.

Use `--phase selection` for modifier selection, group drag/cancel, bulk clip/audio settings,
Undo/Redo and explicit-empty-project persistence. This phase uses actual pointer and keyboard
actions; the renderer state is inspected only for assertions.

Use `--phase layout` for timeline height resizing with nine audio tracks. It exercises the
divider, keyboard controls, pinned ruler/playhead seeking while scrolled, remembered height,
window-size clamping, cancellation and double-click reset in an isolated Electron window.

Use `--phase cursor` for per-clip cursor hiding. It checks actual preview pixels for pointer
and click-effect visibility, multi-select, Undo, speed edits and save/reopen, then compares
pixels produced by the real MP4 and GIF frame compositors. Encoder availability is separate.

Use `--phase audio` after rebuilding Electron main to check imported project audio outside
app-managed directories. It plays the external WAV, renders edited narration with the real
audio processor, muxes a short MP4 through Electron and checks that its decoded audio is
non-silent. Optional `--verify-project <path>` checks every audio reference in a temporary
copy of a real project without modifying that project.

## Run the calibration take

1. Start Recordly with the control server on: `RECORDLY_CONTROL=1` (or `--control`).
2. `node calibrate.cjs` (add `--maximized` to maximize the window instead; the achieved viewport is printed)

A Chrome window with five buttons opens, is sized to a 1440x900 viewport, and each button is
clicked in turn while Recordly records the window. The script prints `videoPath` and
`projectPath`; open the project and check the drawn cursor lands on each button.
Clicks are spaced about 3.5 s apart so each one gets its own auto-zoom (Recordly merges
clicks closer than 2.5 s).

## Use it from your own script

```js
const {
	connect,
	glideClick,
	glideTo,
	maximizeWindow,
	openAppPage,
	sizeWindowForViewport,
} = require("<recordly checkout>/tools/playwright/recordly-playwright.cjs");

const recordly = await connect();
await recordly.start({ source: { windowTitle: "My page" }, agentCursor: true });
const cursor = await recordly.attachCursor(page);
await glideClick(page, page.getByRole("button", { name: "Go" }));
await cursor.detach(); // flushes; a 409 (take already over) counts as done
const { videoPath, projectPath } = await recordly.stop();
```

`glideClick` and `glideTo` start from wherever the page last saw the mouse (the in-page listener
records every mouse move, including your own `page.mouse.move` and `locator.click` calls), so the
drawn cursor never jumps to a stale point. `glideTo(page, locator, { durationMs = 600, pauseMs = 120 })`
is the same eased travel to the locator's centre without the click; it resolves to the client
`{ x, y }` it ended on. Use it to bring the cursor to a native `<select>` and then call
`locator.selectOption(...)`, so Chrome's popup (which a window recording doesn't capture) never opens.

`openAppPage(context, url, { timeoutMs = 5000 })` returns the page of a Chrome `--app=<url>` window
in a persistent context: one already open at `url` (prefix match), else one that arrives within
`timeoutMs`, else the first page (or a new one) navigated to `url`. The page is brought to the front.
`calibrate.cjs` uses it.

`maximizeWindow(page, { timeoutMs = 5000 })` maximizes the Chrome window through CDP
(`Browser.setWindowBounds` with `windowState: "maximized"`), waits until the page's inner size is
stable, and resolves to the achieved `{ width, height }`. An already-maximized window is only
measured. It confirms the window really reports `maximized` (retrying once). Attaching, the work
and detaching are all bounded: it rejects after `timeoutMs` rather than hang, and a detach that
never settles is abandoned after 500 ms. `sizeWindowForViewport` takes the same bounds via an
optional `timeoutMs` (default 20 s). Use it instead of `sizeWindowForViewport`
for takes that should fill the screen (`calibrate.cjs --maximized`).

Call `attachCursor` once per take; it can be called again on the same browser context after
`detach()` (the page binding and init script are installed once per context and reused, and events
after `detach()` are ignored).

If your script fails after `start`, call `detach()` then `stop()` so the footage is kept; a take
left running makes the next `start` fail with `conflict`.

`connect()` finds `control-server.json` via `RECORDLY_CONTROL_FILE`, then the `Recordly-dev` and
`Recordly` userData folders (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
`$XDG_CONFIG_HOME` or `~/.config` on Linux), skipping files whose process is gone. It fails
immediately with "Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1"
when none is live, and after `timeoutMs` (default 5 s, also used by `status()`/`sources()`) with
"Recordly's control server isn't responding …" when the server doesn't answer. `start`, `stop`,
`pause`, `resume` and `cancel` have no timeout (`stop` waits for the editor to save).

## Preview source cleanup smoke

After building the Electron main entry, run `node tools/playwright/smoke-preview-memory.cjs`.
It opens the actual editor in an isolated profile, generates 4K/1080p fixtures, exercises
120 radius changes, 20 padding changes and ten project switches, and checks source ownership,
bounded listeners, playback and paused-seek pixels. It writes screenshots and a report to the
printed temporary directory. `--baseline <git-ref>` runs the same checks against that ref's
`VideoPlayback.tsx` without changing the checkout; the pre-fix revision fails source cleanup.

## Troubleshooting offsets

The helper maps page coordinates to screen coordinates from the window position and size at each
event. If the drawn cursor is consistently off by the same amount (for example a few pixels from
the window frame or non-100% display scaling), pass `--offset-x` / `--offset-y` (screen DIP, added
to every point) to `calibrate.cjs`, or `attachCursor(page, { offsetX, offsetY })` in your script,
and record again until the cursor lands on the button centres.

Keep the window at the size you calibrated (not minimized, and not resized mid-take). Coordinates
come from live window metrics at each event, so a maximized window (whose resize borders sit
off-screen on Windows) needs no special case in the helper; verify the cursor placement live with
`calibrate.cjs --maximized`.
