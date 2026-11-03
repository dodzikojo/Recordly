# Slice 1: close existing timeline gaps

Spec: `docs/superpowers/specs/2026-11-03-timeline-batch-editing.md`. Fresh implementation-agent session; TDD. Branch `codex/timeline-gap-commands`, base `codex/ripple-delete-clips` (`6e20bee6`). No additional dependencies.

- [x] Read AGENTS.md and the spec. Inspected the actual mounted timeline controls in VideoEditor; TimelineToolbar is unused.
- [x] Wrote failing unit tests for leading/interior gap discovery, no trailing gap, stale span validation, one/all collapse, source pinning on legacy sped-up clips, overlays, independent narration duration and source captions.
- [x] Implemented pure gap plans beside rippleDelete.ts. Preserves every clip/source frame without changing ripple-delete semantics. Rejects stale/non-gap input.
- [x] Wired an atomic gap command in VideoEditor, one history entry per operation, pause/preview realignment and selected-gap cleanup.
- [x] Added selectable accessible gap UI in the mounted video lane; Delete/Backspace, Close Gap button/context menu; Close All Gaps in mounted controls. Respects input/dialog keyboard guards and preserves existing item handlers.
- [x] Added visible strings to all 11 locales, matching the base-locale structure without bulk reformatting.
- [x] Ran focused tests, TypeScript and lint; inspected the diff. Parent performs independent runtime smoke, full checks and creates the stacked PR.
- [x] Updated this checklist with exact changed files, test commands/results and caveats; reported to parent without committing or switching branches.

Global constraints: raw files and user projects unchanged; timeline/source coordinates are distinct; use getClipSourceStartMs before moving a legacy clip; source captions/recorded audio/legacy source speeds do not shift. Gaps close without deleting overlays. Imported audio keeps its duration/tempo. Use apply_patch. Do not use normal npm install or build native helpers. Do not edit shared/global AGENTS.md. Do not spawn further agents for this bounded slice.

## Implementation record (2026-11-03)

Feature files:

- `src/components/video-editor/closeGaps.ts` and `closeGaps.test.ts`: gap discovery, exact current-gap validation, one/all interval collapse, source pinning, retained visual/audio regions, persistence/history coverage, and retained-source preview target resolution.
- `src/components/video-editor/VideoEditor.tsx`: authoritative transient gap selection and cleanup; batched close command, safe pause, source-frame retention/fallback and imported-audio refresh; mounted Close Gap and Close All Gaps buttons.
- `src/components/video-editor/VideoPlayback.tsx`: validate the parked source frame immediately after attaching seek listeners, including project reopen when the initial seek finished before Pixi initialization.
- `src/components/video-editor/timeline/TimelineEditor.tsx`, `components/viewport/TimelineCanvas.tsx`, and new `components/overlays/TimelineGapButton.tsx`: selectable gap lane buttons, accessible labels/pressed state, context menu, and prop routing. Stable QA selectors are `data-timeline-gap-start` / `data-timeline-gap-end` in milliseconds.
- `src/components/video-editor/timeline/hooks/useTimelineEditorRuntime.ts`, `useTimelineSelection.ts`, `useTimelineKeyboardShortcuts.ts`, and new `useTimelineKeyboardShortcuts.test.ts`: gap selection clears keyframes/zoom select-all; background/Escape clear selection; Delete/Backspace dispatch plus editable/dialog/composition/repeat guards.
- `src/components/video-editor/timeline/hooks/utils/timelineSelectionUtils.ts` and `.test.ts`: gap delete target priority and shared editable-target guard.
- `src/components/video-editor/timeline/core/spans.ts`, `spans.test.ts`, and `hooks/useTimelineNormalization.ts`: passive normalization preserves finite positive authored zoom lengths (including retained 1 ms gap overlays), and preserves imported audio duration beyond video end. Existing invalid/zero-length repair and add/drag interaction minimums remain. No wire marker or schema change.
- `src/i18n/locales/{de,en,es,fr,it,ko,nl,pt-BR,ru,zh-CN,zh-TW}/timeline.json`: four gap labels/actions in every locale.

Verification from the implementation agent, using checksum-verified portable Node 22.23.4 at `C:\Users\dodzi\AppData\Local\Temp\recordly-node22\node-v22.23.4-win-x64\node.exe`:

- Red tests observed for the absent planner/keyboard target guard, passive normalization helper and retained-source target helper before their implementations.
- `node node_modules/vitest/vitest.mjs run src/components/video-editor/closeGaps.test.ts src/components/video-editor/rippleDelete.test.ts src/components/video-editor/timeline/core/spans.test.ts src/components/video-editor/timeline/hooks/useTimelineKeyboardShortcuts.test.ts src/components/video-editor/timeline/hooks/utils/timelineSelectionUtils.test.ts src/components/video-editor/videoPlayback/videoEventHandlers.test.ts`: **6 files, 54 tests passed**.
- `node node_modules/typescript/bin/tsc --noEmit`: exit 0. Node 22 took about a minute, with no intermediate stdout; default installed Node 24 had completed faster earlier.
- Targeted Biome lint of planner/tests, timeline, VideoEditor and VideoPlayback: exit 0, 17 existing hook warnings. No new touched-code warnings.
- `node scripts/i18n-check.mjs`: locale structure consistent. `git diff --check`: clean.
- Biome formatting passes for 13 complete feature/test files and 10 locale files. Existing baseline formatting remains in VideoEditor, VideoPlayback, the old keyframe array in useTimelineSelection, and German timeline JSON; touched code is formatted without bulk-formatting those files.

Independent parent verification: real-pointer Electron smoke passed Delete, context Close Gap, Close All, one Undo/Redo, original source starts, annotation preservation, narration duration, source captions, autosave/reopen, and retained-frame assertions after closure/reload. Latest artifacts: `%TEMP%\recordly-timeline-smoke-EbMbWc`. Parent also reported Node 22 production build and full lint passing (22 baseline warnings); final full-suite/PR results are recorded by the parent.

No commit or branch switch performed by the implementation agent. No Slice 2 behavior, native helpers, dependencies, raw recordings or user project files changed.

Parent release verification (2026-11-03): Node 22 typecheck exit 0; full Vitest **139 files, 1,315 passed, 2 skipped**; production Vite/Electron build exit 0; full lint exit 0 with 22 baseline hook warnings; i18n parity and diff whitespace clean. The reusable smoke command is `node tools/playwright/smoke-timeline-editing.cjs --phase gaps` and its retained-frame assertions also passed on Node 22. Source and fixture profiles remain isolated from the user's session.
