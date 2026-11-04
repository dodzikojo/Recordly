export const DEFAULT_TIMELINE_PANEL_HEIGHT = 240;
export const TIMELINE_PANEL_HEIGHT_KEY = "recordly.editor.timelinePanelHeight";

export function normalizeTimelinePanelHeight(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 160
		? Math.round(value)
		: DEFAULT_TIMELINE_PANEL_HEIGHT;
}

export function getTimelinePanelBounds(containerHeight: number) {
	const height = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;
	const min = Math.min(160, Math.floor(height));
	return { min, max: Math.max(min, Math.floor(Math.min(height * 0.7, height - 240))) };
}

export function clampTimelinePanelHeight(height: number, containerHeight: number): number {
	const bounds = getTimelinePanelBounds(containerHeight);
	return Math.max(
		bounds.min,
		Math.min(
			bounds.max,
			Number.isFinite(height) ? Math.round(height) : DEFAULT_TIMELINE_PANEL_HEIGHT,
		),
	);
}
