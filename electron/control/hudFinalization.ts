import { ControlError } from "./types";

/** How long a retake waits for the last take's HUD to finish finalizing and close itself. */
export const HUD_FINALIZE_WAIT_MS = 20_000;

export const STILL_FINALIZING_MESSAGE =
	"The last take is still finalizing; try start again shortly";

/** The slice of BrowserWindow this needs, so it can be tested without Electron. */
export interface ClosableWindow {
	isDestroyed(): boolean;
	once(event: "closed", listener: () => void): unknown;
	removeListener(event: "closed", listener: () => void): unknown;
}

/** Resolves true once the window has closed, false if it is still open after `ms`. */
export function waitForWindowClosed(window: ClosableWindow, ms: number): Promise<boolean> {
	if (window.isDestroyed()) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const onClosed = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			window.removeListener("closed", onClosed);
			resolve(false);
		}, ms);
		window.once("closed", onClosed);
	});
}

/**
 * After a stop the HUD hides behind the editor and closes itself once the take is finalized
 * (webcam, mic sidecar, mux, then the session update). A new take must never start in that HUD
 * first: it would share the renderer with the finishing take, overwrite that take's webcam offset
 * and crop before they are written, and could be ended by the late close. So wait for the close,
 * and if it doesn't come, fail with a retryable conflict rather than reuse the HUD.
 */
export async function waitForFinishingHudToClose(
	hud: ClosableWindow,
	ms = HUD_FINALIZE_WAIT_MS,
): Promise<void> {
	if (!(await waitForWindowClosed(hud, ms))) {
		throw new ControlError("conflict", STILL_FINALIZING_MESSAGE);
	}
}
