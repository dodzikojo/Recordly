export interface ScreenCropRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenRectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}

const FULL_FRAME_EPSILON = 1e-6;
const MIN_EXCLUDED_EDGE_PIXELS = 2;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function isFiniteRectangle(value: ScreenRectangle) {
	return (
		Number.isFinite(value.x) &&
		Number.isFinite(value.y) &&
		Number.isFinite(value.width) &&
		Number.isFinite(value.height) &&
		value.width > 0 &&
		value.height > 0
	);
}

export function normalizeScreenCropRegion(value: unknown): ScreenCropRegion | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as Partial<ScreenCropRegion>;
	if (
		!Number.isFinite(candidate.x) ||
		!Number.isFinite(candidate.y) ||
		!Number.isFinite(candidate.width) ||
		!Number.isFinite(candidate.height) ||
		(candidate.width ?? 0) <= 0 ||
		(candidate.height ?? 0) <= 0
	) {
		return null;
	}

	const x = clamp(candidate.x as number, 0, 1);
	const y = clamp(candidate.y as number, 0, 1);
	const width = clamp(candidate.width as number, 0, 1 - x);
	const height = clamp(candidate.height as number, 0, 1 - y);
	if (width <= FULL_FRAME_EPSILON || height <= FULL_FRAME_EPSILON) {
		return null;
	}

	if (
		x <= FULL_FRAME_EPSILON &&
		y <= FULL_FRAME_EPSILON &&
		Math.abs(width - 1) <= FULL_FRAME_EPSILON &&
		Math.abs(height - 1) <= FULL_FRAME_EPSILON
	) {
		return null;
	}

	return { x, y, width, height };
}

export function calculateWorkAreaCropRegion(
	displayBounds: ScreenRectangle,
	workArea: ScreenRectangle,
): ScreenCropRegion | null {
	if (!isFiniteRectangle(displayBounds) || !isFiniteRectangle(workArea)) {
		return null;
	}

	const displayRight = displayBounds.x + displayBounds.width;
	const displayBottom = displayBounds.y + displayBounds.height;
	const workRight = workArea.x + workArea.width;
	const workBottom = workArea.y + workArea.height;
	const left = clamp(workArea.x, displayBounds.x, displayRight);
	const top = clamp(workArea.y, displayBounds.y, displayBottom);
	const right = clamp(workRight, displayBounds.x, displayRight);
	const bottom = clamp(workBottom, displayBounds.y, displayBottom);
	if (right <= left || bottom <= top) {
		return null;
	}

	const excludedEdges = [
		left - displayBounds.x,
		top - displayBounds.y,
		displayRight - right,
		displayBottom - bottom,
	];
	if (excludedEdges.every((inset) => inset < MIN_EXCLUDED_EDGE_PIXELS)) {
		return null;
	}

	return normalizeScreenCropRegion({
		x: (left - displayBounds.x) / displayBounds.width,
		y: (top - displayBounds.y) / displayBounds.height,
		width: (right - left) / displayBounds.width,
		height: (bottom - top) / displayBounds.height,
	});
}
