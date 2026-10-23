// WebSocket client over Network.framework (NWConnection). The JSC host has no
// WebSocket, and NSURLSessionWebSocketTask is unreachable through the bundled
// node-api metadata — webSocketTaskWithURL returns an object whose prototype is
// plain NSURLSessionTask (no ws selectors). C functions are bridged, so the
// connection is opened by hand and frames are codec'd by src/ws-frames.ts.
// Local ws:// only — no TLS.
import {
	interop,
	NSData,
	NSOperationQueue,
	type NSObject,
} from '@octane-xplat/platform/macos'
import {
	_nw_content_context_default_message,
	_nw_parameters_configure_protocol_default_configuration,
	_nw_parameters_configure_protocol_disable,
	dispatch_data_create,
	dispatch_queue_create,
	nw_connection_cancel,
	nw_connection_create,
	nw_connection_receive,
	nw_connection_send,
	nw_connection_set_queue,
	nw_connection_set_state_changed_handler,
	nw_connection_start,
	nw_endpoint_create_host,
	nw_parameters_create_secure_tcp,
} from '@octane-xplat/platform/macos'
import {
	encodeFrame,
	FrameDecoder,
	handshakeAccept,
	handshakeRequest,
	utf8Encode,
} from './ws-frames'
import type { Transport, TransportFactory } from './model'

export const transportFactory: TransportFactory = (url): Transport | null => {
	const m = /^ws:\/\/([^:/]+):(\d+)(\/.*)$/.exec(url)
	if (!m) return null
	const [, host, port, path] = m

	const queue = (NSOperationQueue.mainQueue as { underlyingQueue?: NSObject }).underlyingQueue ??
		dispatch_queue_create('tweaks.ws', null as unknown as NSObject)
	const sendQueue = dispatch_queue_create('tweaks.ws.send', null as unknown as NSObject)
	const endpoint = nw_endpoint_create_host(host, port)
	const params = nw_parameters_create_secure_tcp(
		// _disable as the TLS configure block → plain TCP.
		_nw_parameters_configure_protocol_disable,
		_nw_parameters_configure_protocol_default_configuration,
	)
	const conn = nw_connection_create(endpoint, params)

	const transport: Transport = { onopen: null, onmessage: null, onclose: null, send: () => {}, close: () => {} }
	const decoder = new FrameDecoder()
	let closed = false
	let ready = false
	let handshaken = false

	const fail = () => {
		if (closed) return
		closed = true
		transport.onclose?.()
	}

	// dispatch_data_t toll-free bridges with NSData.
	function sendBytes(bytes: Uint8Array) {
		const data = NSData.dataWithBytesLength(bytes, bytes.length)
		const d = dispatch_data_create(
			(data as unknown as { bytes: NSObject }).bytes,
			bytes.length,
			sendQueue,
			() => {},
		)
		nw_connection_send(conn, d, _nw_content_context_default_message, false, (error: unknown) => {
			if (error) fail()
		})
	}

	transport.send = (data) => {
		if (!ready || closed) return
		sendBytes(encodeFrame(1, utf8Encode(data)))
	}
	transport.close = () => {
		if (closed) return
		closed = true
		try {
			sendBytes(encodeFrame(8, new Uint8Array(0)))
		} catch {}
		nw_connection_cancel(conn)
	}

	function pump() {
		nw_connection_receive(conn, 1, 1 << 20, (data: NSObject, _ctx: unknown, _complete: boolean, error: unknown) => {
			if (error || closed) {
				if (!closed) fail()
				return
			}
			try {
				if (data) {
					if (!handshaken) {
						handshakeBuffer = concat(handshakeBuffer, new Uint8Array(interop.bufferFromData(data as unknown as NSData)))
						const end = handshakeAccept(handshakeBuffer)
						if (end >= 0) {
							handshaken = true
							ready = true
							transport.onopen?.()
							for (const ev of decoder.push(handshakeBuffer.subarray(end))) deliver(ev)
						}
					} else {
						for (const ev of decoder.push(new Uint8Array(interop.bufferFromData(data as unknown as NSData)))) deliver(ev)
					}
				}
			} catch (e) {
				console.error('[transport]', e)
				fail()
				return
			}
			if (!closed) pump()
		})
	}

	let handshakeBuffer = new Uint8Array(0)
	function concat(a: Uint8Array, b: Uint8Array) {
		const out = new Uint8Array(a.length + b.length)
		out.set(a, 0)
		out.set(b, a.length)
		return out
	}

	function deliver(ev: ReturnType<FrameDecoder['push']>[number]) {
		if (ev.type === 'text') transport.onmessage?.(ev.data)
		else if (ev.type === 'close') {
			closed = true
			nw_connection_cancel(conn)
			transport.onclose?.()
		} else if (ev.type === 'ping') sendBytes(encodeFrame(10, ev.payload))
	}
	nw_connection_set_state_changed_handler(conn, (state: number, error: unknown) => {
		// nw_connection_state_ready = 3
		if (state === 3 && !handshaken) {
			sendBytes(handshakeRequest(host, port, path))
		} else if (state === 4 || state === 5 || error) {
			fail()
		}
	})
	nw_connection_set_queue(conn, queue)
	nw_connection_start(conn)
	pump()
	return transport
}
