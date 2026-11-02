# Local MCP Recording Control and Agent Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripts and agents can drive Recordly takes over a localhost control server (MCP + JSON), with an agent-driven cursor whose clicks become auto-zooms, used first by an ORCA Playwright take script.

**Architecture:** A main-process `RecordingController` steers the existing HUD recorder over IPC (as the tray's Stop does) and auto-saves each controlled take from the editor. A `127.0.0.1` HTTP server exposes it at `/v1/*` (JSON, for scripts) and `/mcp` (MCP Streamable HTTP, for agents). Agent-cursor takes swap the real-cursor inputs for injected events that go through the existing normalisation and click classification into `pushCursorSample`. A dependency-free Playwright helper in `tools/playwright/` streams page mouse events; ORCA's take script loads it from the Recordly checkout.

**Tech Stack:** Electron main (TypeScript, bundled to CJS by Vite), React renderer, Vitest, `@modelcontextprotocol/sdk@1.32.2` + `zod@4.6.7`, Node `http`, Playwright `1.64.1` driving installed Chrome (`channel: "chrome"`).

**Spec:** `docs/superpowers/specs/2026-11-02-local-mcp-recording-design.md` (read it first; this plan argues from it).

## Execution status (handoff, 2026-11-02)

- **Method (owner's choice):** superpowers:subagent-driven-development, end to end (Tasks 1–8), in a fresh session.
- **Status:** no task started. Spec and plan committed on `feature/local-mcp-recording` (`4644add4`, `563bf3bc`, plus
  the handoff commit).
- **Deadline:** ORCA's footage is recorded at its Nov 3, 2026 freeze; submission Nov 4, 2026 before noon ET. Tasks 1–7
  must be done and smoked on Nov 2 so Task 8's takes can run.
- **Environment facts already checked (don't re-discover):** Electron (`node_modules/electron/dist/electron.exe`) and
  `ffmpeg-static` are present; `uiohook-napi` has a `prebuilds/win32-x64` binary (no `build/Release`); native helpers
  are tracked under `electron/native/bin/win32-x64`. Google Chrome and Edge are installed. Playwright is **not**
  installed anywhere (no global package, not in ORCA `web/node_modules`); Task 6 installs it under `tools/playwright`.
  Local Node is v24 (CI uses 22). Dev-mode `userData` is `%APPDATA%\Recordly-dev` (`electron/appPaths.ts`).
- **Open item for the owner:** the live ORCA URL for `--url` (the script defaults to `http://localhost:8765`).
- **ORCA access:** the session must have `C:\Users\dodzi\source\repos\ORCA` as an extra working directory for Task 8.

## Global Constraints

- The control server is **off by default**; on only when Recordly starts with `RECORDLY_CONTROL=1` or the `--control` argument.
- Bind `127.0.0.1` only. Default port `47821`; override with `RECORDLY_CONTROL_PORT`.
- Every request needs `Authorization: Bearer <token>` (compare timing-safe). Refuse any request carrying an `Origin` header (403). Refuse a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (403).
- Discovery file: `control-server.json` in Electron `userData` (dev: `%APPDATA%\Recordly-dev`, packaged: `%APPDATA%\Recordly`), content `{ "port": number, "token": string, "pid": number }`, deleted on quit.
- Human-driven recordings behave exactly as today: no auto-save, real cursor poller, uiohook and native cursor monitor unchanged.
- Malformed control calls or cursor events return errors; they never throw out of a handler, crash main, or abort a take.
- The native "Unsaved Changes" dialog (`dialog.showMessageBoxSync` in `electron/main.ts`) must never be reachable from a control call.
- Install dependencies only with `--ignore-scripts` (a plain `npm install` rebuilds native helpers and can overwrite tracked binaries). npm shim workaround if `npm` fails: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" <args>`.
- Quality gates stay green: `npx tsc --noEmit`, `npm run lint` (no new warnings in touched files), `npm test`, `npm run i18n:check`. Format touched files only (`npx biome format --write <files>`); don't bulk-format.
- If Vitest fails with `Cannot read directory "../../.."` / `Access is denied`, rerun outside the sandbox. `0x800711C7` (Application Control) is environmental: rerun, don't change code.
- Nothing from Recordly is copied into ORCA (Recordly is AGPL-3.0, ORCA is MIT). ORCA loads the helper from the Recordly checkout.
- Recordly work is on branch `feature/local-mcp-recording` (exists). ORCA work goes on a new `feature/demo-take-script` branch from ORCA `main`; follow ORCA's `AGENTS.md` (no merging without authorization).
- Commit messages: imperative subject, why in the body when not obvious, ending with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016meXhzGpj3TgWcAkwBV9um`

## Review Focus

1. **Stale or missing control server** (Recordly not running, or a crash left `control-server.json` with a dead pid): the helper fails fast with "Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1", never hangs. Test in Task 6.
2. **A take left running** (a script crashed mid-take, then is rerun): `start` returns 409 `conflict` naming the fix (stop or cancel), and the take script stops the open take on its own errors, keeping the footage. Tests in Task 4 and Task 8.
3. **Ambiguous window title** (two Chrome windows titled ORCA, or a Recordly window whose title contains it): `start` refuses and lists candidates instead of recording the wrong window. Test in Task 2.
4. **The browser window moving between events** (a person nudges it, or Chrome repositions on launch): screen coordinates are computed from the window position *at each event*, not cached at attach. Test in Task 6.
5. **Cursor events racing the end of a take** (the last batch flushes after stop, or arrives while paused): those events are rejected or dropped without failing the script; the helper flushes before `stop` and treats a 409 during final flush as done. Tests in Task 1 and Task 6.

---

### Task 1: Agent cursor ingestion in main

**Files:**
- Modify: `electron/ipc/state.ts` (new state + setters, same pattern as neighbours)
- Modify: `electron/ipc/cursor/telemetry.ts` (extract point normalisation)
- Modify: `electron/ipc/cursor/interaction.ts` (extract click classification)
- Create: `electron/ipc/cursor/agentCursor.ts`
- Modify: `electron/ipc/register/recording.ts` (`set-recording-state` gating, ~line 1825)
- Test: `electron/ipc/cursor/agentCursor.test.ts`, extend `electron/ipc/cursor/interaction.test.ts`

**Interfaces:**
- Produces (state.ts): `agentCursorTakeActive: boolean`, `setAgentCursorTakeActive(v: boolean)`, `lastAgentCursorEventAtMs: number | null`, `setLastAgentCursorEventAtMs(v: number | null)`.
- Produces (telemetry.ts): `normalizeScreenPointToCapture(point: { x: number; y: number }): { cx: number; cy: number }`. This is the existing body of `getNormalizedCursorPoint` after it resolves `cursor` (window-source branch using `selectedWindowBounds` and scale factors, else the source display's bounds). `getNormalizedCursorPoint()` becomes "resolve cursor, then call this".
- Produces (interaction.ts): `recordCursorDownAt(point: { cx: number; cy: number }, timeMs: number, button: 1 | 2 | 3, cursorType?: CursorVisualType): void` (the classification now inside `recordCursorMouseDown`, which becomes a caller). Also `recordCursorUpAt(point, timeMs, cursorType?)`.
- Produces (agentCursor.ts):
  ```ts
  export interface AgentCursorEventInput { atMs: number; x: number; y: number; kind: "move" | "down" | "up"; button?: "left" | "right" | "middle"; cursor?: string }
  export interface AgentCursorIngestResult { accepted: number; rejected: Array<{ index: number; reason: string }> }
  export class AgentCursorInactiveError extends Error {}
  export const MAX_AGENT_CURSOR_BATCH = 1000;
  export function mapCssCursorToVisualType(css: string | undefined): CursorVisualType;
  export function ingestAgentCursorEvents(raw: unknown): AgentCursorIngestResult; // throws AgentCursorInactiveError when no agent take is capturing
  ```

- [ ] **Step 1: Write failing tests** in `agentCursor.test.ts` (mock `electron` and `../utils` as `telemetry.test.ts` does; one display at bounds `{x:0,y:0,width:1000,height:500}`, scale 1; set `isCursorCaptureActive`, `agentCursorTakeActive`, `cursorCaptureStartTimeMs = 10_000` via state setters):
  - `maps CSS cursors`: `pointer→"pointer"`, `text→"text"`, `grab→"open-hand"`, `grabbing→"closed-hand"`, `ew-resize`/`col-resize→"resize-ew"`, `ns-resize`/`row-resize→"resize-ns"`, `not-allowed→"not-allowed"`, `crosshair→"crosshair"`, `auto`/`default`/`undefined`/`"weird"→"arrow"`.
  - `ingests a move` `{atMs:10_250,x:500,y:250,kind:"move",cursor:"pointer"}` → `accepted 1`; last sample `{timeMs:250, cx:0.5, cy:0.5, interactionType:"move", cursorType:"pointer"}`.
  - `classifies down as click, two quick downs as double-click, right button as right-click` (downs at 10_100 and 10_300 at the same point → second is `"double-click"`; `button:"right"` → `"right-click"`).
  - `up records mouseup`.
  - `rejects per event, keeps the rest`: batch `[valid, {x:NaN…}, {kind:"jump"…}, valid]` → `accepted 2`, `rejected` indexes `[1,2]`.
  - `rejects events older than the last accepted one` (Review Focus 5): accept `atMs 10_500`, then batch with `atMs 10_400` → rejected with reason containing `"out of order"`.
  - `drops events while paused` (call `pauseCursorCapture(10_600)`; event at 10_700 → `accepted 0`, rejected reason `"paused"`, no sample pushed).
  - `throws AgentCursorInactiveError` when `agentCursorTakeActive` is false or capture inactive (Review Focus 5).
  - `rejects a non-array or a batch over MAX_AGENT_CURSOR_BATCH` → all rejected, no throw.
- [ ] **Step 2: Extend `interaction.test.ts`:** `recordCursorDownAt` classifies exactly like `recordCursorMouseDown` (double-click threshold 350 ms, distance ≤ 0.04).
- [ ] **Step 3: Run tests, expect failures:** `npx vitest --run electron/ipc/cursor` → FAIL (missing exports).
- [ ] **Step 4: Implement** the state additions, the two extractions (no behaviour change for existing callers), and `agentCursor.ts`. Time conversion is `getCursorCaptureElapsedMs(event.atMs)`; screen points go through `normalizeScreenPointToCapture`; set `lastAgentCursorEventAtMs` per accepted event.
- [ ] **Step 5: Gate `set-recording-state`.** When `recording` is true and `agentCursorTakeActive` is true, skip `sampleCursorPoint()`, `startCursorSampling()`, `startNativeCursorMonitor()` and `startInteractionCapture()`; keep `startWindowBoundsCapture()` (window mapping needs it) and the rest. When `recording` is false, after `snapshotCursorTelemetryForPersistence()`, call `setAgentCursorTakeActive(false)` and `setLastAgentCursorEventAtMs(null)`.
- [ ] **Step 6: Run** `npx vitest --run electron/ipc/cursor` → PASS; `npx tsc --noEmit` → no errors.
- [ ] **Step 7: Commit** `Add agent-driven cursor ingestion for controlled takes`.

### Task 2: Control server core (config, discovery, auth, source matching, JSON routes)

**Files:**
- Create: `electron/control/types.ts`, `electron/control/config.ts`, `electron/control/auth.ts`, `electron/control/sourceMatcher.ts`, `electron/control/httpServer.ts`
- Modify: `electron/ipc/register/sources.ts` (extract callable functions from the `get-sources` / `select-source` handlers)
- Test: `electron/control/config.test.ts`, `auth.test.ts`, `sourceMatcher.test.ts`, `httpServer.test.ts`

**Interfaces:**
- Consumes: `AgentCursorIngestResult`, `AgentCursorInactiveError` (Task 1).
- Produces (types.ts):
  ```ts
  export type SourceSelector = { id: string } | { display: number } | { windowTitle: string }; // display = 0-based index among screens
  export interface CaptureSourceSummary { id: string; name: string; kind: "screen" | "window"; displayId?: string }
  export interface StartOptions { source: SourceSelector; agentCursor?: boolean; countdownSeconds?: number } // countdown default 0
  export interface StartResult { source: CaptureSourceSummary; agentCursor: boolean; startedAtMs: number }
  export interface StopResult { videoPath: string | null; projectPath: string | null; saveError?: string }
  export interface ControllerStatus { recording: boolean; paused: boolean; agentCursor: boolean; source: CaptureSourceSummary | null; lastTake: StopResult | null }
  export type ControlErrorCode = "bad_request" | "conflict" | "not_found" | "timeout" | "internal";
  export class ControlError extends Error { constructor(readonly code: ControlErrorCode, message: string, readonly details?: unknown) }
  export interface RecordingController {
    status(): ControllerStatus; listSources(): Promise<CaptureSourceSummary[]>;
    start(o: StartOptions): Promise<StartResult>; pause(): Promise<void>; resume(): Promise<void>;
    stop(): Promise<StopResult>; cancel(): Promise<void>; sendCursorEvents(raw: unknown): AgentCursorIngestResult;
  }
  ```
- Produces (config.ts): `resolveControlConfig(env: NodeJS.ProcessEnv, argv: string[]): { enabled: boolean; port: number }`; `writeDiscoveryFile(dir: string, info: { port: number; token: string; pid: number }): Promise<string>`; `removeDiscoveryFile(dir: string): Promise<void>`; `CONTROL_DISCOVERY_FILE = "control-server.json"`; `DEFAULT_CONTROL_PORT = 47821`.
- Produces (auth.ts): `checkControlRequest(headers: IncomingHttpHeaders, expected: { token: string; port: number }): { ok: true } | { ok: false; status: 401 | 403; reason: string }`.
- Produces (sourceMatcher.ts): `matchSource(sources: CaptureSourceSummary[], selector: unknown): { ok: true; source: CaptureSourceSummary } | { ok: false; error: string; candidates: CaptureSourceSummary[] }`.
- Produces (sources.ts): `listCaptureSources(opts?: { types?: Array<"screen" | "window">; forceRefresh?: boolean }): Promise<Array<SelectedSource & { thumbnail: string | null }>>` (the existing handler body, cache included; the handler calls it) and `applySelectedSource(source: SelectedSource): SelectedSource | null` (the `select-source` body).
- Produces (httpServer.ts): `startControlServer(opts: { port: number; token: string; controller: RecordingController; mcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> }): Promise<{ port: number; close(): Promise<void> }>`. Routes:
  `GET /v1/status`, `GET /v1/sources`, `POST /v1/recording/start|pause|resume|stop|cancel`, `POST /v1/cursor-events` (body `{ events: [...] }`), and `POST|GET|DELETE /mcp` → `mcpHandler` (404 if absent). JSON errors are `{ error: { code, message, details? } }` with status `bad_request→400`, `not_found→404`, `conflict→409`, `timeout→504`, `internal→500`; `AgentCursorInactiveError → 409`; unknown route → 404; body over 1 MB → 413; invalid JSON → 400.

- [ ] **Step 1: Write failing tests:**
  - `config.test.ts`: disabled by default; enabled by `RECORDLY_CONTROL=1` and by `--control`; port `47821` by default, `RECORDLY_CONTROL_PORT=50000` → 50000, invalid port (`"abc"`, `"70000"`) → 47821; discovery file round-trip writes `{port, token, pid}` and `removeDiscoveryFile` tolerates a missing file (use a temp dir).
  - `auth.test.ts`: missing/wrong token → 401; right token + `Host: 127.0.0.1:47821` → ok; `localhost:47821` → ok; `Host: evil.example:47821` → 403; any `Origin` header (even `http://127.0.0.1:47821`) → 403.
  - `sourceMatcher.test.ts` (Review Focus 3): `{id}` exact; `{display:1}` picks the second screen; `{windowTitle:"orca"}` matches `"ORCA — Northbank"` case-insensitively; two windows containing "orca" → `ok:false` with both in `candidates`; no match → `ok:false` with all windows as candidates; malformed selector (`{}`, `{display:-1}`, `"x"`) → `ok:false`.
  - `httpServer.test.ts`: real server on port `0` with a fake controller (vi.fn methods): 401 without token; `GET /v1/status` returns the fake status; `POST /v1/recording/start` passes the parsed body to `controller.start`; a `ControlError("conflict", …)` maps to 409 with `{error:{code:"conflict"}}`; `AgentCursorInactiveError` from `sendCursorEvents` → 409; invalid JSON → 400; `/mcp` without handler → 404; `close()` frees the port.
- [ ] **Step 2: Run** `npx vitest --run electron/control` → FAIL.
- [ ] **Step 3: Implement** the modules. Bind with `server.listen(port, "127.0.0.1")`; token compare with `crypto.timingSafeEqual` on equal-length buffers. Extract the two `sources.ts` functions without changing handler behaviour.
- [ ] **Step 4: Run** `npx vitest --run electron/control electron/ipc/register` → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `Add localhost control server core with token and origin checks`.

### Task 3: MCP endpoint

**Files:**
- Modify: `package.json`, `package-lock.json` (devDependencies; bundled into main)
- Create: `electron/control/mcpServer.ts`
- Test: `electron/control/mcpServer.test.ts`

**Interfaces:**
- Consumes: `RecordingController`, `ControlError`, `startControlServer({ mcpHandler })` (Task 2).
- Produces: `createMcpRequestHandler(controller: RecordingController): (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>`. Stateless Streamable HTTP: per request, a new `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `transport.handleRequest(req, res, body)`, close both on `res` close.
- Tools (name → controller call; results as JSON text content; `ControlError` → `isError: true` with `code: message`):
  `recordly_status`, `recordly_list_sources`, `recordly_start_recording` (input: `source` as one of `{id}` / `{display}` / `{windowTitle}`, `agentCursor?: boolean`, `countdownSeconds?: number 0–10`), `recordly_pause_recording`, `recordly_resume_recording`, `recordly_stop_recording`, `recordly_cancel_recording`, `recordly_send_cursor_events` (input `events` array per `AgentCursorEventInput`). Each tool has a one-line description saying what it does and, for start, that `agentCursor` makes Recordly ignore the real mouse.

- [ ] **Step 1: Install:** `npm install -D @modelcontextprotocol/sdk@1.32.2 zod@4.6.7 --ignore-scripts` → lockfile updated, no postinstall.
- [ ] **Step 2: Write failing test** `mcpServer.test.ts`: start `startControlServer` on port 0 with a fake controller and `createMcpRequestHandler`; connect the SDK `Client` via `StreamableHTTPClientTransport` with `requestInit.headers.Authorization`; assert `listTools()` names equal the eight above; `callTool("recordly_start_recording", { source: { windowTitle: "ORCA" }, agentCursor: true })` calls `controller.start` with that object and returns its result; a controller `ControlError("conflict","Already recording")` → `isError: true` and text containing `"conflict"`; a client without the token can't connect (401).
- [ ] **Step 3: Run** `npx vitest --run electron/control/mcpServer.test.ts` → FAIL.
- [ ] **Step 4: Implement** `mcpServer.ts` with `McpServer.registerTool` and zod schemas.
- [ ] **Step 5: Run** the test → PASS.
- [ ] **Step 6: Bundling check (spec risk):** import `mcpServer.ts` from `electron/main.ts` behind `resolveControlConfig(...).enabled` (wiring finished in Task 4; a guarded import + no-op is enough now), then `npx tsc --noEmit && npx vite build --config vite.config.ts && npm run normalize:electron-main-cjs && npm run smoke:electron-main-cjs` → all exit 0. If bundling fails, fix in `vite.config.ts` (e.g. resolve conditions) rather than externalising an ESM-only package.
- [ ] **Step 7: Commit** `Expose recording control as MCP tools over Streamable HTTP`.

### Task 4: Recording controller and HUD control path

**Files:**
- Create: `electron/control/recordingController.ts`, `electron/control/controlEvents.ts`, `electron/control/electronBridge.ts`
- Modify: `electron/ipc/register/recording.ts` (emit state changes), `electron/main.ts` (wire deps, start/stop server), `electron/preload.ts`, `electron/electron-env.d.ts`, `src/hooks/useScreenRecorder.ts`
- Test: `electron/control/recordingController.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`setAgentCursorTakeActive`, `ingestAgentCursorEvents`, `matchSource`, `listCaptureSources`, `applySelectedSource`, `startControlServer`, `createMcpRequestHandler`, `writeDiscoveryFile`, `removeDiscoveryFile`). Task 5 produces the editor events this task listens for.
- Produces (controlEvents.ts): `controlEvents` (typed `EventEmitter`) with `"recording-state"(recording: boolean)` emitted from the `set-recording-state` handler, `"fresh-take-settled"(videoPath: string)` and `"save-take-result"(r: { requestId: string; ok: boolean; projectPath?: string; error?: string })`.
- Produces (recordingController.ts): `createRecordingController(deps: ControllerDeps): RecordingController` with
  ```ts
  interface ControllerDeps {
    listSources(): Promise<CaptureSourceSummary[]>; selectSource(s: CaptureSourceSummary): void;
    sendToHud(action: "start" | "stop" | "pause" | "resume" | "cancel", options?: { countdownSeconds?: number }): Promise<{ ok: boolean; error?: string }>;
    ensureHud(): Promise<void>; // HUD exists, shown, and is mainWindow
    getEditor(): { hasUnsavedChanges(): boolean; save(): Promise<boolean>; close(): Promise<void> } | null;
    saveTake(projectName: string): Promise<{ ok: boolean; projectPath?: string; error?: string }>;
    setAgentCursorTakeActive(v: boolean): void; ingestCursorEvents(raw: unknown): AgentCursorIngestResult;
    events: typeof controlEvents; now(): number;
    timeouts?: { hudReplyMs: number; startMs: number; stopStateMs: number; settleMs: number; saveMs: number }; // defaults 10_000 / 30_000 / 60_000 / 180_000 / 30_000
  }
  ```
- Produces (IPC + preload, typed in `electron-env.d.ts`): main→HUD `recording-control` `{ requestId: string; action; options? }`; HUD→main `recording-control-reply` `{ requestId; ok; error? }`. Preload: `onRecordingControl(cb): () => void`, `replyRecordingControl(reply): void`.
- Produces (useScreenRecorder): `startRecording(options?: { countdownDelayOverride?: number })`; every `countdownDelay` read inside it (the `> 0` checks and `shouldWarmStartNativeCapture`) uses the effective value.

Controller behaviour (the spec's retake flow, in this order):
- `start`: recording → `conflict` "A take is already recording; stop or cancel it first" (Review Focus 2). Match source (failure → `bad_request` with candidates). If an editor is open: if it has unsaved changes, `save()`; on false → `conflict` "Couldn't save the open take; nothing was closed". Then `ensureHud()`, **then** `editor.close()` (never zero windows). `selectSource`, `setAgentCursorTakeActive(agentCursor)`, `sendToHud("start", { countdownSeconds: countdownSeconds ?? 0 })`, wait for `recording-state` true within `startMs + countdown`; on failure clear the agent flag and return `timeout`/`internal` with the HUD's error.
- `stop`: not recording → `conflict`. Arm a pending stop, `sendToHud("stop")`, wait `recording-state` false (`stopStateMs`), wait the first `fresh-take-settled` after arming (`settleMs`), `saveTake(<video file name without extension>)`, return `{ videoPath, projectPath, saveError }` and keep it as `lastTake`. A settle timeout returns `{ videoPath: null, projectPath: null, saveError: "Editor did not finish loading the take" }` rather than throwing. Settles with no armed stop (human takes) are ignored.
- `pause`/`resume`/`cancel`: require recording (`conflict` otherwise), forward to the HUD, track `paused`; `cancel` waits `recording-state` false.
- `sendCursorEvents`: delegate; `AgentCursorInactiveError` propagates (HTTP maps it to 409).

- [ ] **Step 1: Write failing tests** `recordingController.test.ts` with fake deps (a real `EventEmitter`, fake timers):
  - `start selects the matched source, sets agent flag, sends countdown 0, resolves on recording-state true`.
  - `start while recording → conflict` and `start with ambiguous title → bad_request with candidates`.
  - `start with an editor open saves (when dirty), shows the HUD, then closes the editor`: assert call order `save → ensureHud → close → selectSource → sendToHud`.
  - `start with a dirty editor whose save fails → conflict, close and sendToHud not called`.
  - `start that never reaches recording-state → timeout and agent flag cleared`.
  - `stop waits for recording-state false and the next settle, saves with the video's base name, returns both paths`; `lastTake` in `status()` matches.
  - `settle events with no stop armed are ignored` (no `saveTake` call).
  - `stop when the editor never settles → result with saveError, no throw`.
- [ ] **Step 2: Run** `npx vitest --run electron/control/recordingController.test.ts` → FAIL.
- [ ] **Step 3: Implement** `controlEvents.ts`, `recordingController.ts`, and emit `"recording-state"` at the end of the `set-recording-state` handler.
- [ ] **Step 4: Implement `electronBridge.ts`:** `createElectronControllerDeps(main: { getHudWindow(): BrowserWindow | null; ensureHud(): Promise<void>; getEditorWindow(): BrowserWindow | null; editorHasUnsavedChanges(): boolean; closeEditorWithoutPrompt(w: BrowserWindow): void }): ControllerDeps`. `listSources` calls `listCaptureSources({ forceRefresh: true })`, maps each to `CaptureSourceSummary` (`kind` from `sourceType`), and keeps the originals by id so `selectSource` passes the full `SelectedSource` to `applySelectedSource`. `sendToHud` uses a `requestId` and `ipcMain.on("recording-control-reply")`. Editor `save()` sends the existing `request-save-before-close` and awaits `save-before-close-done` (timeout → false). `close()` resolves on the window's `closed` event. `saveTake` sends `control-save-take` `{ requestId, projectName }` to the editor and awaits `"save-take-result"`.
- [ ] **Step 5: Wire `electron/main.ts`.** In `app.whenReady` after `registerIpcHandlers`: if `resolveControlConfig(process.env, process.argv).enabled`, generate a 32-byte hex token, `startControlServer({ port, token, controller, mcpHandler })`, `writeDiscoveryFile(app.getPath("userData"), …)`, and log `[control] listening on http://127.0.0.1:<port> (token in <file>)`. A listen failure (port in use) logs an error and the app carries on without the server. `ensureHud` creates the HUD if missing (`createWindow()`), calls `showHudOverlayFromTray()`, sets `mainWindow` to it. On `before-quit`: close the server and `removeDiscoveryFile`.
- [ ] **Step 6: Wire the HUD.** In `useScreenRecorder.ts`, keep refs to the latest `startRecording`, `pauseRecording`, `resumeRecording`, `cancelRecording`; one effect subscribes `onRecordingControl` and replies: `start` → `await startRecording({ countdownDelayOverride })` then reply ok (main confirms via recording state); `stop` → `stopRecording.current()`; `pause`/`resume`/`cancel` → the matching call. Unknown action → `{ ok: false, error }`. Add the preload methods and types.
- [ ] **Step 7: Run** `npx vitest --run electron src/hooks` → PASS; `npx tsc --noEmit`; `npm run lint` (no new warnings in touched files).
- [ ] **Step 8: Commit** `Drive HUD recordings from the control server`.

### Task 5: Editor settle signal and controlled save

**Files:**
- Create: `src/components/video-editor/hooks/useFreshTakeSettled.ts`
- Modify: `src/components/video-editor/VideoEditor.tsx` (`saveProjectWithName` ~line 3110; hook wiring), `electron/preload.ts`, `electron/electron-env.d.ts`, `electron/control/electronBridge.ts` (forward the two editor IPC messages into `controlEvents`)
- Test: `src/components/video-editor/hooks/useFreshTakeSettled.test.ts`

**Interfaces:**
- Consumes: `controlEvents` `"fresh-take-settled"` / `"save-take-result"` and the `control-save-take` request shape (Task 4).
- Produces: `isFreshTakeSettled(input: { videoPath: string | null; isPreviewReady: boolean; pendingAutoZoomPath: string | null; msSincePreviewReady: number }): boolean`: true when `videoPath && isPreviewReady && (pendingAutoZoomPath !== videoPath || msSincePreviewReady >= 8000)`. Hook `useFreshTakeSettled({ videoPath, isPreviewReady, pendingFreshRecordingAutoZoomPathRef, zoomRegions })` announces `window.electronAPI.notifyFreshTakeSettled(videoPath)` **once per videoPath**, 750 ms after the last `zoomRegions` change once settled (so every suggested zoom is in state before the save).
- Produces: `saveProjectWithNameResult(name: string, mode?: NamedProjectSaveMode): Promise<{ success: boolean; path: string | null; message?: string }>`, with `saveProjectWithName` becoming a boolean wrapper (callers unchanged). Preload: `notifyFreshTakeSettled(videoPath: string): void`, `onControlSaveTake(cb: (req: { requestId: string; projectName: string }) => void): () => void`, `replyControlSaveTake(r: { requestId: string; ok: boolean; projectPath?: string; error?: string }): void`.

- [ ] **Step 1: Write failing tests** for `isFreshTakeSettled`: not ready → false; ready and pending path cleared → true; ready, still pending, 7 999 ms → false; 8 000 ms → true; `videoPath` null → false.
- [ ] **Step 2: Run** `npx vitest --run src/components/video-editor/hooks/useFreshTakeSettled.test.ts` → FAIL.
- [ ] **Step 3: Implement** the function and hook; wire the hook in `VideoEditor.tsx` beside the fresh-auto-zoom effects (~line 3893). Register `onControlSaveTake` → `saveProjectWithNameResult(projectName, "rename")` → `replyControlSaveTake`. Forward both messages in `electronBridge.ts`.
- [ ] **Step 4: Run** `npx vitest --run src/components/video-editor` → PASS; `npx tsc --noEmit`; `npm run lint`.
- [ ] **Step 5: Commit** `Save controlled takes with their auto-zooms once the editor settles`.

### Task 6: Playwright helper and calibration take

**Files:**
- Create: `tools/playwright/package.json` (`{ "private": true, "devDependencies": { "playwright": "1.64.1" } }`, own lockfile), `tools/playwright/recordly-playwright.cjs`, `tools/playwright/calibration.html`, `tools/playwright/calibrate.cjs`, `tools/playwright/README.md` (short: install, run, troubleshoot offsets)
- Modify: `vitest.config.ts` (add `"tools/**/*.test.{ts,cjs,mjs}"` to `include`), `.gitignore` (`tools/playwright/node_modules/`)
- Test: `tools/playwright/recordly-playwright.test.ts`

**Interfaces:**
- Consumes: the `/v1` routes and discovery file (Tasks 2–5).
- Produces (`recordly-playwright.cjs`, CommonJS, no dependencies, Node 18+ `fetch`):
  ```js
  resolveControlFile({ env, appData, exists, readJson, isPidAlive }) -> { file, info } // RECORDLY_CONTROL_FILE first, then %APPDATA%\Recordly-dev, then %APPDATA%\Recordly; skips dead pids; throws the Review Focus 1 message when none
  connect(options?) -> Promise<RecordlyClient>
  // RecordlyClient: status(), sources(), start(opts: StartOptions), pause(), resume(), stop() -> StopResult, cancel(),
  //                 attachCursor(page, { offsetX?, offsetY?, flushMs = 50 }) -> Promise<{ flush(), detach(), stats() }>
  glideClick(page, locator, { durationMs = 600, pauseMs = 120 } = {}) -> Promise<void>
  pageEventToScreen(metrics, clientX, clientY, correction) -> { x, y } // metrics = { screenX, screenY, outerWidth, innerWidth, outerHeight, innerHeight }; left = (outerWidth-innerWidth)/2, top = outerHeight-innerHeight-left
  ```
  `attachCursor` uses `context.exposeBinding` + `context.addInitScript` (covers popups), also evaluates the listener script in already-open pages. The in-page script reads `window.screenX/screenY/outer*/inner*` **at each event** and stamps `atMs: Date.now()` and `cursor: getComputedStyle(target).cursor`. Batches are POSTed to `/v1/cursor-events`; `detach()` flushes and then treats a 409 as done (Review Focus 5). Non-2xx responses from control calls throw an `Error` with the server's `code: message`.

- [ ] **Step 1: Install** `cd tools/playwright && npm install --ignore-scripts` (uses installed Chrome via `channel: "chrome"`; no browser download).
- [ ] **Step 2: Write failing tests:** `resolveControlFile` prefers `RECORDLY_CONTROL_FILE`; skips a file whose pid is dead and throws "Recordly's control server isn't running; start Recordly with RECORDLY_CONTROL=1" when none is live (Review Focus 1). `pageEventToScreen` gives `{x: 118, y: 192}` (left border 8, top 122) for metrics `{screenX:100, screenY:50, outerWidth:1456, innerWidth:1440, outerHeight:1030, innerHeight:900}`, client `(10,20)`, no correction; changing `screenX` between two calls moves the result (Review Focus 4). A fake HTTP server checks that `client.start(...)` sends the bearer token and the body, that a `{error:{code:"conflict"}}` 409 becomes a thrown `Error` containing `conflict`, and that `detach()` swallows a 409.
- [ ] **Step 3: Run** `npx vitest --run tools/playwright` → FAIL.
- [ ] **Step 4: Implement** the helper, `calibration.html` (title `Recordly calibration`, five labelled buttons inset 40 px at the corners and one at the centre, each turning green and showing its click count), and `calibrate.cjs`: launch headed Chrome (`channel: "chrome"`, `--app=file:///…/calibration.html`), size the window so the viewport is 1440×900 (measure outer−inner, then CDP `Browser.setWindowBounds`), `connect`, `start({ source: { windowTitle: "Recordly calibration" }, agentCursor: true })`, `attachCursor`, `glideClick` each button with 1 s gaps, `detach`, `stop`, print `videoPath`/`projectPath`. `--offset-x/--offset-y` pass a correction through.
- [ ] **Step 5: Run** `npx vitest --run tools/playwright` → PASS.
- [ ] **Step 6: Commit** `Add Playwright helper and calibration take for agent-cursor recordings`.

### Task 7: Runtime smoke and repo docs (Recordly)

**Files:**
- Modify: `AGENTS.md` (new "Local control server" section: enabling, discovery file, the `/v1` + `/mcp` surface, agent-cursor takes, the calibration script, the `claude mcp add` command, and the Projects-folder auto-save)
- Modify: any file needing a fix found by the smoke (with a regression test where a unit test can pin it)

- [ ] **Step 1: Gates:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run i18n:check` → all pass; record counts.
- [ ] **Step 2: Start Recordly:** `$env:RECORDLY_CONTROL = "1"; npm run dev` → log shows `[control] listening on http://127.0.0.1:47821`; `%APPDATA%\Recordly-dev\control-server.json` exists.
- [ ] **Step 3: Calibration take:** `node tools/playwright/calibrate.cjs` → prints a video path and a project path. In the editor that opened, take a screenshot at each click: the drawn cursor sits on each button (within ~10 px at 1440×900) and an auto-zoom region exists for each click. If the cursor is consistently off, rerun with `--offset-x/--offset-y` and fold the correction into `pageEventToScreen`, not into Recordly.
- [ ] **Step 4: Retake flow:** run the calibration twice back to back without touching Recordly → no dialog appears; both `.recordly` projects exist in `<recordings>\Projects\` and each reopens with its zooms.
- [ ] **Step 5: Human take unchanged:** record ~5 s from the HUD by hand with a few real clicks → editor opens as before, real cursor drawn, real-click zooms, no auto-save.
- [ ] **Step 6: Agents:** `claude mcp add --transport http recordly http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"` → `recordly_status` works; `recordly_start_recording` on a screen then `recordly_stop_recording` returns paths. A request with an `Origin` header (e.g. `curl -H "Origin: http://example.com" …`) → 403.
- [ ] **Step 7: Write the `AGENTS.md` section**, then commit `Document the local control server and verify it end to end`.

### Task 8: ORCA take script (ORCA repo)

**Files (in `C:\Users\dodzi\source\repos\ORCA`, branch `feature/demo-take-script` from `main`):**
- Create: `web/scripts/record-demo.cjs`
- Modify: `docs/demo-video.md` ("Before recording": how to run the takes), and whatever ORCA's `AGENTS.md` / `BUILT_DURING_HACKATHON.md` conventions require for a new script

**Interfaces:**
- Consumes: `tools/playwright/recordly-playwright.cjs` and Playwright from the Recordly checkout: `const recordlyDir = arg("--recordly") ?? process.env.RECORDLY_DIR ?? path.resolve(ROOT, "..", "Recordly")`; `require(path.join(recordlyDir, "tools/playwright/recordly-playwright.cjs"))`; `createRequire(path.join(recordlyDir, "tools/playwright/package.json"))("playwright")`; a clear error naming `--recordly` if missing.
- CLI: `--url` (default `http://localhost:8765`), `--only <shot[,shot]>`, `--filters` (include the proposed filter beats), `--login`, `--profile <dir>` (default `%LOCALAPPDATA%\orca-demo-profile`, outside git).
- Shots (from `docs/demo-video.md`'s script; each `{ name, setup(page), take(page) }`; `setup` runs **unrecorded**, `take` runs inside its own agent-cursor Recordly take): `open` (Northbank opens; with `--filters`: Colour by… Discipline, hide Site and Architecture), `triage`, `duct` (#1 Propose fixes, Workings, Before/After), `revision` (ORCA's fix beside the later revision), `built` (Show it built, wipe slider), `accept` (Accept this fix, Export, the PDF report), `cell-29` (Propose, Look for a better fix, Wonder ranked first), `cell-13` (No verified fix), `voice` (types "Isolate the services and colour them by system." in chat).

- [ ] **Step 1: Create the branch** in ORCA from `main`.
- [ ] **Step 2: Write `record-demo.cjs`.** Launch `chromium.launchPersistentContext(profile, { channel: "chrome", headless: false, viewport: null, args: ["--app=" + url] })`, size the viewport to 1440×900 as `calibrate.cjs` does (abort with a clear message if the display can't fit it). `--login`: open the URL, print "Sign in as owner, switch on the open-weights model and Show it built, then close the window", exit on close, record nothing. Otherwise for each selected shot: `setup` → `client.start({ source: { windowTitle: <the page's document.title> }, agentCursor: true })` → `attachCursor` → `take` (use `glideClick` for every visible click) → `detach` → `stop` → print `shot, videoPath, projectPath`. Any error inside `take`: `detach`, then `stop` (keep the footage), report, continue to the next shot (Review Focus 2). Before the clash shots, setup clears Filters (**Clear all**) and floats Activity (Workings) inside the page, never in its own window. Take selectors from `web/scripts/capture-proposals.cjs` and the running app (`web/src`); waits use the visible end states listed in "Shots, as tested" with generous timeouts (triage and Show it built up to 180 s).
- [ ] **Step 3: Smoke against a local server** (`cd server; uv run uvicorn sightline.app:app --port 8765`): `node web/scripts/record-demo.cjs --only open` → one take recorded; the editor shows the drawn cursor on ORCA's buttons with a zoom per click. Then `--only duct` (a live Muse Spark call) → a verified fix appears in the take.
- [ ] **Step 4: Document the run** in `docs/demo-video.md` "Before recording" (start Recordly with `RECORDLY_CONTROL=1`, `--login` once, then the commands), plus any provenance note ORCA's rules require.
- [ ] **Step 5: Commit** `Add Recordly-driven take script for the demo video` and open a PR (do not merge).
