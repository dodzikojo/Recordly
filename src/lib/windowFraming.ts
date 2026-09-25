import {
	normalizeScreenCropRegion,
	type ScreenCropRegion,
	type ScreenRectangle,
} from "./screenCrop";

export interface WindowFramingSettings {
	enabled: boolean;
	topInsetDip: number;
}

export interface WindowFramingGeometry {
	frameBounds: ScreenRectangle;
	clientBounds: ScreenRectangle | null;
	dpiScale: number;
	clientDetected: boolean;
}

export const MIN_WINDOW_FRAMING_TOP_INSET_DIP = 0;
export const MAX_WINDOW_FRAMING_TOP_INSET_DIP = 300;
export const DEFAULT_WINDOW_FRAMING_SETTINGS: Readonly<WindowFramingSettings> = Object.freeze({
	enabled: false,
	topInsetDip: 0,
});

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function isFiniteRectangle(value: ScreenRectangle | null): value is ScreenRectangle {
	return Boolean(
		value &&
			Number.isFinite(value.x) &&
			Number.isFinite(value.y) &&
			Number.isFinite(value.width) &&
			Number.isFinite(value.height) &&
			value.width > 0 &&
			value.height > 0,
	);
}

export function normalizeWindowFramingSettings(value: unknown): WindowFramingSettings {
	const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const topInsetDip =
		typeof candidate.topInsetDip === "number" && Number.isFinite(candidate.topInsetDip)
			? Math.round(
					clamp(
						candidate.topInsetDip,
						MIN_WINDOW_FRAMING_TOP_INSET_DIP,
						MAX_WINDOW_FRAMING_TOP_INSET_DIP,
					),
				)
			: DEFAULT_WINDOW_FRAMING_SETTINGS.topInsetDip;

	return {
		enabled: candidate.enabled === true,
		topInsetDip,
	};
}

export function calculateTopInsetDipFromGuidePosition({
	guideRatio,
	frameBounds,
	clientBounds,
	dpiScale,
}: {
	guideRatio: number;
	frameBounds: ScreenRectangle;
	clientBounds: ScreenRectangle | null;
	dpiScale: number;
}) {
	if (!isFiniteRectangle(frameBounds)) {
		return 0;
	}

	const resolvedGuideRatio = Number.isFinite(guideRatio) ? clamp(guideRatio, 0, 1) : 0;
	const baseTop = isFiniteRectangle(clientBounds)
		? clamp(clientBounds.y - frameBounds.y, 0, frameBounds.height)
		: 0;
	const guideTop = resolvedGuideRatio * frameBounds.height;
	const resolvedDpiScale = Number.isFinite(dpiScale) && dpiScale > 0 ? dpiScale : 1;
	return normalizeWindowFramingSettings({
		enabled: true,
		topInsetDip: Math.max(0, guideTop - baseTop) / resolvedDpiScale,
	}).topInsetDip;
}

export function calculateWindowFramingCropRegion({
	frameBounds,
	clientBounds,
	dpiScale,
	topInsetDip,
}: {
	frameBounds: ScreenRectangle;
	clientBounds: ScreenRectangle | null;
	dpiScale: number;
	topInsetDip: number;
}): ScreenCropRegion | null {
	if (!isFiniteRectangle(frameBounds)) {
		return null;
	}

	const frameRight = frameBounds.x + frameBounds.width;
	const frameBottom = frameBounds.y + frameBounds.height;
	const cropBase = isFiniteRectangle(clientBounds) ? clientBounds : frameBounds;
	const left = clamp(cropBase.x, frameBounds.x, frameRight);
	const top = clamp(cropBase.y, frameBounds.y, frameBottom);
	const right = clamp(cropBase.x + cropBase.width, frameBounds.x, frameRight);
	const bottom = clamp(cropBase.y + cropBase.height, frameBounds.y, frameBottom);
	if (right <= left || bottom <= top) {
		return null;
	}

	const normalizedInset = normalizeWindowFramingSettings({
		enabled: true,
		topInsetDip,
	});
	const resolvedDpiScale = Number.isFinite(dpiScale) && dpiScale > 0 ? dpiScale : 1;
	const insetPixels = normalizedInset.topInsetDip * resolvedDpiScale;
	const croppedTop = Math.min(bottom - 1, top + insetPixels);

	return normalizeScreenCropRegion({
		x: (left - frameBounds.x) / frameBounds.width,
		y: (croppedTop - frameBounds.y) / frameBounds.height,
		width: (right - left) / frameBounds.width,
		height: (bottom - croppedTop) / frameBounds.height,
	});
}
