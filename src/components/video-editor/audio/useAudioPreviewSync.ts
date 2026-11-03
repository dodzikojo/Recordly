import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildResolvedAudioPlan } from "@/lib/exporter/audioRoutingEngine";
import { resolveMediaElementSource } from "@/lib/exporter/localMediaSource";
import {
  clampMediaTimeToDuration,
  enablePitchPreservingPlayback,
  estimateCompanionAudioStartDelaySeconds,
  resolvePreviewMediaDuration,
  setMediaPlaybackRate,
  MAX_MEDIA_PLAYBACK_RATE,
  MIN_MEDIA_PLAYBACK_RATE,
} from "@/lib/mediaTiming";
import {
  mapTimelineTimeToEditedTime,
  type AudioRegion,
  type ClipRegion,
  type SpeedRegion,
} from "../types";
import { hasAudioPreviewTimeJumped, type AudioPreviewClockSample } from "./previewAudioTiming";
import { watchPreviewPlaybackReadiness } from "./previewPlaybackReadiness";
import {
  getAudioResourceVersionKey,
  getVersionedAudioResourceUrl,
  isAudioResourceLoadCurrent,
} from "./audioResourceVersion";

const SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_DRIFT_SECONDS = 0.18;
const SOURCE_AUDIO_PREVIEW_PAUSED_SEEK_DRIFT_SECONDS = 0.01;

interface UseAudioPreviewSyncParams {
  audioRegions: AudioRegion[];
  previewVolume: number;
  isPlaying: boolean;
  currentTime: number;
  timelineTime: number;
  clipRegions: ClipRegion[];
  previewSeekVersion: number;
  playbackVideo?: HTMLVideoElement | null;
  duration: number;
  effectiveSpeedRegions: SpeedRegion[];
  previewSourceAudioFallbackPaths: string[];
  sourceAudioFallbackStartDelayMsByPath: Record<string, number>;
  sourceAudioResourceVersion: number;
  isCurrentClipMuted: boolean;
  getSourceTrackPreviewGain: (audioPath: string) => number;
  onSourceFallbackLoadError: (error: unknown) => void;
}

