# Slice 1: close existing timeline gaps

Spec: `docs/superpowers/specs/2026-11-03-timeline-batch-editing.md`. Fresh implementation-agent session; TDD. Branch `codex/timeline-gap-commands`, base `codex/ripple-delete-clips` (`6e20bee6`). No additional dependencies.

- [ ] Read AGENTS.md and the spec. Inspect the actual mounted timeline controls in VideoEditor; TimelineToolbar may be unused.
- [ ] Write failing unit tests for leading/interior gap discovery, no trailing gap, stale span validation, one/all collapse, source pinning on legacy sped-up clips, overlays, independent narration duration and source captions.
- [ ] Implement pure gap plans beside rippleDelete.ts. Preserve every clip/source frame; share appropriate collapse math without changing ripple-delete semantics. Reject stale/non-gap input.
- [ ] Wire an atomic gap command in VideoEditor, one history entry per operation, pause/preview realignment and selected-gap cleanup.
- [ ] Add a selectable accessible gap UI in the mounted video lane; Delete/Backspace, Close Gap button/context menu; Close All Gaps in mounted controls. Respect input/dialog keyboard guards. Preserve existing item handlers.
- [ ] Add visible strings to all locales, matching the base-locale structure without bulk reformatting.
- [ ] Run focused tests, TypeScript and lint; inspect the diff. Parent performs independent runtime smoke, full checks and creates the stacked PR.
- [ ] Update this checklist with exact changed files, test commands/results and any remaining caveat; report to parent without committing or switching branches.

Global constraints: raw files and user projects unchanged; timeline/source coordinates are distinct; use getClipSourceStartMs before moving a legacy clip; source captions/recorded audio/legacy source speeds do not shift. Gaps close without deleting overlays. Imported audio keeps its duration/tempo. Use apply_patch. Do not use normal npm install or build native helpers. Do not edit shared/global AGENTS.md. Do not spawn further agents for this bounded slice.
