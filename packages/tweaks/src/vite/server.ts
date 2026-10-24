import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
	AppToServer,
	PanelEntry,
	PanelToServer,
	ServerToApp,
	ServerToPanel,
	PanelStyleEntry,
	ServerToAppStyles,
	StyleDraft,
	StyleEntry,
	StyleValue,
	TweakEntry,
	UnmountedDirtyEntry,
	TweakValue,
} from '../protocol.ts'

// Mirrors TWEAKS_PATH in @octane-xplat/tweaks/src/protocol.ts. Duplicated
// because that module ships .ts source, which Node refuses to type-strip from
// inside node_modules — the plugin must not runtime-import it.
const TWEAKS_PATH = '/__octane_tweaks'

export interface SaveReport {
	ok: boolean
	saved: string[]
	errors: { id?: string; file: string; message: string }[]
}

export interface ServerDeps {
	token: string
	root: string
	name: string
	getEntry(id: string): TweakEntry | undefined
	getStyleEntry(id: string): StyleEntry | undefined
	compileStyle?(id: string, draft: StyleDraft): Promise<{ className: string; css: string } | null>
	save(): Promise<SaveReport>
	log(message: string): void
}

interface Socket {
	clientId: string
	label: string
	role: 'app' | 'panel'
	ws: WebSocket
}

/**
 * Protocol hub mounted on the Vite dev server's HTTP upgrade. Owns the mounted
 * bookkeeping, the override map, and panel fan-out; source writeback is
 * delegated to deps.save().
 */
export class TweaksServer {
	private wss = new WebSocketServer({ noServer: true })
	private picking = false
	private sockets = new Set<Socket>()
	private mountedBy = new Map<string, Set<string>>()
	private runtimeValues = new Map<string, TweakValue>()
	/** The override map broadcast to apps; absence of an id means "no override". */
	readonly overrides = new Map<string, TweakValue>()
	/** Style drafts per site id; an empty draft means "reverted". */
	readonly styleDrafts = new Map<string, StyleDraft>()
	private stylePreviewFailed = new Set<string>()
	private styleCompiled = new Map<string, { className: string; css: string }>()
	private saving = false
	private deps: ServerDeps

	constructor(deps: ServerDeps) {
		this.deps = deps
		this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
	}

