import { describe, expect, it } from "vitest";
import {
	isSourceSelected,
	isWindowFramingAvailableForSource,
	type DesktopSource,
} from "./launchPopoverTypes";

const edgeWindow = (id: string): DesktopSource => ({
	id,
	name: "New tab - Microsoft Edge",
	thumbnail: null,
	display_id: "1",
	appIcon: null,
	sourceType: "window",
});

describe("isSourceSelected", () => {
	it("uses source IDs when duplicate windows share the same title", () => {
		const first = edgeWindow("window:101:0");
		const second = edgeWindow("window:202:0");
		expect(isSourceSelected(first, second.id, second.name)).toBe(false);
		expect(isSourceSelected(second, second.id, second.name)).toBe(true);
	});
});

describe("isWindowFramingAvailableForSource", () => {
	it("is available only for Windows window sources", () => {
		expect(isWindowFramingAvailableForSource("win32", edgeWindow("window:101:0"))).toBe(true);
		expect(
			isWindowFramingAvailableForSource("win32", {
				...edgeWindow("screen:1:0"),
				sourceType: "screen",
			}),
		).toBe(false);
		expect(isWindowFramingAvailableForSource("darwin", edgeWindow("window:101:0"))).toBe(false);
	});
});
