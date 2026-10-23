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
	if (!define.fallbackOrigin) {
		return null
	}
	const base = define.fallbackOrigin.replace(/^http/, 'ws')
	const query = `token=${encodeURIComponent(define.token)}&role=app&clientId=${clientId}&label=${label}`
	return `${base}${define.path}?${query}`
}
