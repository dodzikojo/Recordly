import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowFramingGeometry } from "../../../src/lib/windowFraming";
import type { SelectedSource, WindowBounds } from "../types";

const execFileAsync = promisify(execFile);

function parseDesktopCaptureWindowId(sourceId?: string) {
	const match = sourceId?.match(/^window:(\d+)(?::|$)/);
	return match ? Number.parseInt(match[1], 10) : null;
}

function parseBounds(value: unknown): WindowBounds | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as Partial<WindowBounds>;
	if (
		typeof candidate.x !== "number" ||
		!Number.isFinite(candidate.x) ||
		typeof candidate.y !== "number" ||
		!Number.isFinite(candidate.y) ||
		typeof candidate.width !== "number" ||
		!Number.isFinite(candidate.width) ||
		typeof candidate.height !== "number" ||
		!Number.isFinite(candidate.height) ||
		candidate.width <= 0 ||
		candidate.height <= 0
	) {
		return null;
	}

	return {
		x: candidate.x,
		y: candidate.y,
		width: candidate.width,
		height: candidate.height,
	};
}

export function parseWindowsWindowGeometry(stdout: string): WindowFramingGeometry | null {
	try {
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		const frameBounds = parseBounds(parsed.frameBounds);
		if (!frameBounds) {
			return null;
		}

		const clientBounds = parseBounds(parsed.clientBounds);
		const dpiScale =
			typeof parsed.dpiScale === "number" &&
			Number.isFinite(parsed.dpiScale) &&
			parsed.dpiScale > 0
				? parsed.dpiScale
				: 1;

		return {
			frameBounds,
			clientBounds,
			dpiScale,
			clientDetected: parsed.clientDetected === true && clientBounds !== null,
		};
	} catch {
		return null;
	}
}

const WINDOWS_WINDOW_GEOMETRY_SCRIPT = [
	"$windowId = $env:RECORDLY_WINDOW_ID",
	'Add-Type -TypeDefinition @"',
	"using System;",
	"using System.Runtime.InteropServices;",
	"public static class RecordlyWindowGeometry {",
	"  [StructLayout(LayoutKind.Sequential)]",
	"  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
	"  [StructLayout(LayoutKind.Sequential)]",
	"  public struct POINT { public int X; public int Y; }",
	'  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]',
	"  public static extern bool IsWindow(IntPtr hWnd);",
	'  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]',
	"  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);",
	'  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]',
	"  public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);",
	'  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]',
	"  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);",
	'  [DllImport("user32.dll")]',
	"  public static extern uint GetDpiForWindow(IntPtr hWnd);",
	'  [DllImport("user32.dll")]',
	"  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);",
	'  [DllImport("dwmapi.dll")]',
	"  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);",
	"}",
	'"@',
	"$handleValue = [Int64]0",
	"if (-not [Int64]::TryParse($windowId, [ref]$handleValue) -or $handleValue -le 0) { exit 1 }",
	"$handle = [IntPtr]$handleValue",
	"if (-not [RecordlyWindowGeometry]::IsWindow($handle)) { exit 1 }",
	"$previousContext = [IntPtr]::Zero",
	"try { $previousContext = [RecordlyWindowGeometry]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }",
	"try {",
	"  $frame = New-Object RecordlyWindowGeometry+RECT",
	"  $frameDetected = [RecordlyWindowGeometry]::DwmGetWindowAttribute($handle, 9, [ref]$frame, [Runtime.InteropServices.Marshal]::SizeOf([type][RecordlyWindowGeometry+RECT])) -eq 0",
	"  if (-not $frameDetected) {",
	"    if (-not [RecordlyWindowGeometry]::GetWindowRect($handle, [ref]$frame)) { exit 1 }",
	"  }",
	"  $frameWidth = $frame.Right - $frame.Left",
	"  $frameHeight = $frame.Bottom - $frame.Top",
	"  if ($frameWidth -le 0 -or $frameHeight -le 0) { exit 1 }",
	"  $clientBounds = $null",
	"  $client = New-Object RecordlyWindowGeometry+RECT",
	"  $clientOrigin = New-Object RecordlyWindowGeometry+POINT",
	"  $clientDetected = [RecordlyWindowGeometry]::GetClientRect($handle, [ref]$client) -and [RecordlyWindowGeometry]::ClientToScreen($handle, [ref]$clientOrigin)",
	"  if ($clientDetected) {",
	"    $clientWidth = $client.Right - $client.Left",
	"    $clientHeight = $client.Bottom - $client.Top",
	"    if ($clientWidth -gt 0 -and $clientHeight -gt 0) {",
	"      $clientBounds = @{ x = $clientOrigin.X; y = $clientOrigin.Y; width = $clientWidth; height = $clientHeight }",
	"    } else { $clientDetected = $false }",
	"  }",
	"  $dpi = 96",
	"  try { $resolvedDpi = [RecordlyWindowGeometry]::GetDpiForWindow($handle); if ($resolvedDpi -gt 0) { $dpi = $resolvedDpi } } catch { }",
	"  @{",
	"    frameBounds = @{ x = $frame.Left; y = $frame.Top; width = $frameWidth; height = $frameHeight };",
	"    clientBounds = $clientBounds;",
	"    dpiScale = $dpi / 96.0;",
	"    clientDetected = [bool]$clientDetected",
	"  } | ConvertTo-Json -Compress -Depth 3",
	"} finally {",
	"  if ($previousContext -ne [IntPtr]::Zero) { try { [void][RecordlyWindowGeometry]::SetThreadDpiAwarenessContext($previousContext) } catch { } }",
	"}",
].join("\n");

export async function resolveWindowsWindowGeometry(
	source: SelectedSource,
): Promise<WindowFramingGeometry | null> {
	if (process.platform !== "win32") {
		return null;
	}

	const windowId = parseDesktopCaptureWindowId(source.id);
	if (!windowId || windowId <= 0) {
		return null;
	}

	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				WINDOWS_WINDOW_GEOMETRY_SCRIPT,
			],
			{
				timeout: 2500,
				env: { ...process.env, RECORDLY_WINDOW_ID: String(windowId) },
			},
		);
		return parseWindowsWindowGeometry(stdout);
	} catch (error) {
		console.warn("Failed to resolve Windows window geometry:", error);
		return null;
	}
}
