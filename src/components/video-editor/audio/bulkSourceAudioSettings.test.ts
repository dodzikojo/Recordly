import { describe, expect, it } from "vitest";
import {
	patchSelectedSourceAudioTracks,
	summarizeSourceAudioTracks,
} from "./bulkSourceAudioSettings";

describe("bulk source audio settings", () => {
	it("inherits each clip's effective track settings and patches only the changed field", () => {
		const defaults = {
			mixed: { volume: 0.8, normalize: true },
			mic: { volume: 0.4, normalize: false },
		};
		const existing = {
			b: { mixed: { volume: 0.3, normalize: false } },
			c: { mixed: { volume: 0.2, normalize: true } },
		};
		const next = patchSelectedSourceAudioTracks(existing, defaults, ["a", "b"], "mixed", {
			volume: 0.6,
		});
		expect(next.a.mixed).toEqual({ volume: 0.6, normalize: true });
		expect(next.b.mixed).toEqual({ volume: 0.6, normalize: false });
		expect(next.c).toBe(existing.c);
		expect(defaults.mixed.volume).toBe(0.8);
		expect(next.a.mic).toBeUndefined();
	});
	it("reports mixed fields separately without mutating settings", () => {
		const defaults = { mixed: { volume: 1, normalize: false } };
		const existing = { b: { mixed: { volume: 0.3, normalize: false } } };
		expect(summarizeSourceAudioTracks(existing, defaults, ["a", "b"]).mixed).toEqual({
			volume: true,
			normalize: false,
		});
	});
});
