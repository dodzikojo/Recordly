# Slice 2: video clip multi-selection and bulk editing

Spec: `docs/superpowers/specs/2026-11-03-timeline-batch-editing.md`. Fresh implementation-agent session; TDD. Branch `codex/timeline-multi-select`, base the completed gap-commands branch. Video clips only, explicitly chosen by the owner.

- [x] Read AGENTS.md, the spec and the completed Slice 1 ledger before edits. Inspect selection, item pointer events, drag wrapper/engine and source-audio setting ownership.
- [x] Add failing pure tests for click/toggle/range/all/clear transitions, stale IDs, group moves and obstacles, preview cancellation and source preservation.
- [x] Add authoritative selected clip IDs and a primary clip; wire highlight/count, Ctrl/Cmd-click, Shift range, context-aware Ctrl/Cmd+A, Escape/clear and cross-item selection cleanup. Keep multi-selection alive when initiating a drag on a selected member.
- [x] Implement atomic group drag and matching live previews, common delta bounds, noncontiguous selection, source pinning and visual overlay ownership. Preserve existing one-item resize and no-overlap behavior.
- [x] Add failing tests for bulk speed/mute/visibility and source-track volume/normalization. Apply only changed fields, display mixed values, inherit defaults correctly, preserve unselected clips, reject invalid speed changes atomically.
- [x] Extend editor history snapshots compatibly so source-audio bulk settings and selected IDs undo/redo with the edit. Wire group deletion atomically; explicitly prevent empty selections from exposing the original full recording.
- [x] Add all visible strings in every locale and ensure project/source changes sanitize selections. Selection remains transient, media edits persist without a project-version bump.
- [x] Run focused tests, TypeScript and lint and review the diff. Parent performs independent real-pointer Electron smoke and full verification and creates a stacked PR.
- [x] Update this checklist with changed files, exact checks and caveats, then report without committing or switching branches.

Global constraints: use source offsets to preserve footage; timeline edits must agree with preview, MP4/GIF and source audio. Never process camera/media destructively. No native helper changes, no dependency install. Use apply_patch. Preserve unrelated edits and do not bulk-format legacy files. Do not spawn further agents without asking parent for a well-defined file boundary.

## Implementation record (2026-11-03)

Feature files:

- `clipBatchEditing.ts` and `.test.ts`: selection transitions and stable anchors; group movement with one legal common delta, source pinning and owned visual regions; union ripple deletion; atomic field-only speed/mute/source-audio visibility changes. A bounded fresh helper agent owned only these two new files, with APIs agreed before integration.
- `VideoEditor.tsx`: authoritative transient clip IDs and primary/anchor cleanup; one atomic group edit; shared inspector values, mixed source-audio state, per-clip field updates and imported-preview refresh. Empty deletion persists an existing full-source trim, renders a black empty preview and disables/guards export.
- `timeline/Item.tsx`, `TimelineEditor.tsx`, viewport canvas and drag wrapper: modifiers, every selected highlight, exact live group/owned-overlay preview and cancellation cleanup. Stable runtime selectors are `data-clip-id`, `aria-pressed`, `data-clip-selection-count`, and `data-empty-clip-edit`. Source-audio clones intentionally do not expose `data-clip-id`.
- Timeline selection/runtime/keyboard hooks: modifier routing, clip-context Ctrl/Cmd+A, Escape and cross-item cleanup while preserving gap commands and zoom select-all.
- `SettingsPanel.tsx`: existing shared controls, explicit Mixed indicators, selected count and plural delete action. Source-audio controls keep existing Volume/Normalize labels.
- `audio/bulkSourceAudioSettings.ts` and tests: effective per-track defaults, patch only the requested field, leave defaults/unselected clips untouched.
- `editorHistory.ts` and tests: optional selection/audio/trim compatibility; editor selection changes replace current transient metadata without consuming Undo; canonical nonempty trims avoid a second history entry after derived trims update.
- `emptyClipEdit.ts` and tests: explicit empty-source trim detection, normalization/reopen compatibility without a project version bump.
- `types.ts`, `projectPersistence.ts`, `clipSpeedChange.ts`, and source timing/speed tests: optional exact `sourceEndMs` prevents integer timeline rounding from growing source footage on repeated speed changes. Exact ends survive save/reopen, moving, splitting and edge trimming. Legacy projects still derive source ends normally.
- All 11 `timeline.json` locale files: Mixed, count, plural deletion, empty edit and export guidance.

