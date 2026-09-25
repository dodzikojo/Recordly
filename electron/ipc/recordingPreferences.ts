import {
	DEFAULT_WEBCAM_BACKGROUND_BLUR,
	normalizeWebcamBackgroundBlurSettings,
	type WebcamBackgroundBlurSettings,
} from "../../src/lib/webcamBackgroundBlur";
import {
	DEFAULT_WINDOW_FRAMING_SETTINGS,
	normalizeWindowFramingSettings,
	type WindowFramingSettings,
} from "../../src/lib/windowFraming";

export interface RecordingPreferences {
	microphoneEnabled: boolean;
	microphoneDeviceId?: string;
	systemAudioEnabled: boolean;
	excludeTaskbar: boolean;
	windowFraming: WindowFramingSettings;
	webcamBackgroundBlur: WebcamBackgroundBlurSettings;
}

export function normalizeRecordingPreferences(value: unknown): RecordingPreferences {
	const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		microphoneEnabled: candidate.microphoneEnabled === true,
		microphoneDeviceId:
			typeof candidate.microphoneDeviceId === "string"
				? candidate.microphoneDeviceId
				: undefined,
		systemAudioEnabled: candidate.systemAudioEnabled === true,
		excludeTaskbar: candidate.excludeTaskbar === true,
		windowFraming: normalizeWindowFramingSettings(
			candidate.windowFraming ?? DEFAULT_WINDOW_FRAMING_SETTINGS,
		),
		webcamBackgroundBlur: normalizeWebcamBackgroundBlurSettings(
			candidate.webcamBackgroundBlur ?? DEFAULT_WEBCAM_BACKGROUND_BLUR,
		),
	};
}
