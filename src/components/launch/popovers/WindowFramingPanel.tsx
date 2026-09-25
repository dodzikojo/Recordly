import { ArrowLeft, ArrowsClockwise } from "@phosphor-icons/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import {
	calculateTopInsetDipFromGuidePosition,
	calculateWindowFramingCropRegion,
	MAX_WINDOW_FRAMING_TOP_INSET_DIP,
	normalizeWindowFramingSettings,
	type WindowFramingGeometry,
	type WindowFramingSettings,
} from "@/lib/windowFraming";
import { mapRawSource, type DesktopSource } from "./launchPopoverTypes";

export function WindowFramingPanel({
	source,
	settings,
	onSettingsChange,
	onBack,
	onDone,
}: {
	source: DesktopSource;
	settings: WindowFramingSettings;
	onSettingsChange: (settings: WindowFramingSettings) => void;
	onBack: () => void;
	onDone: () => void;
}) {
	const t = useScopedT("launch");
	const [geometry, setGeometry] = useState<WindowFramingGeometry | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(source.thumbnail);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestGeneration = useRef(0);
	const dragging = useRef(false);

	const refreshPreview = useCallback(async () => {
		const generation = ++requestGeneration.current;
		setLoading(true);
		setError(null);
		try {
			const [geometryOutcome, sourcesOutcome] = await Promise.allSettled([
				window.electronAPI.getWindowFramingGeometry(source),
				window.electronAPI.getSources({
					types: ["window"],
					thumbnailSize: { width: 640, height: 360 },
					fetchWindowIcons: false,
					forceRefresh: true,
				}),
			]);
			if (generation !== requestGeneration.current) return;

			if (sourcesOutcome.status === "fulfilled") {
				const refreshedSource = sourcesOutcome.value
					.map((candidate) => mapRawSource(candidate as DesktopSource))
					.find((candidate) => candidate.id === source.id);
				setPreviewUrl(refreshedSource?.thumbnail ?? source.thumbnail);
			}

			const geometryResult =
				geometryOutcome.status === "fulfilled" ? geometryOutcome.value : null;
			if (geometryResult?.success && geometryResult.geometry) {
				setGeometry(geometryResult.geometry);
			} else {
				setGeometry(null);
				setError(t("recording.windowFramingUnavailable"));
			}
		} catch (refreshError) {
			if (generation !== requestGeneration.current) return;
			console.warn("Failed to refresh the window framing preview:", refreshError);
			setGeometry(null);
			setError(t("recording.windowFramingUnavailable"));
		} finally {
			if (generation === requestGeneration.current) {
				setLoading(false);
			}
		}
	}, [source, t]);

	useEffect(() => {
		setPreviewUrl(source.thumbnail);
		setGeometry(null);
		setError(null);
		void refreshPreview();
		return () => {
			requestGeneration.current += 1;
		};
	}, [refreshPreview, source.thumbnail]);

	const cropRegion = useMemo(
		() =>
			geometry && settings.enabled
				? calculateWindowFramingCropRegion({
						...geometry,
						topInsetDip: settings.topInsetDip,
					})
				: null,
		[geometry, settings.enabled, settings.topInsetDip],
	);

	const updateTopInset = useCallback(
		(topInsetDip: number) => {
			onSettingsChange(
				normalizeWindowFramingSettings({
					...settings,
					topInsetDip,
				}),
			);
		},
		[onSettingsChange, settings],
	);

	const updateInsetFromPointer = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!settings.enabled || !geometry) return;
			const bounds = event.currentTarget.getBoundingClientRect();
			if (bounds.height <= 0) return;
			updateTopInset(
				calculateTopInsetDipFromGuidePosition({
					...geometry,
					guideRatio: (event.clientY - bounds.top) / bounds.height,
				}),
			);
		},
		[geometry, settings.enabled, updateTopInset],
	);

	const top = (cropRegion?.y ?? 0) * 100;
	const left = (cropRegion?.x ?? 0) * 100;
	const width = (cropRegion?.width ?? 1) * 100;
	const height = (cropRegion?.height ?? 1) * 100;
	const right = Math.max(0, 100 - left - width);
	const bottom = Math.max(0, 100 - top - height);

	return (
		<div className="window-framing-panel">
			<div className="window-framing-header">
				<button type="button" className="window-framing-back" onClick={onBack}>
					<ArrowLeft size={14} />
					{t("recording.changeSource")}
				</button>
				<div className="mt-2 min-w-0">
					<h2 className="text-sm font-semibold text-[var(--launch-text)]">
						{t("recording.windowFraming")}
					</h2>
					<p className="truncate text-[11px] text-[var(--launch-text-muted)]">
						{source.windowTitle || source.name}
					</p>
				</div>
			</div>

			<div className="window-framing-preview-wrap">
				<div
					className="window-framing-preview"
					data-enabled={settings.enabled ? "true" : "false"}
					style={{
						aspectRatio: geometry
							? `${geometry.frameBounds.width} / ${geometry.frameBounds.height}`
							: "16 / 9",
					}}
					onPointerDown={(event) => {
						if (!settings.enabled || !geometry) return;
						dragging.current = true;
						event.currentTarget.setPointerCapture(event.pointerId);
						updateInsetFromPointer(event);
					}}
					onPointerMove={(event) => {
						if (dragging.current) updateInsetFromPointer(event);
					}}
					onPointerUp={(event) => {
						dragging.current = false;
						if (event.currentTarget.hasPointerCapture(event.pointerId)) {
							event.currentTarget.releasePointerCapture(event.pointerId);
						}
					}}
					onPointerCancel={() => {
						dragging.current = false;
					}}
				>
					{previewUrl ? (
						<img src={previewUrl} alt="" draggable={false} />
					) : (
						<div className="window-framing-preview-empty">
							{t("recording.windowPreviewUnavailable")}
						</div>
					)}
					{settings.enabled && geometry ? (
						<>
							<div
								className="window-framing-mask"
								style={{ inset: `0 0 ${100 - top}% 0` }}
							/>
							<div
								className="window-framing-mask"
								style={{
									left: 0,
									top: `${top}%`,
									width: `${left}%`,
									height: `${height}%`,
								}}
							/>
							<div
								className="window-framing-mask"
								style={{
									right: 0,
									top: `${top}%`,
									width: `${right}%`,
									height: `${height}%`,
								}}
							/>
							<div
								className="window-framing-mask"
								style={{ inset: `${100 - bottom}% 0 0 0` }}
							/>
							<div className="window-framing-guide" style={{ top: `${top}%` }}>
								<span />
							</div>
						</>
					) : null}
					{loading ? (
						<div className="window-framing-loading">
							{t("common.loading", "Refreshing...")}
						</div>
					) : null}
				</div>
				<p className="mt-2 text-[10px] leading-4 text-[var(--launch-text-muted)]">
					{t("recording.windowFramingDescription")}
				</p>
			</div>

			<div className="window-framing-controls">
				<div className="flex items-center justify-between gap-3">
					<label
						className="text-xs text-[var(--launch-text)]"
						htmlFor="window-framing-switch"
					>
						{t("recording.hideWindowFrame")}
					</label>
					<Switch
						id="window-framing-switch"
						checked={settings.enabled}
						onCheckedChange={(enabled) => onSettingsChange({ ...settings, enabled })}
					/>
				</div>

				<div className="mt-3">
					<div className="mb-2 flex items-center justify-between gap-3">
						<label
							className="text-[11px] text-[var(--launch-text-muted)]"
							htmlFor="window-top-inset"
						>
							{t("recording.additionalTopInset")}
						</label>
						<div className="window-framing-value">
							<input
								id="window-top-inset"
								type="number"
								min={0}
								max={MAX_WINDOW_FRAMING_TOP_INSET_DIP}
								step={1}
								value={settings.topInsetDip}
								disabled={!settings.enabled}
								onChange={(event) => updateTopInset(Number(event.target.value))}
							/>
							<span>px</span>
						</div>
					</div>
					<Slider
						min={0}
						max={MAX_WINDOW_FRAMING_TOP_INSET_DIP}
						step={1}
						value={[settings.topInsetDip]}
						disabled={!settings.enabled}
						onValueChange={([value]) => updateTopInset(value ?? settings.topInsetDip)}
						aria-label={t("recording.additionalTopInset")}
					/>
				</div>

				{geometry && !geometry.clientDetected ? (
					<p className="mt-2 text-[10px] leading-4 text-amber-500">
						{t("recording.windowFrameDetectionUnavailable")}
					</p>
				) : null}
				{error ? (
					<p className="mt-2 text-[10px] leading-4 text-amber-500">{error}</p>
				) : null}
			</div>

			<div className="window-framing-actions">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="window-framing-refresh"
					onClick={() => void refreshPreview()}
					disabled={loading}
				>
					<ArrowsClockwise size={14} />
					{t("recording.refreshPreview")}
				</Button>
				<Button type="button" size="sm" onClick={onDone}>
					{t("common.done")}
				</Button>
			</div>
		</div>
	);
}
