# Gap closing and video clip batch editing

Date: 2026-11-03. Size: L. Owner approved implementation and selected **video clips first**; audio, zooms and annotations retain single-item selection.

## Outcome and decisions

Recordly currently supports one selected video clip. PR #9 adds ripple deletion but intentionally preserves pre-existing gaps. Add gap closing and video clip multi-selection in two reviewable slices.

Use ordinary editor conventions rather than a new editing mode: selectable gaps, Ctrl/Cmd-click toggles, Shift-click ranges, dragging a selection together, and the existing clip inspector for shared settings. A permanent grouping system, marquee selection and mixed-type selection would introduce extra state and are deferred. All operations preserve raw media and explicit source offsets. No project version change is needed.

### Slice 1: close existing gaps

- Identify leading space before the first clip and interior gaps between the sorted video clips. Do not treat unused source duration after the final clip as a gap. Touching clips have no gap.
- A gap can be selected in the video lane and closed with Delete/Backspace, a visible Close Gap control, or its context menu. Selecting a gap clears item selection. Typing in inputs or dialogs never deletes a gap.
- Add Close All Gaps to a mounted timeline toolbar/control area; disable it when there are no gaps. Closing all gaps brings the first clip to zero and packs later clips consecutively.
- Closing one gap moves everything later left by precisely that gap's width; unrelated gaps remain. Recompute gaps from current clips when acting so stale selections cannot remove footage.
- Pin implicit `sourceStartMs` before changing any clip timeline coordinates. Speeds, source bounds, mute and audio settings remain intact.
- Retiming applies to timeline zooms and annotations; keep at least a 1 ms visual region when an entire region was in an empty gap rather than silently deleting it. Imported audio moves its placed start while keeping its own duration and tempo. Source captions, word timings, legacy source-speed regions and recorded sidecars remain in source coordinates.
- Pause safely while editing, retain the current source frame when possible, and realign imported preview audio. One Undo/Redo restores/reapplies a gap closure or Close All operation. Saving/reopening preserves the compacted positions and original source bounds.

### Slice 2: select and edit multiple video clips

- Plain click selects one clip. Ctrl/Cmd-click toggles a clip. Shift-click selects the inclusive timeline-ordered range from a stable anchor; Ctrl/Cmd+Shift-click may add that range. Ctrl/Cmd+A while clips are selected/focused selects all video clips. Keep the existing zoom-select-all behavior when editing zooms. Escape/background clear selection; selecting another item type clears the clip set.
- Retain a primary `selectedClipId` for existing integrations and add transient selected IDs, sanitized on source/project changes and removals. Visually highlight every selected clip and show a selected-count label. Do not persist selection in `.recordly` projects.
- Drag any selected clip to move the whole selection by one common delta. Preserve internal distances, source bounds, duration and speed. Clamp at zero and against unselected clips; never partially move a selection or silently reorder it past an obstacle. Extending the timeline to the right remains supported. Preview all selected positions and clear previews on Escape/cancel.
- Plain pointer-down on a member of an existing selection must preserve that selection until drag intent is resolved; a normal click without drag may collapse to one clip. Edge resizing continues to resize only its targeted clip.
- Visual zooms/annotations wholly owned by selected clips move once with the same delta. Spanning independent narration and separately placed audio remain independent during group drag; source captions/recorded audio follow their existing source anchors. Gap closure still ripples later placed audio as specified above.
- The clip inspector applies existing clip controls to the set: speed, mute, source-audio visibility, source track volume and normalization. Display mixed values clearly; opening the inspector changes nothing. Changing a field updates only that field on selected clips and leaves unselected clips and defaults untouched.
- Bulk speed changes preserve each clip's original source duration and use the same collision protection as existing single-clip speed changes. Validate the whole candidate state, including zoom collisions, before applying; reject atomically with a localized reason. Do not introduce implicit ripple on speed changes.
- Multi-delete should ripple the union of selected spans as one transaction, not loop stale React callbacks. Deleting the whole selection must not resurrect the full raw recording; account for the existing empty-clip/full-source fallback explicitly if supporting an empty edit. Every bulk edit, including source-audio settings, must be one Undo/Redo transaction.

## Architecture and compatibility

Use pure, tested edit planners beside `rippleDelete.ts` for interval collapse, group move, selection transitions and bulk settings. `VideoEditor.tsx` owns authoritative clip selections and atomically commits edit plans. Pass selection/command props through TimelineEditor/runtime/canvas/wrapper, keeping drag math independent of React. Preserve `mapTimelineRegionsToSource` for preview, thumbnails, MP4 and GIF.

Extend history snapshots compatibly with optional defaults for new selection/audio fields; do not invalidate old tests/projects. Source audio settings are already persisted per clip. No native helper or capture changes and no new dependencies are required. All new visible keys must exist in all 11 locales.

## Verification

- TDD for gap discovery/collapse, leading/interior/no gaps, stale gap selection, unsorted and sped-up legacy clips, repeat operations, source bounds, overlay/audio/caption timing, undo and persistence.
- TDD for toggle/range/select-all transitions, stale IDs, group delta bounds and obstacles, noncontiguous selection, speed/source preservation, atomic collision rejection and field-only bulk updates.
- Running Electron smoke using a temporary project/profile: click gap/Delete and context menu; Close All; Ctrl/Shift selection; real group drag, Escape cancel, speed/mute/volume controls, mixed values, one Undo/Redo, save/reopen and source-frame seeks. Do not modify the user's saved project.
- TypeScript, full Vitest, lint (inspect touched-file warnings), translation parity, touched-file formatting, production Vite/Electron build and main CJS smoke for each slice.
- Additional MP4/GIF runtime checks when supported. A prior isolated Electron 43.1.0 smoke showed `VideoEncoder` and `VideoDecoder` undefined even in a secure context, before feature code executed. Report this exact environment limit if it recurs; do not change export capability detection to hide it.

## Delivery

PR #8 (playback fix) is merged on main at `0b8a9edf`. PR #9 (ripple deletion) is open on `codex/ripple-delete-clips` at `6e20bee6`. Build Slice 1 on `codex/timeline-gap-commands` with PR base `codex/ripple-delete-clips`, then Slice 2 on `codex/timeline-multi-select` with PR base `codex/timeline-gap-commands`. Keep the PRs stacked and unmerged pending the owner's next merge instruction. Execution uses fresh implementation-agent sessions, per the working agreement.