export function useAudioPreviewSync({
  audioRegions,
  previewVolume,
  isPlaying,
  currentTime,
  timelineTime,
  clipRegions,
  previewSeekVersion,
  playbackVideo,
  duration,
  effectiveSpeedRegions,
  previewSourceAudioFallbackPaths,
  sourceAudioFallbackStartDelayMsByPath,
  sourceAudioResourceVersion,
  isCurrentClipMuted,
  getSourceTrackPreviewGain,
  onSourceFallbackLoadError,
}: UseAudioPreviewSyncParams) {
  const resolvedPlan = useMemo(
    () =>
      buildResolvedAudioPlan({
        videoResource: null,
        sourceAudioFallbackPaths: previewSourceAudioFallbackPaths,
        audioRegions,
      }),
    [audioRegions, previewSourceAudioFallbackPaths],
  );
  const resolvedUserTracks = useMemo(
    () => resolvedPlan.tracks.filter((track) => track.kind === "user"),
    [resolvedPlan],
  );
  const resolvedSourceTracks = useMemo(
    () => resolvedPlan.tracks.filter((track) => track.kind !== "user"),
    [resolvedPlan],
  );

  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioElementRevokersRef = useRef<Map<string, () => void>>(new Map());
  const audioElementResourcesRef = useRef<Map<string, string>>(new Map());
  const sourceAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const sourceAudioMediaNodesRef = useRef<Map<string, MediaElementAudioSourceNode>>(new Map());
  const sourceAudioGainNodesRef = useRef<Map<string, GainNode>>(new Map());
  const sourceAudioElementRevokersRef = useRef<Map<string, () => void>>(new Map());
  const sourceAudioElementResourcesRef = useRef<Map<string, string>>(new Map());
  const sourceAudioContextRef = useRef<AudioContext | null>(null);
  const sourceAudioMasterGainRef = useRef<GainNode | null>(null);
  const sourceAudioResumePromiseRef = useRef<Promise<void> | null>(null);
  const lastSourceAudioSyncTimeRef = useRef<AudioPreviewClockSample | null>(null);
  const lastSourceSeekVersionRef = useRef(previewSeekVersion);
  const userAudioSyncRef = useRef(
    new Map<string, { startMs: number; seekVersion: number; playing: boolean }>(),
  );
  const [playbackReady, setPlaybackReady] = useState(true);
  const audioPlaybackAllowedRef = useRef(false);
  audioPlaybackAllowedRef.current = isPlaying && playbackReady;

  useEffect(() => {
    if (!playbackVideo) {
      setPlaybackReady(true);
      return;
    }
    return watchPreviewPlaybackReadiness(playbackVideo, setPlaybackReady, () => {
      for (const audio of audioElementsRef.current.values()) audio.pause();
      for (const audio of sourceAudioElementsRef.current.values()) audio.pause();
    });
  }, [playbackVideo]);

  const ensureSourceAudioContext = useCallback(() => {
    if (!sourceAudioContextRef.current) {
      const context = new AudioContext({ latencyHint: "interactive" });
      const masterGain = context.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(context.destination);
      sourceAudioContextRef.current = context;
      sourceAudioMasterGainRef.current = masterGain;
    }
    return sourceAudioContextRef.current;
  }, []);

  const ensureSourceAudioRunning = useCallback(() => {
    const context = ensureSourceAudioContext();
    if (context.state === "running") {
      return Promise.resolve();
    }
    if (!sourceAudioResumePromiseRef.current) {
      sourceAudioResumePromiseRef.current = context
        .resume()
        .catch(() => undefined)
        .finally(() => {
          sourceAudioResumePromiseRef.current = null;
        });
    }
    return sourceAudioResumePromiseRef.current;
  }, [ensureSourceAudioContext]);

  const playSourceAudioPreview = useCallback(() => {
    if (playbackVideo && (playbackVideo.seeking || playbackVideo.readyState < 2)) return;
    void ensureSourceAudioRunning().then(() => {
      if (!audioPlaybackAllowedRef.current) return;
      for (const audio of sourceAudioElementsRef.current.values()) {
        if (!audio.src) continue;
        audio.play().catch(() => undefined);
      }
    });
  }, [ensureSourceAudioRunning, playbackVideo]);

  useEffect(() => {
    const existing = audioElementsRef.current;
    const currentIds = new Set(resolvedUserTracks.map((track) => track.id));

    for (const [id, audio] of existing) {
      if (!currentIds.has(id)) {
        audio.pause();
        audio.src = "";
        audioElementRevokersRef.current.get(id)?.();
        audioElementRevokersRef.current.delete(id);
        audioElementResourcesRef.current.delete(id);
        userAudioSyncRef.current.delete(id);
        existing.delete(id);
      }
    }

    for (const track of resolvedUserTracks) {
      let audio = existing.get(track.id);
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        existing.set(track.id, audio);
      }

      if (audioElementResourcesRef.current.get(track.id) !== track.sourceRef.path) {
        audio.pause();
        audio.src = "";
        audioElementRevokersRef.current.get(track.id)?.();
        audioElementRevokersRef.current.delete(track.id);
        audioElementResourcesRef.current.set(track.id, track.sourceRef.path);

        void (async () => {
          const resolved = await resolveMediaElementSource(track.sourceRef.path);
          const latestAudio = existing.get(track.id);

          if (
            latestAudio !== audio ||
            audioElementResourcesRef.current.get(track.id) !== track.sourceRef.path
          ) {
            resolved.revoke();
            return;
          }

          audioElementRevokersRef.current.set(track.id, resolved.revoke);
          latestAudio.src = resolved.src;
        })();
      }

      audio.volume = Math.max(0, Math.min(1, track.gain * previewVolume));
    }
  }, [previewVolume, resolvedUserTracks]);

  useEffect(() => {
    const existing = sourceAudioElementsRef.current;
    const currentIds = new Set(resolvedSourceTracks.map((track) => track.sourceRef.path));

    for (const [id, audio] of existing) {
      if (!currentIds.has(id)) {
        audio.pause();
        audio.src = "";
        sourceAudioMediaNodesRef.current.get(id)?.disconnect();
        sourceAudioMediaNodesRef.current.delete(id);
        sourceAudioGainNodesRef.current.get(id)?.disconnect();
        sourceAudioGainNodesRef.current.delete(id);
        sourceAudioElementRevokersRef.current.get(id)?.();
        sourceAudioElementRevokersRef.current.delete(id);
        sourceAudioElementResourcesRef.current.delete(id);
        existing.delete(id);
      }
    }

    for (const track of resolvedSourceTracks) {
      const audioPath = track.sourceRef.path;
      const resourceKey = getAudioResourceVersionKey(audioPath, sourceAudioResourceVersion);
      let audio = existing.get(audioPath);
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        audio.crossOrigin = "anonymous";
        existing.set(audioPath, audio);
      }
      audio.volume = 1;
      audio.dataset.sourceAudioPath = audioPath;

      // Web Audio API createMediaElementSource breaks preservesPitch on Chromium.
      // We route directly through the HTMLAudioElement to ensure pitch preservation works
      // during speed changes. Note: this limits maximum preview volume to 1.0 (100%).

      if (sourceAudioElementResourcesRef.current.get(audioPath) !== resourceKey) {
        audio.pause();
        audio.src = "";
        sourceAudioElementRevokersRef.current.get(audioPath)?.();
        sourceAudioElementRevokersRef.current.delete(audioPath);
        sourceAudioElementResourcesRef.current.set(audioPath, resourceKey);

        // Resource identity, not effect lifetime, decides staleness. Playback and fallback
        // rerenders must not cancel the only load for the current finalized sidecar version.
        void (async () => {
          try {
            const resolved = await resolveMediaElementSource(audioPath);
            const latestAudio = existing.get(audioPath);

            if (
              latestAudio !== audio ||
              !isAudioResourceLoadCurrent(
                sourceAudioElementResourcesRef.current,
                audioPath,
                resourceKey,
              )
            ) {
              resolved.revoke();
              return;
            }

            sourceAudioElementRevokersRef.current.set(audioPath, resolved.revoke);
            latestAudio.src = getVersionedAudioResourceUrl(
              resolved.src,
              sourceAudioResourceVersion,
            );
            latestAudio.load();
            if (isPlaying) {
              playSourceAudioPreview();
            }
          } catch (error) {
            const latestAudio = existing.get(audioPath);
            if (
              latestAudio !== audio ||
              !isAudioResourceLoadCurrent(
                sourceAudioElementResourcesRef.current,
                audioPath,
                resourceKey,
              )
            ) {
              return;
            }

            sourceAudioElementRevokersRef.current.get(audioPath)?.();
            sourceAudioElementRevokersRef.current.delete(audioPath);
            sourceAudioElementResourcesRef.current.delete(audioPath);
            if (latestAudio === audio) {
              latestAudio.pause();
              latestAudio.src = "";
            }
            onSourceFallbackLoadError(error);
          }
        })();
      }

      audio.volume = Math.max(
        0,
        Math.min(
          1,
          getSourceTrackPreviewGain(audioPath) * (isCurrentClipMuted ? 0 : previewVolume),
        ),
      );
    }

    if (sourceAudioMasterGainRef.current) {
      sourceAudioMasterGainRef.current.gain.value = isCurrentClipMuted
        ? 0
        : Math.max(0, Math.min(1, previewVolume));
    }

    if (resolvedSourceTracks.length === 0) {
      lastSourceAudioSyncTimeRef.current = null;
    }
  }, [
    getSourceTrackPreviewGain,
    isPlaying,
    isCurrentClipMuted,
    onSourceFallbackLoadError,
    resolvedSourceTracks,
    sourceAudioResourceVersion,
    previewVolume,
    playSourceAudioPreview,
  ]);

  useEffect(() => {
    return () => {
      for (const audio of audioElementsRef.current.values()) {
        audio.pause();
        audio.src = "";
      }
      for (const revoke of audioElementRevokersRef.current.values()) {
        revoke();
      }
      audioElementsRef.current.clear();
      audioElementRevokersRef.current.clear();
      audioElementResourcesRef.current.clear();
      for (const audio of sourceAudioElementsRef.current.values()) {
        audio.pause();
        audio.src = "";
      }
      for (const node of sourceAudioMediaNodesRef.current.values()) {
        node.disconnect();
      }
      for (const node of sourceAudioGainNodesRef.current.values()) {
        node.disconnect();
      }
      for (const revoke of sourceAudioElementRevokersRef.current.values()) {
        revoke();
      }
      sourceAudioElementsRef.current.clear();
      sourceAudioMediaNodesRef.current.clear();
      sourceAudioGainNodesRef.current.clear();
      sourceAudioElementRevokersRef.current.clear();
      sourceAudioElementResourcesRef.current.clear();
      if (sourceAudioMasterGainRef.current) {
        sourceAudioMasterGainRef.current.disconnect();
        sourceAudioMasterGainRef.current = null;
      }
      const context = sourceAudioContextRef.current;
      sourceAudioContextRef.current = null;
      sourceAudioResumePromiseRef.current = null;
      if (context) {
        void context.close();
      }
      lastSourceAudioSyncTimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const currentTimeMs = mapTimelineTimeToEditedTime(timelineTime * 1000, clipRegions);

    for (const track of resolvedUserTracks) {
      const audio = audioElementsRef.current.get(track.id);
      if (!audio) continue;

      const startMs = mapTimelineTimeToEditedTime(track.timelineBinding.startMs, clipRegions);
      const endMs = startMs + track.timelineBinding.endMs - track.timelineBinding.startMs;
      const isInRegion = currentTimeMs >= startMs && currentTimeMs < endMs;
      const previous = userAudioSyncRef.current.get(track.id);
      const shouldAlign =
        !previous ||
        !previous.playing ||
        !isPlaying ||
        previous.startMs !== startMs ||
        previous.seekVersion !== previewSeekVersion;
      userAudioSyncRef.current.set(track.id, {
        startMs,
        seekVersion: previewSeekVersion,
        playing: isPlaying && playbackReady && isInRegion,
      });

      const audioOffset = Math.max(0, (currentTimeMs - startMs) / 1000);
      // Align on explicit seeks, edits and playback starts. Chasing each video frame
      // repeatedly flushes the audio decoder, especially at high preview speeds.
      if (
        isInRegion &&
        shouldAlign &&
        (!isPlaying || playbackReady) &&
        !audio.seeking &&
        Math.abs(audio.currentTime - audioOffset) > 0.01
      ) {
        audio.currentTime = audioOffset;
      }
      if (isPlaying && playbackReady && isInRegion && !audio.ended) {
        enablePitchPreservingPlayback(audio);
        // Imported music/voiceover owns its timeline; only recorded source audio
        // follows video speed.
        if (audio.playbackRate !== 1) {
          setMediaPlaybackRate(audio, 1);
        }
        if (audio.paused) {
          audio.play().catch(() => undefined);
        }
      } else if (!audio.paused) {
        audio.pause();
      }
    }
  }, [clipRegions, previewSeekVersion, playbackReady, isPlaying, resolvedUserTracks, timelineTime]);

  useEffect(() => {
    if (resolvedSourceTracks.length === 0) {
      lastSourceAudioSyncTimeRef.current = null;
      return;
    }

    const sourcePlaybackTime = playbackVideo?.currentTime ?? currentTime;
    const activeSpeedRegion = effectiveSpeedRegions.find(
      (region) =>
        sourcePlaybackTime * 1000 >= region.startMs && sourcePlaybackTime * 1000 < region.endMs,
    );
    const targetPlaybackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
    const now = performance.now();
    const timelineJumped =
      hasAudioPreviewTimeJumped(lastSourceAudioSyncTimeRef.current, sourcePlaybackTime, now) ||
      lastSourceSeekVersionRef.current !== previewSeekVersion;
    const driftThreshold = isPlaying
      ? SOURCE_AUDIO_PREVIEW_PLAYING_SEEK_DRIFT_SECONDS
      : SOURCE_AUDIO_PREVIEW_PAUSED_SEEK_DRIFT_SECONDS;
    if (sourceAudioMasterGainRef.current) {
      sourceAudioMasterGainRef.current.gain.value = isCurrentClipMuted
        ? 0
        : Math.max(0, Math.min(1, previewVolume));
    }

    for (const audio of sourceAudioElementsRef.current.values()) {
      const sourceAudioPath = audio.dataset.sourceAudioPath ?? "";
      audio.volume = Math.max(
        0,
        Math.min(
          1,
          getSourceTrackPreviewGain(sourceAudioPath) * (isCurrentClipMuted ? 0 : previewVolume),
        ),
      );

      enablePitchPreservingPlayback(audio);
      const audioDuration = resolvePreviewMediaDuration(audio.duration, duration);
      const isMicCompanionTrack = /\.mic\./i.test(sourceAudioPath);
      const rawStartDelaySeconds = estimateCompanionAudioStartDelaySeconds(
        duration,
        audioDuration,
        sourceAudioFallbackStartDelayMsByPath[sourceAudioPath],
      );
      const maxPreviewStartDelaySeconds = isMicCompanionTrack ? 2 : 5;
      const startDelaySeconds = isMicCompanionTrack
        ? 0
        : Number.isFinite(duration) &&
            (rawStartDelaySeconds >= Math.max(0, duration - 0.01) ||
              rawStartDelaySeconds > Math.max(maxPreviewStartDelaySeconds, duration * 0.9))
          ? 0
          : rawStartDelaySeconds;
      const beforeAudioStart = sourcePlaybackTime + 0.001 < startDelaySeconds;
      const targetTime = clampMediaTimeToDuration(
        sourcePlaybackTime - startDelaySeconds,
        audioDuration,
      );

      const shouldSeek =
        !audio.seeking &&
        (timelineJumped ||
          (!isPlaying && Math.abs(audio.currentTime - targetTime) > driftThreshold));
      if (shouldSeek) {
        try {
          audio.currentTime = targetTime;
        } catch {
          // no-op
        }
      }

      // Use a steady rate for recorded audio; per-frame tempo correction is audible.
      const syncedPlaybackRate = targetPlaybackRate;
      if (
        Math.abs(audio.playbackRate - Math.min(MAX_MEDIA_PLAYBACK_RATE, syncedPlaybackRate)) > 0.001
      ) {
        setMediaPlaybackRate(audio, syncedPlaybackRate);
      }

      const atEnd = audioDuration !== null && targetTime >= audioDuration;
      if (isPlaying && playbackReady && !beforeAudioStart && !atEnd) {
        void ensureSourceAudioRunning().then(() => {
          if (!audioPlaybackAllowedRef.current) return;
          audio.play().catch(() => undefined);
        });
      } else if (!audio.paused) {
        audio.pause();
      }
    }

    lastSourceAudioSyncTimeRef.current = {
      time: sourcePlaybackTime,
      now,
      rate:
        isPlaying && playbackReady
          ? Math.max(MIN_MEDIA_PLAYBACK_RATE, Math.min(MAX_MEDIA_PLAYBACK_RATE, targetPlaybackRate))
          : 0,
    };
    lastSourceSeekVersionRef.current = previewSeekVersion;
  }, [
    currentTime,
    previewSeekVersion,
    playbackVideo,
    playbackReady,
    duration,
    effectiveSpeedRegions,
    getSourceTrackPreviewGain,
    isCurrentClipMuted,
    isPlaying,
    previewVolume,
    resolvedSourceTracks,
    sourceAudioFallbackStartDelayMsByPath,
    ensureSourceAudioRunning,
  ]);

  return { playSourceAudioPreview };
}
