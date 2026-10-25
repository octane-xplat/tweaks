import type {
	PanelEntry,
	PanelStyleEntry,
	StyleValue,
	PanelToServer,
	ServerToPanel,
	TweakInput,
	TweakValue,
	UnmountedDirtyEntry,
} from '@octane-xplat/tweaks/protocol'

// Mirrors TWEAKS_PATH — see packages/tweaks/src/vite/server.ts for why it is not
// imported at runtime across host boundaries.
export const TWEAKS_PATH = '/__octane_tweaks'
export const CLIENT_LABEL = 'desktop'
export const HEX_COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export interface PanelServerInfo {
	url: string // ws://host:port/__octane_tweaks
	token: string
	name: string
	root: string
	pid?: number
	reachable?: boolean
}

// Servers are identified by their connection identity — a restart of the same
// app produces a new port+token (a different server for our purposes), while
// two dev servers for one app share a name.
export function serverKey(s: PanelServerInfo): string {
	return `${s.url} ${s.token}`
}
// Display label: app name plus its port so same-name servers are distinct.
export function serverLabel(s: PanelServerInfo): string {
	return `${s.name} — :${s.url.split(':').pop()?.split('/')[0] ?? '?'}`
}

export interface Transport {
	send(data: string): void
	close(): void
	onopen: (() => void) | null
	onmessage: ((data: string) => void) | null
	onclose: (() => void) | null
}

export type TransportFactory = (url: string) => Transport | null

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

export interface SavePreview {
	files: { file: string; diff: string }[]
	truncated: boolean
	errors: { id?: string; file: string; message: string }[]
}

export interface PanelSnapshot {
	status: ConnectionStatus
	clients: { clientId: string; label: string }[]
	entries: PanelEntry[]
	styles: PanelStyleEntry[]
	unmountedDirty: UnmountedDirtyEntry[]
	saving: boolean
	saveResult: { ok: boolean; saved: string[]; errors: { id?: string; file: string; message: string }[] } | null
	preview: SavePreview | null
	previewing: boolean
	// Drafts changed on the server after the preview was computed — Confirm is
	// disabled until a fresh preview is requested.
	previewStale: boolean
	serverName: string | null
	serverRoot: string | null
	picking: boolean
}

// Pure panel model: connection state, the latest server `state` message,
// input→send validation, reconnect bookkeeping, save-result tracking. No UI,
// no host APIs — unit-testable under plain node.
export class PanelModel {
	private listeners = new Set<() => void>()
	private transport: Transport | null = null
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private retries = 0
	private server: PanelServerInfo | null = null
	private clientId: string
	private label: string

	status: ConnectionStatus = 'idle'
	clients: PanelSnapshot['clients'] = []
	entries: PanelEntry[] = []
	styles: PanelStyleEntry[] = []
	unmountedDirty: UnmountedDirtyEntry[] = []
	picking = false
	// ids from the last picked message; null = no filter ([] cancel keeps null).
	pickFilter: string[] | null = null
	saving = false
	saveResult: PanelSnapshot['saveResult'] = null
	preview: SavePreview | null = null
	previewing = false
	previewStale = false
	private previewFingerprint = ''
	serverName: string | null = null
	serverRoot: string | null = null
	// The identity we connected to — survives a `server` rename.
	connectedKey: string | null = null

	private factory: TransportFactory

