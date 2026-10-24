// Native-default transport leaf. The web variant (connection.web.ts) builds the
// URL from location.host; here there is no location, so the plugin-provided
// fallbackOrigin is used. With no globalThis.WebSocket the client stays inert.
export const clientLabel = 'native'

export interface TweaksSocket {
	send(data: string): void
	close(): void
	onopen: (() => void) | null
	onmessage: ((event: { data: unknown }) => void) | null
	onclose: (() => void) | null
	onerror: (() => void) | null
}

export interface TweaksDefine {
	token: string
	path: string
	fallbackOrigin: string
}

export function createSocket(define: TweaksDefine, url: string): TweaksSocket | null {
	const WS = (globalThis as Record<string, unknown>).WebSocket as
		| (new (url: string) => TweaksSocket)
		| undefined
	if (typeof WS !== 'function') {
		return null
	}
	return new WS(url)
}

export function socketUrl(define: TweaksDefine, clientId: string, label: string): string | null {
	// NativeScript dev publishes the Mac's LAN origin to the device as
	// __NS_HTTP_ORIGIN__ (the same one its HMR socket uses). Loopback origins
	// only resolve on the simulator; the LAN origin works there too and on
	// physical devices.
	const nsOrigin = (globalThis as Record<string, unknown>).__NS_HTTP_ORIGIN__
	const origin =
		typeof nsOrigin === 'string' && nsOrigin.length ? nsOrigin : define.fallbackOrigin
	if (!origin) {
		return null
	}
	const base = origin.replace(/^http/, 'ws')
	const query = `token=${encodeURIComponent(define.token)}&role=app&clientId=${clientId}&label=${label}`
	return `${base}${define.path}?${query}`
}
