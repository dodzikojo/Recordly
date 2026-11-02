import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HUD_FINALIZE_WAIT_MS,
	STILL_FINALIZING_MESSAGE,
	waitForFinishingHudToClose,
} from "./hudFinalization";
import { ControlError } from "./types";

function fakeHud() {
	const emitter = new EventEmitter();
	let destroyed = false;
	return {
		isDestroyed: () => destroyed,
		once: (event: "closed", listener: () => void) => emitter.once(event, listener),
		removeListener: (event: "closed", listener: () => void) =>
			emitter.removeListener(event, listener),
		close() {
			destroyed = true;
			emitter.emit("closed");
		},
		closedListeners: () => emitter.listenerCount("closed"),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("waitForFinishingHudToClose", () => {
	it("waits 20 s by default", () => {
		expect(HUD_FINALIZE_WAIT_MS).toBe(20_000);
	});

	it("resolves once the finishing HUD closes itself", async () => {
		const hud = fakeHud();
		const outcome = { done: false };
		void waitForFinishingHudToClose(hud).then(() => {
			outcome.done = true;
		});

		await vi.advanceTimersByTimeAsync(5_000);
		expect(outcome.done).toBe(false);
		hud.close();
		await vi.advanceTimersByTimeAsync(0);

		expect(outcome.done).toBe(true);
		expect(hud.closedListeners()).toBe(0);
	});

	it("resolves at once for a HUD that is already gone", async () => {
		const hud = fakeHud();
		hud.close();
		await expect(waitForFinishingHudToClose(hud)).resolves.toBeUndefined();
	});

	it("fails with a retryable conflict instead of reusing a HUD that is still finalizing", async () => {
		const hud = fakeHud();
		const outcome: { error?: unknown } = {};
		void waitForFinishingHudToClose(hud).catch((error) => {
			outcome.error = error;
		});

		await vi.advanceTimersByTimeAsync(HUD_FINALIZE_WAIT_MS - 1);
		expect(outcome.error).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);

		expect(outcome.error).toBeInstanceOf(ControlError);
		expect((outcome.error as ControlError).code).toBe("conflict");
		expect((outcome.error as ControlError).message).toBe(STILL_FINALIZING_MESSAGE);
		expect(STILL_FINALIZING_MESSAGE).toMatch(/still finalizing.*try start again/);
		expect(hud.closedListeners()).toBe(0);
	});
});
