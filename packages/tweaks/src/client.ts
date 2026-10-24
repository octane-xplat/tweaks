import type { AppToServer, ServerToApp, ServerToAppStyles, StyleValue, TweakValue } from './protocol'
import { clientLabel, createSocket, socketUrl, type TweaksSocket } from './connection'

// __OCTANE_TWEAKS__ is declared in globals.d.ts and injected by
// @octane-xplat/tweaks-vite in dev only. Absent in production and whenever the
// plugin is not installed — the client then stays inert and useTweak returns
// its literal argument.

interface Mounted {
	// The value this client reports on (re)connect: the hook's literal argument.
	value: TweakValue
	count: number
	listeners: Set<(override: TweakValue | null) => void>
}

// Module-singleton client shared by every useTweak call in the app. One socket,
// per-id refcounted mounts, mount/unmount batching on a microtask, and
// reconnect-with-backoff that re-sends the full mounted set.
class Client {
	private mounted = new Map<string, Mounted>()
	private socket: TweaksSocket | null = null
	private connecting = false
	private retries = 0
	private pendingMounts = new Map<string, TweakValue>()
	private pendingUnmounts = new Set<string>()
	private flushQueued = false
	// Last 'values' map from the server. Cached so a hook that (re)mounts — or
	// a second instance of an already-mounted id — receives the live override
	// immediately instead of showing its literal until the next broadcast.
	private overrides = new Map<string, TweakValue>()
	private warnedConnect = false
	private styles: ServerToAppStyles = {}
	private styleListeners = new Set<() => void>()
	private pickListeners = new Set<(active: boolean) => void>()
	private hasValues = false
	private readonly clientId =
		(globalThis as Record<string, unknown>).crypto &&
		typeof (globalThis.crypto as Crypto).randomUUID === 'function'
			? (globalThis.crypto as Crypto).randomUUID()
			: `c${Math.random().toString(36).slice(2)}`

	private get config() {
		return typeof __OCTANE_TWEAKS__ === 'undefined' ? undefined : __OCTANE_TWEAKS__
	}

	watch(id: string, value: TweakValue, listener: (override: TweakValue | null) => void) {
		let entry = this.mounted.get(id)
		if (entry) {
			entry.count++
			entry.listeners.add(listener)
		} else {
			entry = { value, count: 1, listeners: new Set([listener]) }
			this.mounted.set(id, entry)
			this.pendingMounts.set(id, value)
			this.pendingUnmounts.delete(id)
			this.connect()
		}
		// Deliver the currently-known override to the new watcher (no-op when no
		// values message has arrived yet).
		if (this.hasValues) listener(this.overrides.get(id) ?? null)
		this.queueFlush()
		return () => {
			const current = this.mounted.get(id)
			if (!current) return
			current.listeners.delete(listener)
			if (--current.count > 0) return
			this.mounted.delete(id)
			this.pendingMounts.delete(id)
			this.pendingUnmounts.add(id)
			this.queueFlush()
		}
	}

	private queueFlush() {
		if (this.flushQueued) return
		this.flushQueued = true
		queueMicrotask(() => {
			this.flushQueued = false
			if (!this.socket) {
				this.pendingMounts.clear()
				this.pendingUnmounts.clear()
				return
			}
			this.sendPending()
		})
	}

	private sendPending() {
		if (this.pendingMounts.size) {
			const mounts = [...this.pendingMounts].map(([id, value]) => ({ id, value }))
			this.send({ type: 'mount', mounts })
			this.pendingMounts.clear()
		}
		if (this.pendingUnmounts.size) {
			this.send({ type: 'unmount', ids: [...this.pendingUnmounts] })
			this.pendingUnmounts.clear()
		}
	}

	private connect() {
		const config = this.config
		if (!config || this.socket || this.connecting) return
		const url = socketUrl(config, this.clientId, clientLabel)
		if (!url) return
		const socket = createSocket(config, url)
		if (!socket) return
		this.connecting = true
		socket.onopen = () => {
			if (this.socket === socket) return
			this.connecting = false
			this.socket = socket
			this.retries = 0
			everOpened = true
			// Re-send the full mounted set on every (re)connect.
			if (this.mounted.size) {
				this.send({
					type: 'mount',
					mounts: [...this.mounted].map(([id, e]) => ({ id, value: e.value })),
				})
			}
			this.sendPending()
		}
		socket.onmessage = (event) => {
			let message: ServerToApp
			try {
				message = JSON.parse(String(event.data))
			} catch {
				return
			}
			if (message.type === 'pick') {
				for (const l of this.pickListeners) l(message.active)
				return
			}
			if (message.type !== 'values') return
			this.overrides = new Map(Object.entries(message.values))
			this.styles = message.styles ?? {}
			for (const l of this.styleListeners) l()
			this.hasValues = true
			for (const [id, entry] of this.mounted) {
				const override = this.overrides.get(id) ?? null
				for (const listener of entry.listeners) listener(override)
			}
		}
		const retry = () => {
			this.socket = null
			this.connecting = false
			if (!this.mounted.size) return
			// Backoff 1s → 5s cap.
			const delay = Math.min(1000 * 2 ** this.retries++, 5000)
			setTimeout(() => this.connect(), delay)
		}
		let everOpened = false
		socket.onclose = () => {
			if (!everOpened && !this.warnedConnect) {
				this.warnedConnect = true
				// Never log the URL query: it carries the session token.
				console.warn(`[octane-tweaks] could not connect to ${url.split('?')[0]}`)
			}
			retry()
		}
		socket.onerror = () => socket.close()
	}

	private send(message: AppToServer) {
		try {
			this.socket?.send(JSON.stringify(message))
		} catch {
			// A dying socket surfaces through onclose; sending must never throw
			// into user render code.
		}
	}
	// Style sites mount/unmount through the same refcounted machinery; they
	// carry no runtime value, so mount reports a 0 placeholder.
	mountStyle(id: string) {
		this.connect()
		const entry = this.mounted.get(id)
		if (entry) entry.count++
		else {
			this.mounted.set(id, { value: 0, count: 1, listeners: new Set() })
			this.pendingMounts.set(id, 0)
		}
		this.queueFlush()
	}

	unmountStyle(id: string) {
		const entry = this.mounted.get(id)
		if (!entry) return
		if (--entry.count <= 0) {
			this.mounted.delete(id)
			this.pendingUnmounts.add(id)
		}
		this.queueFlush()
	}

	getStyle(id: string): { set: Record<string, StyleValue>; delete: string[] } | null {
		const s = this.styles[id]
		return s && s.kind === 'inline' ? s : null
	}

	getStyleRaw(id: string) {
		return this.styles[id] ?? null
	}

	// Click-to-pick: web installs a listener (native leaves none — the
	// messages are ignored there). Returns an unsubscribe.
	// No connect() here: pick listeners only matter once a site mounted and
	// opened the socket; registering must not open one on module eval.
	onPick(listener: (active: boolean) => void) {
		this.pickListeners.add(listener)
		return () => this.pickListeners.delete(listener)
	}
	sendPicked(ids: string[]) {
		this.send({ type: 'picked', ids })
	}

	onStyles(listener: () => void): () => void {
		this.styleListeners.add(listener)
		return () => this.styleListeners.delete(listener)
	}
}

export const client = new Client()