	/** Attach to an http.Server's 'upgrade' event; pass through all other paths. */
	handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? '', 'ws://localhost')
		if (url.pathname !== TWEAKS_PATH) return // not ours — Vite HMR et al. untouched
		if (url.searchParams.get('token') !== this.deps.token) {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
			socket.destroy()
			return
		}
		this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
	}

	private onConnection(ws: WebSocket, req: IncomingMessage) {
		const url = new URL(req.url ?? '', 'ws://localhost')
		const role = url.searchParams.get('role') === 'panel' ? 'panel' : 'app'
		const socket: Socket = {
			clientId: url.searchParams.get('clientId') || `anon-${Math.random().toString(36).slice(2)}`,
			label: url.searchParams.get('label') || 'web',
			role,
			ws,
		}
		this.sockets.add(socket)
		if (role === 'app') {
			void this.buildStyleValues().then((styles) => {
				this.sendTo(socket, {
					type: 'values',
					values: Object.fromEntries(this.overrides),
					styles,
				})
				if (this.picking) this.sendTo(socket, { type: 'pick', active: true })
			})
		} else {
			this.sendTo(socket, this.stateMessage())
		}
		ws.on('message', (data) => {
			let message: AppToServer | PanelToServer
			try {
				message = JSON.parse(String(data))
			} catch {
				return
			}
			if (socket.role === 'app') this.onAppMessage(socket, message as AppToServer)
			else void this.onPanelMessage(socket, message as PanelToServer)
		})
		ws.on('close', () => {
			this.sockets.delete(socket)
			// Client disconnect removes its mounts.
			let changed = false
			for (const [id, clients] of this.mountedBy) {
				if (clients.delete(socket.clientId) && !clients.size) {
					this.mountedBy.delete(id)
					changed = true
				} else if (clients.size) {
					changed = true
				}
			}
			if (socket.role === 'panel' && this.picking && ![...this.sockets].some((x) => x.role === 'panel')) {
				this.picking = false
				this.broadcastPick(false)
				changed = true
			}
			if (changed) this.broadcastState()
		})
	}

	private onAppMessage(socket: Socket, message: AppToServer) {
		if (message.type === 'mount') {
			for (const { id, value } of message.mounts) {
				let clients = this.mountedBy.get(id)
				if (!clients) this.mountedBy.set(id, (clients = new Set()))
				clients.add(socket.clientId)
				if (!this.runtimeValues.has(id)) this.runtimeValues.set(id, value)
			}
			this.broadcastState()
		} else if (message.type === 'unmount') {
			for (const id of message.ids) {
				const clients = this.mountedBy.get(id)
				if (clients?.delete(socket.clientId) && !clients.size) {
					this.mountedBy.delete(id)
				}
			}
			this.broadcastState()
		} else if (message.type === 'picked') {
			// Only honored while picking; ids filtered to mounted style sites.
			if (!this.picking) return
			this.picking = false
			this.broadcastPick(false)
			const mountedStyles = new Set(
				[...this.mountedBy.keys()].filter((id) => this.deps.getStyleEntry?.(id)),
			)
			const ids = message.ids.filter((id) => mountedStyles.has(id))
			for (const s of this.sockets) {
				if (s.role === 'panel') this.sendTo(s, { type: 'picked', clientId: socket.clientId, ids })
			}
			this.broadcastState()
		}
	}

	private broadcastPick(active: boolean) {
		for (const s of this.sockets) {
			if (s.role === 'app') this.sendTo(s, { type: 'pick', active })
		}
	}

	private async onPanelMessage(socket: Socket, message: PanelToServer) {
		if (message.type === 'pick') {
			this.picking = !!message.active
			this.broadcastPick(this.picking)
			this.broadcastState()
			return
		}
		if (message.type === 'set') {
			const entry = this.deps.getEntry(message.id)
			if (!entry || !this.validValue(entry, message.value)) {
				this.deps.log(`[tweaks] ignoring invalid set for ${message.id}`)
				return
			}
			this.overrides.set(message.id, message.value)
			void this.asyncBroadcastValues()
			this.broadcastState()
		} else if (message.type === 'styleSet') {
			const entry = this.deps.getStyleEntry(message.id)
			const valid =
				entry &&
				entry.writable &&
				Array.isArray(message.path) &&
				message.path.length > 0 &&
				message.path.every((p) => typeof p === 'string' && p.length > 0) &&
				(typeof message.value === 'string' || typeof message.value === 'number') &&
				(entry.kind !== 'inline' || message.path.length === 1) &&
				// An added property can't target a path under a read-only/dynamic one.
				!entry.properties.some(
					(p) =>
						!p.editable &&
						p.path.length < message.path.length &&
						message.path.slice(0, p.path.length).join('.') === p.path.join('.'),
				)
			if (!valid) {
				this.deps.log(`[tweaks] ignoring invalid styleSet for ${message.id}`)
				return
			}
			const draft = this.styleDrafts.get(message.id) ?? { set: {}, delete: [] }
			draft.set[message.path.join('.')] = message.value
			this.styleDrafts.set(message.id, draft)
			await this.refreshStyleCompiles()
			void this.asyncBroadcastValues()
			this.broadcastState()
		} else if (message.type === 'styleDelete') {
			const entry = this.deps.getStyleEntry(message.id)
			const key = message.path?.join('.')
			const existing = entry?.properties.find((p) => p.path.join('.') === key)
			const draft = this.styleDrafts.get(message.id)
			const valid =
				entry &&
				entry.writable &&
				Array.isArray(message.path) &&
				message.path.length > 0 &&
				message.path.every((p) => typeof p === 'string' && p.length > 0) &&
				(entry.kind !== 'inline' || message.path.length === 1) &&
				(existing?.editable || (draft && key! in draft.set))
			if (!valid) {
				this.deps.log(`[tweaks] ignoring invalid styleDelete for ${message.id}`)
				return
			}
			const d = draft ?? { set: {}, delete: [] }
			if (d.set[key!] !== undefined) delete d.set[key!]
			else if (!d.delete.includes(key!)) d.delete.push(key!)
			this.styleDrafts.set(message.id, d)
			await this.refreshStyleCompiles()
			void this.asyncBroadcastValues()
			this.broadcastState()
		} else if (message.type === 'revert') {
			// Omitted ids = all dirty overrides, mounted or not — matching Save's scope.
			const dirtyStyle = [...this.styleDrafts.keys()].filter((id) => this.isStyleDirty(id))
			const ids =
				message.ids ??
				[...this.overrides.keys()].filter((id) => this.isDirty(id)).concat(dirtyStyle)
			for (const id of ids) {
				if (this.styleDrafts.has(id)) {
					this.styleDrafts.delete(id)
					continue
				}
				const entry = this.deps.getEntry(id)
				// Deliberately set the override to the source literal rather than
				// deleting it: after a Save with HMR suppressed, the running module
				// still holds the old literal — deleting would snap back to stale code.
				if (entry && entry.value !== null) this.overrides.set(id, entry.value)
				else this.overrides.delete(id)
			}
			void this.asyncBroadcastValues()
			this.broadcastState()
		} else if (message.type === 'save') {
			if (this.saving) {
				this.sendTo(socket, {
					type: 'saveResult',
					ok: false,
					saved: [],
					errors: [{ file: '', message: 'busy: a save is already in progress' }],
				})
				return
			}
			this.saving = true
			try {
				const report = await this.deps.save()
				this.sendTo(socket, { type: 'saveResult', ...report })
				this.broadcastState()
			} finally {
				this.saving = false
			}
		}
	}

	private isDirty(id: string): boolean {
		const entry = this.deps.getEntry(id)
		const override = this.overrides.get(id)
		return override !== undefined && override !== (entry?.value ?? null)
	}

	private isStyleDirty(id: string): boolean {
		const d = this.styleDrafts.get(id)
		if (!d) return false
		// Dirty = draft differs from the source properties. After save the
		// refreshed manifest's literals equal the draft, so this goes false
		// while the draft (and its live preview) is kept.
		const source = new Map(
			(this.deps.getStyleEntry(id)?.properties ?? []).map((p) => [
				p.path.join('.'),
				p.value,
			]),
		)
		for (const [k, v] of Object.entries(d.set)) {
			if (!source.has(k) || source.get(k) !== v) return true
		}
		for (const k of d.delete) if (source.has(k)) return true
		return false
	}

	private validValue(entry: TweakEntry, value: TweakValue): boolean {
		switch (entry.input.type) {
			case 'number':
				return typeof value === 'number' && Number.isFinite(value)
			case 'boolean':
				return typeof value === 'boolean'
			case 'string':
				return typeof value === 'string'
			case 'color':
				return (
					typeof value === 'string' &&
					/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
				)
			case 'select':
				return (
					(typeof value === 'string' || typeof value === 'number') &&
					(entry.input.options as readonly (string | number)[]).includes(value)
				)
		}
	}

	private stateMessage(): ServerToPanel {
		const entries: PanelEntry[] = []
		for (const [id, clients] of this.mountedBy) {
			if (!clients.size) continue
			// Style sites mount through the same table but render under styles.
			if (this.deps.getStyleEntry?.(id)) continue
			const entry = this.deps.getEntry(id)
			const override = this.overrides.get(id) ?? null
			const base: TweakEntry =
				entry ??
				// Mounted but not in the manifest (e.g. transformed before this
				// server saw the file): synthesize a read-only row from the id.
				{
					id,
					file: id.split('#')[0],
					name: id.split('#')[1] ?? id,
					group: null,
					input: { type: 'string' },
					value: null,
					writable: false,
					reason: 'entry not in manifest',
				}
			entries.push({
				...base,
				runtimeValue: this.runtimeValues.get(id) ?? (base.value as TweakValue) ?? '',
				override,
				dirty: override !== null && override !== base.value,
				mountedBy: [...clients],
			})
		}
		const styles: PanelStyleEntry[] = []
		for (const id of [...this.mountedBy.keys()]) {
			const entry = this.deps.getStyleEntry(id)
			if (!entry) continue
			const draft = this.styleDrafts.get(id) ?? { set: {}, delete: [] }
			styles.push({
				...entry,
				draft,
				dirty: this.isStyleDirty(id),
				mountedBy: [...(this.mountedBy.get(id) ?? [])],
				preview: entry.kind === 'bamboo' && this.stylePreviewFailed.has(id) ? 'unavailable' : 'live',
			})
		}
		const unmountedDirty: UnmountedDirtyEntry[] = []
		for (const id of [...this.styleDrafts.keys()]) {
			if (this.mountedBy.get(id)?.size) continue
			if (!this.isStyleDirty(id)) continue
			const entry = this.deps.getStyleEntry(id)
			if (!entry) continue
			unmountedDirty.push({
				id,
				kind: 'style',
				file: entry.file,
				name: entry.label,
				group: null,
				override: JSON.stringify(this.styleDrafts.get(id)),
				value: null,
			})
		}
		for (const [id, override] of this.overrides) {
			if (this.mountedBy.get(id)?.size) continue
			if (!this.isDirty(id)) continue
			const entry = this.deps.getEntry(id)
			unmountedDirty.push({
				id,
				kind: 'tweak',
				file: entry?.file ?? id.split('#')[0],
				name: entry?.name ?? id.split('#')[1] ?? id,
				group: entry?.group ?? null,
				override,
				value: entry?.value ?? null,
			})
		}
		return {
			type: 'state',
			server: { name: this.deps.name, root: this.deps.root },
			clients: [...this.sockets]
				.filter((s) => s.role === 'app')
				.map((s) => ({ clientId: s.clientId, label: s.label })),
			entries,
			unmountedDirty,
			styles,
			picking: this.picking,
		}
	}

	private sendTo(socket: Socket, message: ServerToApp | ServerToPanel) {
		try {
			socket.ws.send(JSON.stringify(message))
		} catch {
			// ignore dead sockets
		}
	}

	private async buildStyleValues(): Promise<ServerToAppStyles> {
		const styles: ServerToAppStyles = {}
		for (const [id, draft] of this.styleDrafts) {
			const entry = this.deps.getStyleEntry(id)
			if (entry?.kind === 'inline') {
				styles[id] = { kind: 'inline', set: draft.set, delete: draft.delete }
			} else if (entry?.kind === 'bamboo' && this.deps.compileStyle) {
				const compiled = this.styleCompiled.get(id)
				if (compiled && JSON.stringify(compiled) !== '__stale__') {
					styles[id] = { kind: 'bamboo', className: compiled.className, css: compiled.css }
				}
			}
		}
		return styles
	}

	// Compile dirty bamboo drafts before broadcasting so values carries
	// {className, css}; a failure marks the site's preview 'unavailable'.
	private async refreshStyleCompiles() {
		if (!this.deps.compileStyle) return
		for (const [id, draft] of this.styleDrafts) {
			const entry = this.deps.getStyleEntry(id)
			if (entry?.kind !== 'bamboo') continue
			const sig = JSON.stringify(draft)
			const cached = this.styleCompiledSig.get(id)
			if (cached === sig) continue
			const result = await this.deps.compileStyle(id, draft)
			if (result) {
				this.styleCompiled.set(id, result)
				this.styleCompiledSig.set(id, sig)
				this.stylePreviewFailed.delete(id)
			} else {
				this.stylePreviewFailed.add(id)
			}
		}
	}
	private styleCompiledSig = new Map<string, string>()

	private asyncBroadcastValues() {
		void this.buildStyleValues().then((styles) => {
			const message: ServerToApp = {
				type: 'values',
				values: Object.fromEntries(this.overrides),
				styles,
			}
			for (const socket of this.sockets) {
				if (socket.role === 'app') this.sendTo(socket, message)
			}
		})
	}

	private broadcastState() {
		const message = this.stateMessage()
		for (const socket of this.sockets) {
			if (socket.role === 'panel') this.sendTo(socket, message)
		}
	}

	close() {
		for (const socket of this.sockets) socket.ws.close()
		this.wss.close()
	}
}
