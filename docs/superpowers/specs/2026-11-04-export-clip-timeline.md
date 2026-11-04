# Preserve the complete edited clip sequence during export

Size: L. Video decoding, audio scheduling, and native-export eligibility must agree.

## Problem and evidence

An edited timeline lasts 103.525 seconds, but three MP4 exports at different frame
rates last about 102.25 seconds. Two adjacent clips reuse 1.286 seconds of source
footage. Export currently turns the clips into a union of kept source ranges, losing
the repeated interval. That shortened duration also terminates independent narration.
This is not a final-frame rounding problem.

## Intended behavior

- When clip regions exist, their timeline order and played lengths define the exported
  sequence. Preserve each clip's explicit source start/end, including reused or reordered
  source intervals. Gaps remain omitted, as documented by getEditedDurationMs.
- Use one cumulative output clock and one global constant-frame-rate grid. The total
  frame count is ceil(edited duration * FPS), without accumulating per-cut rounding.
- Keep raw source timestamps for recorded cursor, captions, webcam synchronization and
  existing source-domain visual effects. Preserve compositor and extension hook ordering.
- Source audio follows the same ordered clip slices and authored played lengths. Imported
  narration retains its placement, speed and duration. Mute and companion offsets remain.
- MP4 (modern and legacy), GIF, audio mixing and mux duration agree. Native static-layout
  paths must use a correct clip map or explicitly decline jobs they cannot reproduce.
  Native encoders receiving already-rendered software frames remain allowed.
- Projects without clip regions retain the legacy trim/speed path. No media or project
  migration, persistence changes, automatic source-bound repairs or version bumps.

## Boundaries

Do not redesign editor playback or change the current source-domain representation of
zoom/annotation effects in this fix. Do not pad a shortened movie to hide missing footage.
For repeated source spans, per-clip cursor visibility must identify the current clip,
instead of arbitrarily choosing the first source-time match.

## Acceptance

Regression coverage must fail on the current code for overlapping/reordered source
intervals and prove the final clip and narration survive. Cover mixed speeds, exact
source ends, sub-frame cuts, cumulative rounding, cancellation/frame cleanup, legacy
projects, all exporter call sites, audio slices and native eligibility.

Run TypeScript, full Vitest, lint, translation parity, touched-file formatting and a
production Vite/Electron build plus main-entry smoke. Run an isolated Electron runtime
smoke with synthetic media, exercise real compositors and audio processing, and verify
the muxed MP4's endpoint and final audible/visible content. State any platform codec
limitation accurately; do not change production capability detection to satisfy a test.

## Delivery

Branch codex/fix-export-clip-timeline is based on the unmerged audio-access fix (PR #14).
Stack the new PR on codex/fix-project-audio-access until that PR merges. Do not merge either
PR without user instruction. Commit source changes and checks together; no native helper
binary changes are expected.
