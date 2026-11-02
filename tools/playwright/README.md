# Recordly Playwright helper

Lets a Playwright script drive an agent-cursor take in Recordly: Recordly ignores the real
mouse and draws its cursor from the events this helper posts to the local control server. Setup, security rules and gotchas are in the
"Local control server" section of the repo-root `AGENTS.md`.

## Install

```
cd tools/playwright
npm install --ignore-scripts
```

It uses your installed Chrome (`channel: "chrome"`), so no browser download is needed.

## Run the calibration take

1. Start Recordly with the control server on: `RECORDLY_CONTROL=1` (or `--control`).
2. `node calibrate.cjs`

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
	sizeWindowForViewport,
} = require("<recordly checkout>/tools/playwright/recordly-playwright.cjs");

const recordly = await connect();
await recordly.start({ source: { windowTitle: "My page" }, agentCursor: true });
const cursor = await recordly.attachCursor(page);
await glideClick(page, page.getByRole("button", { name: "Go" }));
await cursor.detach(); // flushes; a 409 (take already over) counts as done
const { videoPath, projectPath } = await recordly.stop();
```

If your script fails after `start`, call `detach()` then `stop()` so the footage is kept; a take
left running makes the next `start` fail with `conflict`.

`connect()` finds `control-server.json` via `RECORDLY_CONTROL_FILE`, then the `Recordly-dev` and
`Recordly` userData folders (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
`$XDG_CONFIG_HOME` or `~/.config` on Linux), skipping files whose process is gone. It fails
immediately with "Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1"
when none is live, and after `timeoutMs` (default 5 s, also used by `status()`/`sources()`) with
"Recordly's control server isn't responding …" when the server doesn't answer. `start`, `stop`,
`pause`, `resume` and `cancel` have no timeout (`stop` waits for the editor to save).

## Troubleshooting offsets

The helper maps page coordinates to screen coordinates from the window position and size at each
event. If the drawn cursor is consistently off by the same amount (for example a few pixels from
the window frame or non-100% display scaling), pass `--offset-x` / `--offset-y` (screen DIP, added
to every point) to `calibrate.cjs`, or `attachCursor(page, { offsetX, offsetY })` in your script,
and record again until the cursor lands on the button centres.

The window must stay in the `normal` state (not maximized or minimized) at the size you
calibrated.
