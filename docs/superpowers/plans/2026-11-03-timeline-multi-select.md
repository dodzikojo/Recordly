# Slice 2: video clip multi-selection and bulk editing

Spec: `docs/superpowers/specs/2026-11-03-timeline-batch-editing.md`. Fresh implementation-agent session; TDD. Branch `codex/timeline-multi-select`, base the completed gap-commands branch. Video clips only, explicitly chosen by the owner.

- [ ] Read AGENTS.md, the spec and the completed Slice 1 ledger before edits. Inspect selection, item pointer events, drag wrapper/engine and source-audio setting ownership.
- [ ] Add failing pure tests for click/toggle/range/all/clear transitions, stale IDs, group moves and obstacles, preview cancellation and source preservation.
- [ ] Add authoritative selected clip IDs and a primary clip; wire highlight/count, Ctrl/Cmd-click, Shift range, context-aware Ctrl/Cmd+A, Escape/clear and cross-item selection cleanup. Keep multi-selection alive when initiating a drag on a selected member.
- [ ] Implement atomic group drag and matching live previews, common delta bounds, noncontiguous selection, source pinning and visual overlay ownership. Preserve existing one-item resize and no-overlap behavior.
- [ ] Add failing tests for bulk speed/mute/visibility and source-track volume/normalization. Apply only changed fields, display mixed values, inherit defaults correctly, preserve unselected clips, reject invalid speed changes atomically.
- [ ] Extend editor history snapshots compatibly so source-audio bulk settings and selected IDs undo/redo with the edit. Wire group deletion atomically; explicitly prevent empty selections from exposing the original full recording.
- [ ] Add all visible strings in every locale and ensure project/source changes sanitize selections. Selection remains transient, media edits persist without a project-version bump.
- [ ] Run focused tests, TypeScript and lint and review the diff. Parent performs independent real-pointer Electron smoke and full verification and creates a stacked PR.
- [ ] Update this checklist with changed files, exact checks and caveats, then report without committing or switching branches.

Global constraints: use source offsets to preserve footage; timeline edits must agree with preview, MP4/GIF and source audio. Never process camera/media destructively. No native helper changes, no dependency install. Use apply_patch. Preserve unrelated edits and do not bulk-format legacy files. Do not spawn further agents without asking parent for a well-defined file boundary.
