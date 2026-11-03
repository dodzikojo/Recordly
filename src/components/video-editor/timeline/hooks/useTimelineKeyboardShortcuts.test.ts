import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import { useTimelineKeyboardShortcuts } from "./useTimelineKeyboardShortcuts";

vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));

class TargetElement {
	constructor(readonly selector = "button") {}
	closest(selectors: string) {
		return selectors.includes(this.selector) ? this : null;
	}
}

let keydown: (event: KeyboardEvent) => void;
let modalOpen = false;

function setup(overrides: Partial<Parameters<typeof useTimelineKeyboardShortcuts>[0]> = {}) {
	const params: Parameters<typeof useTimelineKeyboardShortcuts>[0] = {
		isMac: false,
		keyShortcuts: DEFAULT_SHORTCUTS,
		isTimelineFocusedRef: { current: true },
		hasAnyZoomBlocks: true,
		activateSelectAllZooms: vi.fn(),
		annotationCount: 0,
		selectedKeyframeId: null,
		selectedZoomId: null,
		selectedGap: { startMs: 1000, endMs: 2000 },
		selectAllBlocksActive: false,
		addKeyframe: vi.fn(),
		handleAddZoom: vi.fn(),
		handleSplitClip: vi.fn(),
		handleAddAnnotation: vi.fn(),
		deleteSelectedKeyframe: vi.fn(),
		deleteSelectedZoom: vi.fn(),
		deleteSelectedClip: vi.fn(),
		deleteSelectedAnnotation: vi.fn(),
		deleteSelectedAudio: vi.fn(),
		deleteSelectedCaption: vi.fn(),
		closeSelectedGap: vi.fn(),
		clearSelectedGap: vi.fn(),
		cycleAnnotationsAtCurrentTime: vi.fn(),
		...overrides,
	};
	useTimelineKeyboardShortcuts(params);
	return params;
}

function press(key: string, overrides: Partial<KeyboardEvent> = {}) {
	const event = {
		key,
		target: new TargetElement(),
		defaultPrevented: false,
		isComposing: false,
		repeat: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		preventDefault: vi.fn(),
		...overrides,
	} as unknown as KeyboardEvent;
	keydown(event);
	return event;
}

beforeEach(() => {
	modalOpen = false;
	vi.stubGlobal("Element", TargetElement);
	vi.stubGlobal("window", {
		addEventListener: (_: string, listener: typeof keydown) => {
			keydown = listener;
		},
		removeEventListener: vi.fn(),
	});
	vi.stubGlobal("document", { querySelector: () => (modalOpen ? {} : null) });
});
afterEach(() => vi.unstubAllGlobals());

describe("timeline gap keyboard commands", () => {
	it("selects all clips in clip context and retains zoom select-all outside it", () => {
		const params = setup({
			selectedGap: null,
			selectedClipId: "a",
			activateSelectAllClips: vi.fn(),
		});
		press("a", { ctrlKey: true });
		expect(params.activateSelectAllClips).toHaveBeenCalledOnce();
		expect(params.activateSelectAllZooms).not.toHaveBeenCalled();
		const zoom = setup({ selectedGap: null, selectedZoomId: "zoom" });
		press("a", { ctrlKey: true });
		expect(zoom.activateSelectAllZooms).toHaveBeenCalledOnce();
	});
	it("clears clip selection with Escape even after settings focus", () => {
		const params = setup({
			selectedGap: null,
			selectedClipId: "a",
			isTimelineFocusedRef: { current: false },
			clearSelectedBlocks: vi.fn(),
		});
		press("Escape");
		expect(params.clearSelectedBlocks).toHaveBeenCalledOnce();
	});
	it.each([
		"Delete",
		"Backspace",
	])("closes the selected gap with %s even after toolbar focus", (key) => {
		const params = setup({ isTimelineFocusedRef: { current: false } });
		const event = press(key);
		expect(params.closeSelectedGap).toHaveBeenCalledOnce();
		expect(params.deleteSelectedClip).not.toHaveBeenCalled();
		expect(event.preventDefault).toHaveBeenCalledOnce();
	});

	it.each([
		"input",
		"textarea",
		"select",
		"[contenteditable]",
		'[role="dialog"]',
		'[role="alertdialog"]',
	])("does not edit while typing in %s", (selector) => {
		const params = setup();
		press("Delete", { target: new TargetElement(selector) as unknown as EventTarget });
		expect(params.closeSelectedGap).not.toHaveBeenCalled();
	});

	it("does not edit behind an open dialog even if focus is outside it", () => {
		const params = setup();
		modalOpen = true;
		press("Backspace");
		expect(params.closeSelectedGap).not.toHaveBeenCalled();
	});

	it.each([
		"defaultPrevented",
		"isComposing",
		"repeat",
	] as const)("ignores %s events", (property) => {
		const params = setup();
		press("Delete", { [property]: true });
		expect(params.closeSelectedGap).not.toHaveBeenCalled();
	});

	it("clears a gap with Escape and keeps existing item deletion dispatch", () => {
		const params = setup();
		press("Escape");
		expect(params.clearSelectedGap).toHaveBeenCalledOnce();
		expect(params.closeSelectedGap).not.toHaveBeenCalled();
		const clipParams = setup({ selectedGap: null, selectedClipId: "clip" });
		press("Delete");
		expect(clipParams.deleteSelectedClip).toHaveBeenCalledOnce();
		expect(clipParams.closeSelectedGap).not.toHaveBeenCalled();
	});
});