Verification from the implementation agent, using portable Node 22.23.4 at `C:\Users\dodzi\AppData\Local\Temp\recordly-node22\node-v22.23.4-win-x64\node.exe`:

- RED runs confirmed absent batch planners/audio helper/empty-edit detector, missing keyboard transitions, selection-only history recording, and the 1001 ms source-duration rounding regression before implementation.
- Focused Vitest final run: `clipBatchEditing`, `clipSpeedChange`, `clipSourceTiming`, `editorHistory`, `audio/bulkSourceAudioSettings`, `emptyClipEdit`, `closeGaps`, `rippleDelete`, `projectPersistence`, timeline keyboard shortcuts and `types`: **11 files, 116 tests passed**.
- `node node_modules/typescript/bin/tsc --noEmit`: exit 0 after final pointer-up integration.
- Targeted Biome lint: exit 0; only the existing `AudioWaveform.tsx` `resizeKey` dependency warning in the checked timeline scope. No new touched-code warnings.
- `node scripts/i18n-check.mjs`: all locale structures consistent, including the plural delete action.
- Biome formatted the complete new files and clean touched timeline/history/test files. Existing baseline formatting in legacy files is retained; only changed lines were formatted in VideoEditor/SettingsPanel/types/persistence/selection.

Independent parent real-pointer runtime verification passed Ctrl/Shift/A/Escape, every highlight/count, group live preview/move/cancel, owned effects and original source bounds, mixed/shared speed including odd source-end preservation and atomic collision rejection, mute/visibility/volume, source-audio field-only Undo, normalization and save/reopen, and all-clips deletion/Undo/Redo/empty-project reopen with disabled Export. Artifact: `%TEMP%\recordly-timeline-smoke-kpDSGl`. The initial clean run found dnd-kit's immediate pointer sensor suppresses native click even without movement; plain selected-member collapse now resolves on pointer-up with modifier/distance guards.

Parent review also found two exact-source-end edge cases. Added RED/GREEN regressions and fixed near-edge slow-speed splitting to keep both raw spans positive (returning null safely for 1 ms source clips), and 1x automatic full-track extension now advances an explicit raw end with newly available media. `handleClipSplit` ignores an unsplittable result safely. Fresh targeted follow-up: **4 files, 67 tests passed**, TypeScript exit 0, focused lint exit 0. Parent will rerun full quality and gap/selection smoke on this final state.

Parent owns the smoke harness and final full-suite/build/PR checks. No commit or branch switch performed; no dependency, native helper, recording or user-project mutation.

## Parent release verification

Final frozen-code verification on Node 22.23.4 (2026-11-03): TypeScript exit 0; full Vitest **142 files, 1,351 passed, 2 skipped**; full lint exit 0 (21 existing hook warnings); locale parity and diff whitespace pass. Production Vite renderer/Electron build and normalized Electron main CJS smoke both pass. Biome checks 36 touched code/locale files: 33 pass; only unchanged baseline formatting remains in `useTimelineSelection.ts`, `types.test.ts` and German `timeline.json`.

Both real-pointer Electron smoke phases passed after the final source-edge fixes: `%TEMP%\recordly-timeline-smoke-PaSVwT` (gaps) and `%TEMP%\recordly-timeline-smoke-HJEhLl` (selection). The selection phase verifies modifiers, highlights, group live preview/movement/cancel, mixed values, atomic collision rejection, source preservation, shared speed/mute/visibility/volume/normalization, one-step Undo/Redo, autosave/reopen and explicit-empty deletion/reopen with disabled export. The gap phase repeats Delete/context-menu/Close All, history, retained source-frame and persistence assertions.

MP4 runtime encoding was not validated: this isolated Electron runtime reports `VideoEncoder` and `VideoDecoder` unavailable before encoding. No export-capability changes were made for the test environment; compositor/source mapping regression tests passed. Native helpers and full installer packaging were not rebuilt for this renderer feature.
