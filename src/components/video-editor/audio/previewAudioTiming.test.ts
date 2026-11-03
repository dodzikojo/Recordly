import { describe, expect, it } from "vitest";
import { hasAudioPreviewTimeJumped, getUserAudioOutputRegion } from "./previewAudioTiming";

describe("audio preview clock", () => {
	it("does not mistake normal high-speed playback or a delayed update for a seek", () => {
		expect(hasAudioPreviewTimeJumped({ time: 10, now: 1000, rate: 10 }, 10.5, 1050)).toBe(
			false,
		);
		expect(hasAudioPreviewTimeJumped({ time: 10, now: 1000, rate: 16 }, 18, 1500)).toBe(false);
	});
	it("detects actual forward and backward seeks", () => {
		expect(hasAudioPreviewTimeJumped({ time: 10, now: 1000, rate: 10 }, 30, 1050)).toBe(true);
		expect(hasAudioPreviewTimeJumped({ time: 10, now: 1000, rate: 10 }, 5, 1050)).toBe(true);
	});
	it("keeps imported audio at its own full duration across video cuts", () => {
		const region = {
			id: "voice",
			startMs: 1000,
			endMs: 11000,
			audioPath: "voice.wav",
			volume: 1,
		};
		const clips = [
			{ id: "one", startMs: 1000, endMs: 3000, speed: 5 },
			{ id: "two", startMs: 10000, endMs: 12000, speed: 2 },
		];
		expect(getUserAudioOutputRegion(region, clips)).toEqual({
			...region,
			startMs: 0,
			endMs: 10000,
		});
	});
});
