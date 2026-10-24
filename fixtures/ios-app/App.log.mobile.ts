// Native leaf: a render marker asserted by the iOS tweaks verification, plus a
// one-time transport probe (`[tweaks-ws]`) so the runner can see whether the
// polyfill installed the global WebSocket and whether a socket was opened.
let wsLogged = false
export function logRender(title: string) {
	if (!wsLogged) {
		wsLogged = true
		console.log('[tweaks-ws]', typeof (globalThis as Record<string, unknown>).WebSocket, (globalThis as Record<string, unknown>).__NS_HTTP_ORIGIN__)
	}
	console.log('[tweaks-render]', title)
}
