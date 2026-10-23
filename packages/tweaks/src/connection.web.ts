import type { TweaksDefine, TweaksSocket } from './connection'

export type { TweaksDefine, TweaksSocket }

export const clientLabel = 'web'

export function createSocket(_define: TweaksDefine, url: string): TweaksSocket | null {
	// DOM WebSocket's handler signatures carry (this, ev); structurally
	// compatible with our no-arg handlers at runtime.
	return new WebSocket(url) as unknown as TweaksSocket
}

export function socketUrl(define: TweaksDefine, clientId: string, label: string): string | null {
	const query = `token=${encodeURIComponent(define.token)}&role=app&clientId=${clientId}&label=${label}`
	const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
	return `${scheme}://${location.host}${define.path}?${query}`
}
