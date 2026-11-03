import { afterEach, describe, expect, it, vi } from "vitest";
import { watchPreviewPlaybackReadiness } from "./previewPlaybackReadiness";

function setup() {
	const video = Object.assign(new EventTarget(), { seeking: false, readyState: 0 });
	const ready = vi.fn();
	const pause = vi.fn();
	const dispose = watchPreviewPlaybackReadiness(video, ready, pause);
	return { video, ready, pause, dispose };
}

afterEach(() => vi.useRealTimers());

describe("preview audio buffering", () => {
	it("resumes on playing even when high-rate decoding only has the current frame", () => {
		const { video, ready, dispose } = setup();
		expect(ready).toHaveBeenLastCalledWith(false);
		video.readyState = 2;
		video.dispatchEvent(new Event("playing"));
		expect(ready).toHaveBeenLastCalledWith(true);
		dispose();
	});

	it("ignores brief decoder waits but pauses audio for sustained buffering", () => {
		vi.useFakeTimers();
		const { video, ready, pause, dispose } = setup();
		video.dispatchEvent(new Event("playing"));
		video.dispatchEvent(new Event("waiting"));
		vi.advanceTimersByTime(100);
		video.dispatchEvent(new Event("playing"));
		vi.advanceTimersByTime(200);
		expect(pause).not.toHaveBeenCalled();
		video.dispatchEvent(new Event("waiting"));
		vi.advanceTimersByTime(200);
		expect(pause).toHaveBeenCalledOnce();
		expect(ready).toHaveBeenLastCalledWith(false);
		dispose();
	});

	it("suspends for a seek and resumes only when it completes", () => {
		vi.useFakeTimers();
		const { video, ready, pause, dispose } = setup();
		video.seeking = true;
		video.dispatchEvent(new Event("seeking"));
		vi.advanceTimersByTime(200);
		video.dispatchEvent(new Event("playing"));
		expect(ready).toHaveBeenLastCalledWith(false);
		expect(pause).toHaveBeenCalledOnce();
		video.seeking = false;
		video.dispatchEvent(new Event("seeked"));
		expect(ready).toHaveBeenLastCalledWith(true);
		dispose();
	});

	it("keeps narration running over a brief automatic cut seek", () => {
		vi.useFakeTimers();
		const { video, pause, dispose } = setup();
		video.dispatchEvent(new Event("playing"));
		video.seeking = true;
		video.dispatchEvent(new Event("seeking"));
		vi.advanceTimersByTime(30);
		video.seeking = false;
		video.dispatchEvent(new Event("seeked"));
		vi.advanceTimersByTime(300);
		expect(pause).not.toHaveBeenCalled();
		dispose();
	});

	it("detaches the replaced video and cancels pending buffering callbacks", () => {
		vi.useFakeTimers();
		const { video, ready, pause, dispose } = setup();
		video.dispatchEvent(new Event("waiting"));
		dispose();
		ready.mockClear();
		video.dispatchEvent(new Event("playing"));
		vi.advanceTimersByTime(300);
		expect(ready).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
	});
});
