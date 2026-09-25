import { describe, expect, it } from "vitest";
import { normalizeRecordingPreferences } from "./recordingPreferences";

describe("normalizeRecordingPreferences", () => {
	it("defaults legacy files to webcam blur and window framing off", () => {
		expect(normalizeRecordingPreferences({ microphoneEnabled: true })).toEqual({
			microphoneEnabled: true,
			microphoneDeviceId: undefined,
			systemAudioEnabled: false,
			excludeTaskbar: false,
			windowFraming: { enabled: false, topInsetDip: 0 },
			webcamBackgroundBlur: { enabled: false, amount: 12 },
		});
	});

	it("normalizes webcam blur without losing audio preferences", () => {
		expect(
			normalizeRecordingPreferences({
				microphoneDeviceId: "mic-1",
				systemAudioEnabled: true,
				excludeTaskbar: true,
				windowFraming: { enabled: true, topInsetDip: 1_000 },
				webcamBackgroundBlur: { enabled: true, amount: 1_000 },
			}),
		).toEqual({
			microphoneEnabled: false,
			microphoneDeviceId: "mic-1",
			systemAudioEnabled: true,
			excludeTaskbar: true,
			windowFraming: { enabled: true, topInsetDip: 300 },
			webcamBackgroundBlur: { enabled: true, amount: 20 },
		});
	});
});
