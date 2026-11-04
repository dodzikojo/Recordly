# Export clip sequence implementation and handoff

Spec: ../specs/2026-11-04-export-clip-timeline.md

## Global constraints

- Execute implementation in a fresh agent session, per the repository owner's L-work
  agreement. All agents share this checkout; no additional worktree is needed.
- Use Node 22 at C:/Users/dodzi/AppData/Local/Temp/recordly-node22/node-v22.23.4-win-x64/node.exe.
- No npm install, native helper rebuilds, real user-project writes, or bulk formatting.
- Independent narration is timeline-placed; use existing getUserAudioOutputRegion to
  omit timeline gaps, never apply video speed to its tempo or length.
- Source timestamps remain raw for webcam/cursor/effects. Preserve frame ownership and
  bounded queues. Source end pinning is intentional: don't derive it solely from speed.
- ForwardFrameSource explicitly rejects backward requests; it cannot alone solve reuse.
- Wait for the editor document to finish initializing before inspecting WebCodecs.
  An early probe misleadingly reported missing globals; the initialized Electron 43
  editor provides VideoDecoder/VideoEncoder and can run actual end-to-end exports.

## Steps

1. Add failing tests for an ordered sequence with overlapping/reordered source spans,
   mixed speeds, pinned source ends and a final clip. Define reusable ordered clip slices
   with cumulative output bounds, using played timeline lengths as authoritative.
2. Feed those slices through StreamingVideoDecoder with one global frame grid. Support
   backward source cuts by restarting/range-reading at a suitable keyframe, retaining the
   fast forward path where possible. Close frames/readers/decoder on failure or cancel.
3. Pass clip regions to duration calculation and decoding in modern MP4, legacy MP4 and
   GIF. Preserve raw source timestamps, and select the correct per-clip cursor behavior.
4. Reuse the ordered slices in AudioProcessor, including embedded/sidecar scheduling,
   per-clip mute and final narration. Ensure mux duration matches played clip duration.
5. Correct native timeline duration/maps, or add a precise static-layout skip reason for
   unsupported sequences. Add tests; do not disable native software-frame encoding.
6. Run focused regressions then TypeScript. Root reviews changes and runs full quality,
   production build and isolated runtime smoke. Resolve failures before committing/PR.

## Ownership and current status

- Root: investigation, spec/plan, runtime smoke tooling, review, full validation, Git/PR.
- Fresh implementation agent: exporter source and unit tests, focused validation.
- Status: implementation, review and final verification complete.
- Baseline: d999f49982955da7419a03b84d7033503c6601a6; working tree initially clean.
- Root verified PR #14 remains open, based on main 45ec46be.
- Evidence: source-union duration 102238.175ms versus authored 103525ms; repeated raw
  interval 1286ms. Synthetic tests should reproduce this generically, without private
  project names, paths, audio content or other personal data.
- Runtime baseline: tools/playwright/smoke-export-timeline.cjs generated four clips with
  mixed speed and one second of reused source. Modern MP4 contains 150 frames/5 seconds
  versus expected 180 frames/6 seconds. The initialized real Electron editor and production
  exporters ran successfully; verification correctly failed on the shortened video.
- Implemented: shared ordered slices and legacy-equivalence comparison; global CFR
  decoder with keyframe restart for backward cuts; clip-aware MP4/GIF/audio duration;
  ordered source audio with independent narration; native static-layout skip reason
  unsupported-clip-sequence; active-clip cursor selection with hidden-click masking;
  backward webcam decoding with cancellation-generation protection.
- Review preserved ordinary copy/trim/filtergraph audio paths for equivalent clips,
  avoiding a pitch/performance regression. Source paths and project data are unchanged.
- Final automated checks: TypeScript exit 0; 147 Vitest files, 1393 passed, 2 skipped;
  full lint exit 0 (21 existing hook warnings); i18n parity exit 0; all 15 touched
  TypeScript/CJS files formatted; git diff --check clean.
- Runtime synthetic fixture: real Electron modern MP4, modern source-audio MP4 and
  legacy MP4 each retain 180 frames/6 seconds; GIF retains 60 frames/6 seconds.
  Decoded pixels prove the reused footage appears twice and the final green marker
  survives; decoded audio proves the final quarter-second remains audible.
- Delivery branch: codex/fix-export-clip-timeline, stacked on PR #14's audio-access branch.
- Existing-project snapshot passed: 103525ms authored duration; output video 2485 frames
  at 24fps / 103.541667s, audio 103.530667s. Ending narration decoded at RMS 1289.8.
  Production Vite/Electron build, main CJS smoke and 9 segmentation-asset/notice checks
  passed. No installer/native-helper rebuild was performed.
- Repeat runtime caught a real decoder shutdown deadlock after all 180 frames rendered.
  CDP inspection found stopped=true, cancelRead fulfilled, feed pending, decode queue=0
  and 12 pending frames plus held/lookahead surfaces. Fixing release/close-before-feed
  ordering, plus dequeue backpressure wakeups, with regression tests before final rerun.
- Shutdown ordering and dequeue wakeups are fixed in screen/webcam decoders. Both
  regressions failed before the changes and pass afterward. Final real Electron smoke
  completed three consecutive rounds (12 exports) and a fresh existing-project snapshot.
  All repeated frames, ending pixels, ending audio and frame counts passed. Fresh project
  snapshot again exported 103.542 seconds. Final production renderer/Electron build passed.
