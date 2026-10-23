// Keep-on-top toggles the AppKit window level (floating vs normal).
export const supportsKeepOnTop = true

// Set in main.macos.ts after the window exists.
let window: { setLevel?: (level: number) => void; level?: number } | null = null

const NSNormalWindowLevel = 0
const NSFloatingWindowLevel = 3

export function bindWindow(w: typeof window) {
	window = w
}

export function setKeepOnTop(onTop: boolean) {
	window?.setLevel?.(onTop ? NSFloatingWindowLevel : NSNormalWindowLevel)
}
