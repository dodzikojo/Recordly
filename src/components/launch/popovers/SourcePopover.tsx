import { useCallback, useMemo, type ReactNode, useState } from "react";
import type { WindowFramingSettings } from "@/lib/windowFraming";
import { SourceSelector } from "../SourceSelector";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import {
	mapRawSource,
	isScreenSource,
	isWindowSource,
	type DesktopSource,
} from "./launchPopoverTypes";
import { WindowFramingPanel } from "./WindowFramingPanel";

const POPOVER_ID = "sources";

export function SourcePopover({
	trigger,
	selectedSource,
	supportsWindowFraming,
	windowFraming,
	onWindowFramingChange,
	onSourceSelect,
	onOpen,
}: {
	trigger: ReactNode;
	selectedSource: DesktopSource | null;
	supportsWindowFraming: boolean;
	windowFraming: WindowFramingSettings;
	onWindowFramingChange: (settings: WindowFramingSettings) => void;
	onSourceSelect: (source: DesktopSource) => Promise<void> | void;
	onOpen?: () => void;
}) {
	const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const [sources, setSources] = useState<DesktopSource[]>([]);
	const [loading, setLoading] = useState(false);
	const [showWindowFraming, setShowWindowFraming] = useState(false);
	const open = isOpen(POPOVER_ID);

	const fetchSources = useCallback(async () => {
		if (!window.electronAPI) return;
		setLoading(true);
		try {
			const rawSources = await window.electronAPI.getSources({
				types: ["screen", "window"],
				thumbnailSize: { width: 160, height: 90 },
				fetchWindowIcons: true,
			});
			setSources(rawSources.map((s) => mapRawSource(s as DesktopSource)));
		} catch (error) {
			console.error("Failed to fetch sources:", error);
		} finally {
			setLoading(false);
		}
	}, []);

	const screenSources = useMemo(() => sources.filter(isScreenSource), [sources]);
	const windowSources = useMemo(() => sources.filter(isWindowSource), [sources]);
	const framingSource =
		supportsWindowFraming && selectedSource && isWindowSource(selectedSource)
			? selectedSource
			: null;

	return (
		<SourceSelector
			screenSources={screenSources}
			windowSources={windowSources}
			selectedSource={selectedSource?.name ?? "Screen"}
			selectedSourceId={selectedSource?.id}
			loading={loading}
			onSourceSelect={async (source) => {
				try {
					await onSourceSelect(source);
					if (supportsWindowFraming && isWindowSource(source)) {
						setShowWindowFraming(true);
					} else {
						requestClose(POPOVER_ID);
					}
				} catch (error) {
					console.error("Failed to select source:", error);
				}
			}}
			onFetchSources={fetchSources}
			open={open}
			panel={
				showWindowFraming && framingSource ? (
					<WindowFramingPanel
						source={framingSource}
						settings={windowFraming}
						onSettingsChange={onWindowFramingChange}
						onBack={() => setShowWindowFraming(false)}
						onDone={() => requestClose(POPOVER_ID)}
					/>
				) : undefined
			}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					setShowWindowFraming(false);
					requestClose(POPOVER_ID);
					return;
				}
				onOpen?.();
				setShowWindowFraming(false);
				requestOpen(POPOVER_ID);
			}}
		>
			{trigger}
		</SourceSelector>
	);
}