	constructor(factory: TransportFactory, opts: { clientId?: string; label?: string } = {}) {
		this.factory = factory
		this.clientId = opts.clientId ?? `panel-${Math.random().toString(36).slice(2)}`
		this.label = opts.label ?? CLIENT_LABEL
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private notify() {
		for (const l of this.listeners) l()
	}

	snapshot(): PanelSnapshot {
		return {
			status: this.status,
			clients: this.clients,
			entries: this.entries,
			styles: this.styles,
			unmountedDirty: this.unmountedDirty,
			saving: this.saving,
			picking: this.picking,
			saveResult: this.saveResult,
			preview: this.preview,
			previewing: this.previewing,
			previewStale: this.previewStale,
			serverName: this.serverName,
			serverRoot: this.serverRoot,
		}
	}

	connect(server: PanelServerInfo) {
		this.server = server
		this.connectedKey = serverKey(server)
		this.retryTimer !== null && clearTimeout(this.retryTimer)
		this.retries = 0
		this.open()
	}

	// Poll-driven connection policy: keep the connected entry while its key is
	// still listed; otherwise prefer the entry sharing the current root (same
	// app restarted → new port+token), else the first entry. Returns the chosen
	// server (or null when the list is empty).
	syncServers(list: PanelServerInfo[]): PanelServerInfo | null {
		if (!list.length) return null
		const current = list.find((s) => serverKey(s) === this.connectedKey)
		if (current) return current
		const sameRoot = list.find((s) => this.serverRoot && s.root === this.serverRoot)
		const next = sameRoot ?? list[0]
		this.connect(next)
		return next
	}

	disconnect() {
		this.server = null
		this.connectedKey = null
		this.retryTimer !== null && clearTimeout(this.retryTimer)
		this.transport?.close()
		this.transport = null
		this.status = 'idle'
		this.notify()
	}

	private open() {
		const server = this.server
		if (!server) return
		const sep = server.url.includes('?') ? '&' : '?'
		const url = `${server.url}${sep}token=${encodeURIComponent(server.token)}&role=panel&clientId=${this.clientId}&label=${this.label}`
		this.status = 'connecting'
		this.notify()
		const t = this.factory(url)
		if (!t) {
			this.status = 'disconnected'
			this.scheduleRetry()
			return
		}
		this.transport = t
		t.onopen = () => {
			this.status = 'connected'
			this.retries = 0
			this.notify()
		}
		t.onmessage = (data) => this.onServerMessage(data)
		t.onclose = () => {
			this.transport = null
			if (this.server) {
				this.status = 'disconnected'
				this.notify()
				this.scheduleRetry()
			}
		}
	}

	private scheduleRetry() {
		if (!this.server) return
		// Backoff 1s → 5s cap (same contract as the app client).
		const delay = Math.min(1000 * 2 ** this.retries++, 5000)
		this.retryTimer = setTimeout(() => this.open(), delay)
	}

	private onServerMessage(data: string) {
		let message: ServerToPanel
		try {
			message = JSON.parse(data)
		} catch {
			return
		}
		if (message.type === 'picked') {
			this.pickFilter = message.ids.length ? message.ids : null
			this.notify()
			return
		}
		if (message.type === 'state') {
			this.serverName = message.server.name
			this.serverRoot = message.server.root
			this.clients = message.clients
			this.entries = message.entries
			this.styles = message.styles ?? []
			this.unmountedDirty = message.unmountedDirty ?? []
			this.picking = message.picking ?? false
			// Prune filter ids whose site is no longer mounted.
			if (this.pickFilter) {
				const mounted = new Set(this.styles.map((s) => s.id))
				this.pickFilter = this.pickFilter.filter((id) => mounted.has(id))
				if (!this.pickFilter.length) this.pickFilter = null
			}
			if (this.preview && this.dirtyFingerprint() !== this.previewFingerprint) {
				this.previewStale = true
			}
			this.notify()
		} else if (message.type === 'saveResult') {
			this.saving = false
			this.saveResult = { ok: message.ok, saved: message.saved, errors: message.errors }
			this.notify()
		} else if (message.type === 'savePreview') {
			this.previewing = false
			// A late response racing a Confirm must not reopen the view.
			if (this.saving) {
				this.notify()
				return
			}
			this.preview = {
				files: message.files ?? [],
				truncated: message.truncated ?? false,
				errors: message.errors ?? [],
			}
			this.previewStale = this.dirtyFingerprint() !== this.previewFingerprint
			this.notify()
		}
	}

	private send(message: PanelToServer) {
		this.transport?.send(JSON.stringify(message))
	}

	// True when `value` is a legal payload for the entry's input type.
	validValue(entry: PanelEntry, value: TweakValue): boolean {
		return validateForInput(entry.input, value)
	}

	set(id: string, value: TweakValue): boolean {
		const entry = this.entries.find((e) => e.id === id)
		if (!entry || !this.validValue(entry, value)) return false
		this.send({ type: 'set', id, value })
		return true
	}

	revert(id: string) {
		this.send({ type: 'revert', ids: [id] })
	}

	revertAll() {
		this.send({ type: 'revert' })
	}

	save() {
		if (this.saving || this.dirtyCount() === 0) return
		this.saving = true
		this.send({ type: 'save' })
		this.notify()
	}

	// Default Save flow: ask the server for the planned diff. `save()` stays
	// the one-shot path for callers that skip the preview.
	requestPreview() {
		if (this.previewing || this.saving || this.dirtyCount() === 0) return
		this.previewing = true
		this.previewStale = false
		this.previewFingerprint = this.dirtyFingerprint()
		this.send({ type: 'savePreview' })
		this.notify()
	}

	cancelPreview() {
		this.preview = null
		this.previewStale = false
		this.notify()
	}

	// Confirm the previewed plan: run the existing save. Refuses a stale
	// preview — drafts changed since it was computed.
	confirmSave() {
		if (!this.preview || this.previewStale || this.saving) return
		this.preview = null
		this.save()
	}

	// What the preview was computed against: every override/draft the panel
	// knows about. Compared on later state messages to flag a stale preview.
	private dirtyFingerprint(): string {
		return JSON.stringify({
			overrides: this.entries.map((e) => [e.id, e.override]),
			styles: this.styles.map((s) => [s.id, s.draft]),
			unmounted: this.unmountedDirty.map((u) => [u.id, u.override]),
		})
	}

	pick(active: boolean) {
		this.send({ type: 'pick', active })
	}
	clearPickFilter() {
		this.pickFilter = null
		this.notify()
	}

	dirtyCount(): number {
		return (
			this.entries.filter((e) => e.dirty).length +
			this.styles.filter((e) => e.dirty).length +
			this.unmountedDirty.length
		)
	}

	// ---- Style sites ---------------------------------------------------------

	// The value a property row shows: draft override, else the source literal.
	stylePropValue(site: PanelStyleEntry, path: string[]): StyleValue | null {
		const key = path.join('.')
		if (key in site.draft.set) return site.draft.set[key]
		return site.properties.find((p) => p.path.join('.') === key)?.value ?? null
	}

	// Draft-deleted paths (for the struck "deleted" display).
	stylePropDeleted(site: PanelStyleEntry, path: string[]): boolean {
		return site.draft.delete.includes(path.join('.'))
	}

	// Draft-added paths not present in the source properties.
	styleAddedPaths(site: PanelStyleEntry): string[] {
		const have = new Set(site.properties.map((p) => p.path.join('.')))
		return Object.keys(site.draft.set).filter((k) => !have.has(k))
	}

	styleSet(id: string, path: string[], text: string): boolean {
		const site = this.styles.find((e) => e.id === id)
		if (!site || !site.writable || !path.length || path.some((p) => !p)) return false
		const original = site.properties.find((p) => p.path.join('.') === path.join('.'))
		// Numbers stay numbers when the source was numeric and the text parses.
		const parsed = Number(text)
		const value: StyleValue =
			typeof original?.value === 'number' && Number.isFinite(parsed)
				? parsed
				: text
		this.send({ type: 'styleSet', id, path, value })
		return true
	}

	styleDelete(id: string, path: string[]) {
		this.send({ type: 'styleDelete', id, path })
	}

	// Undo a draft-deleted row: re-set the original literal.
	styleRestore(id: string, path: string[]) {
		const site = this.styles.find((e) => e.id === id)
		const original = site?.properties.find((p) => p.path.join('.') === path.join('.'))
		if (original?.value != null) {
			this.send({ type: 'styleSet', id, path, value: original.value })
		}
	}

	// Add-property name validation: non-empty segments; inline sites are flat.
	styleAddNameValid(site: PanelStyleEntry, name: string): boolean {
		if (!name.trim()) return false
		const segs = name.split('.')
		if (segs.some((p) => !p.trim())) return false
		if (site.kind === 'inline' && segs.length !== 1) return false
		return true
	}

	styleAdd(site: PanelStyleEntry, name: string, text: string) {
		if (!this.styleAddNameValid(site, name)) return false
		return this.styleSet(site.id, name.trim().split('.'), text)
	}

	// Style sites grouped by file for the Styles section; a pick filter
	// narrows the list to the picked ids (in picked order).
	groupedStyles(): { file: string; sites: PanelStyleEntry[] }[] {
		const order = this.pickFilter ? new Map(this.pickFilter.map((id, i) => [id, i])) : null
		const styles = order
			? order.size
				? [...this.styles]
						.filter((s) => order.has(s.id))
						.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
				: []
			: this.styles
		const groups = new Map<string, PanelStyleEntry[]>()
		for (const site of styles) {
			let list = groups.get(site.file)
			if (!list) groups.set(site.file, (list = []))
			list.push(site)
		}
		return [...groups].map(([file, sites]) => ({ file, sites }))
	}

	// Grouped + ordered for display: group name first, then entry name.
	groupedEntries(): { group: string; entries: PanelEntry[] }[] {
		const groups = new Map<string, PanelEntry[]>()
		const sorted = [...this.entries].sort((a, b) => {
			const ga = a.group ?? ''
			const gb = b.group ?? ''
			return ga === gb ? a.name.localeCompare(b.name) : ga.localeCompare(gb)
		})
		for (const entry of sorted) {
			const key = entry.group ?? 'General'
			let list = groups.get(key)
			if (!list) groups.set(key, (list = []))
			list.push(entry)
		}
		return [...groups].map(([group, entries]) => ({ group, entries }))
	}
}

export function validateForInput(input: TweakInput, value: TweakValue): boolean {
	switch (input.type) {
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
		case 'boolean':
			return typeof value === 'boolean'
		case 'string':
			return typeof value === 'string'
		case 'color':
			return typeof value === 'string' && HEX_COLOR_RE.test(value)
		case 'select':
			return (
				(typeof value === 'string' || typeof value === 'number') &&
				input.options.includes(value)
			)
	}
}

// The value a control displays: live override, then the source literal, then
// the last runtime value.
export function displayValue(entry: PanelEntry): TweakValue {
	return entry.override ?? entry.value ?? entry.runtimeValue
}
