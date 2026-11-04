type FrameLayer = "scene" | "background" | "webcam";
type StagingCanvas = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };

/** Own pixel copies, never decoder surfaces. Pixi may upload after the decoder advances. */
export class VideoFrameStager {
	private readonly layers = new Map<FrameLayer, StagingCanvas>();

	getCanvas(layer: FrameLayer, width: number, height: number): StagingCanvas {
		let staging = this.layers.get(layer);
		if (!staging) {
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (!context) throw new Error("Cannot create the export frame staging canvas");
			staging = { canvas, context };
			this.layers.set(layer, staging);
		}
		const targetWidth = Math.max(1, Math.ceil(width));
		const targetHeight = Math.max(1, Math.ceil(height));
		if (staging.canvas.width !== targetWidth) staging.canvas.width = targetWidth;
		if (staging.canvas.height !== targetHeight) staging.canvas.height = targetHeight;
		return staging;
	}

	stage(
		frame: VideoFrame,
		layer: FrameLayer,
		fallbackWidth: number,
		fallbackHeight: number,
	): HTMLCanvasElement {
		const { canvas, context } = this.getCanvas(
			layer,
			frame.displayWidth || fallbackWidth,
			frame.displayHeight || fallbackHeight,
		);
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(frame, 0, 0, canvas.width, canvas.height);
		return canvas;
	}

	dispose(): void {
		for (const { canvas } of this.layers.values()) {
			canvas.width = 0;
			canvas.height = 0;
		}
		this.layers.clear();
	}
}
