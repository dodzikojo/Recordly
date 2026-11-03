import { useTimelineContext } from "dnd-timeline";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import type { TimelineGap } from "../../../closeGaps";

interface TimelineGapButtonProps {
	gap: TimelineGap;
	selected: boolean;
	onSelect?: (gap: TimelineGap) => void;
	onClose?: (gap: TimelineGap) => void;
}

export default function TimelineGapButton({
	gap,
	selected,
	onSelect,
	onClose,
}: TimelineGapButtonProps) {
	const t = useScopedT("timeline");
	const { range, direction, valueToPixels } = useTimelineContext();
	const [menuOpen, setMenuOpen] = useState(false);
	const visibleStart = Math.max(gap.startMs, range.start);
	const visibleEnd = Math.min(gap.endMs, range.end);
	if (visibleEnd <= visibleStart) return null;
	const label = t("gap.label", undefined, {
		start: (gap.startMs / 1000).toFixed(2),
		end: (gap.endMs / 1000).toFixed(2),
	});
	return (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					data-timeline-item
					data-timeline-gap-start={gap.startMs}
					data-timeline-gap-end={gap.endMs}
					aria-label={label}
					aria-pressed={selected}
					title={label}
					className={cn(
						"absolute top-1/2 -translate-y-1/2 h-[85%] overflow-hidden rounded border border-dashed text-[10px] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
						selected
							? "border-primary bg-primary/20 text-foreground"
							: "border-foreground/20 bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
					)}
					style={{
						[direction === "rtl" ? "right" : "left"]: valueToPixels(
							visibleStart - range.start,
						),
						width: Math.max(1, valueToPixels(visibleEnd - visibleStart)),
					}}
					onPointerDown={(event) => {
						event.stopPropagation();
						// A normal click selects; the menu opens on a context-menu gesture.
						if (event.button === 0) {
							event.preventDefault();
							event.currentTarget.focus();
						}
					}}
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						onSelect?.(gap);
					}}
					onContextMenu={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onSelect?.(gap);
						setMenuOpen(true);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onSelect?.(gap);
						} else if (
							event.key === "ContextMenu" ||
							(event.shiftKey && event.key === "F10")
						) {
							event.preventDefault();
							onSelect?.(gap);
							setMenuOpen(true);
						}
					}}
				>
					{t("gap.shortLabel")}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				onCloseAutoFocus={(event) => event.preventDefault()}
				onClick={(event) => event.stopPropagation()}
				onMouseDown={(event) => event.stopPropagation()}
				onPointerDown={(event) => event.stopPropagation()}
			>
				<DropdownMenuItem onSelect={() => onClose?.(gap)}>
					{t("gap.close")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
