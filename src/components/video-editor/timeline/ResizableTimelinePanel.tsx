import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { loadAppSetting, saveAppSetting } from "@/lib/appSettings";
import {
	clampTimelinePanelHeight,
	DEFAULT_TIMELINE_PANEL_HEIGHT,
	getTimelinePanelBounds,
	normalizeTimelinePanelHeight,
	TIMELINE_PANEL_HEIGHT_KEY,
} from "./timelinePanelLayout";

export default function ResizableTimelinePanel({ children }: { children: ReactNode }) {
	const t = useScopedT("timeline");
	const panelRef = useRef<HTMLDivElement>(null);
	const [preferredHeight, setPreferredHeight] = useState(() =>
		normalizeTimelinePanelHeight(loadAppSetting(TIMELINE_PANEL_HEIGHT_KEY)),
	);
	const preferredHeightRef = useRef(preferredHeight);
	const [containerHeight, setContainerHeight] = useState(window.innerHeight);
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<{
		pointerId: number;
		startY: number;
		startHeight: number;
		originalPreference: number;
	} | null>(null);
	const height = clampTimelinePanelHeight(preferredHeight, containerHeight);
	const bounds = getTimelinePanelBounds(containerHeight);

	useLayoutEffect(() => {
		const parent = panelRef.current?.parentElement;
		if (!parent) return;
		const measure = () => setContainerHeight(parent.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	const updateHeight = (next: number) => {
		preferredHeightRef.current = next;
		setPreferredHeight(next);
	};
	const cancelDrag = () => {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = null;
		updateHeight(drag.originalPreference);
		setIsDragging(false);
	};

	useEffect(() => {
		if (!isDragging) return;
		const { cursor, userSelect } = document.body.style;
		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";
		const onBlur = () => {
			const drag = dragRef.current;
			if (!drag) return;
			dragRef.current = null;
			preferredHeightRef.current = drag.originalPreference;
			setPreferredHeight(drag.originalPreference);
			setIsDragging(false);
		};
		window.addEventListener("blur", onBlur);
		return () => {
			document.body.style.cursor = cursor;
			document.body.style.userSelect = userSelect;
			window.removeEventListener("blur", onBlur);
		};
	}, [isDragging]);

	return (
		<div
			ref={panelRef}
			data-timeline-panel
			className="flex shrink-0 flex-col min-h-0"
			style={{ height }}
		>
			<div
				role="separator"
				tabIndex={0}
				aria-label={t("panel.resize", "Timeline height")}
				aria-orientation="horizontal"
				aria-controls="editor-timeline"
				aria-valuemin={bounds.min}
				aria-valuemax={bounds.max}
				aria-valuenow={height}
				title={t("panel.resizeHint", "Drag to resize the timeline. Double-click to reset.")}
				className={`group flex h-3 shrink-0 cursor-row-resize touch-none select-none items-center justify-center outline-none transition-colors hover:bg-[#2563EB]/10 focus-visible:bg-[#2563EB]/10 ${isDragging ? "bg-[#2563EB]/10" : ""}`}
				onPointerDown={(event) => {
					if (event.button !== 0 || !event.isPrimary) return;
					event.preventDefault();
					event.stopPropagation();
					event.currentTarget.focus();
					event.currentTarget.setPointerCapture(event.pointerId);
					dragRef.current = {
						pointerId: event.pointerId,
						startY: event.clientY,
						startHeight: height,
						originalPreference: preferredHeightRef.current,
					};
					setIsDragging(true);
				}}
				onPointerMove={(event) => {
					const drag = dragRef.current;
					if (!drag || drag.pointerId !== event.pointerId) return;
					updateHeight(
						clampTimelinePanelHeight(
							drag.startHeight + drag.startY - event.clientY,
							containerHeight,
						),
					);
				}}
				onPointerUp={(event) => {
					if (dragRef.current?.pointerId !== event.pointerId) return;
					dragRef.current = null;
					setIsDragging(false);
					event.currentTarget.releasePointerCapture(event.pointerId);
					saveAppSetting(TIMELINE_PANEL_HEIGHT_KEY, preferredHeightRef.current);
				}}
				onPointerCancel={cancelDrag}
				onLostPointerCapture={cancelDrag}
				onDoubleClick={() => {
					updateHeight(DEFAULT_TIMELINE_PANEL_HEIGHT);
					saveAppSetting(TIMELINE_PANEL_HEIGHT_KEY, DEFAULT_TIMELINE_PANEL_HEIGHT);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape" && dragRef.current) {
						event.preventDefault();
						event.stopPropagation();
						cancelDrag();
						return;
					}
					let next: number;
					if (event.key === "ArrowUp") next = height + (event.shiftKey ? 80 : 20);
					else if (event.key === "ArrowDown") next = height - (event.shiftKey ? 80 : 20);
					else if (event.key === "Home") next = bounds.min;
					else if (event.key === "End") next = bounds.max;
					else return;
					event.preventDefault();
					event.stopPropagation();
					next = clampTimelinePanelHeight(next, containerHeight);
					updateHeight(next);
					saveAppSetting(TIMELINE_PANEL_HEIGHT_KEY, next);
				}}
			>
				<span
					className={`h-1 w-12 rounded-full transition-colors group-hover:bg-[#2563EB] group-focus-visible:bg-[#2563EB] ${isDragging ? "bg-[#2563EB]" : "bg-foreground/20"}`}
				/>
			</div>
			<div id="editor-timeline" className="flex min-h-0 flex-1 flex-col">
				{children}
			</div>
		</div>
	);
}
