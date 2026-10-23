import type { Transport, TransportFactory } from './model'

export const transportFactory: TransportFactory = (url): Transport | null => {
	const ws = new WebSocket(url)
	const transport: Transport = {
		onopen: null,
		onmessage: null,
		onclose: null,
		send: (data) => ws.send(data),
		close: () => ws.close(),
	}
	ws.onopen = () => transport.onopen?.()
	ws.onmessage = (event) => transport.onmessage?.(String(event.data))
	ws.onclose = () => transport.onclose?.()
	ws.onerror = () => ws.close()
	return transport
}
