export const TWEAKS_PROTOCOL_VERSION = 3
export const TWEAKS_PATH = '/__octane_tweaks'
// Connect: ws://host:port/__octane_tweaks?token=<t>&role=app|panel&clientId=<uuid>&label=<web|ios|...>
// Wrong/missing token → reject the upgrade with 401.

export type TweakValue = number | string | boolean

export type TweakInput =
	| { type: 'number'; min?: number; max?: number; step?: number } // panel shows slider when min & max given
	| { type: 'boolean' }
	| { type: 'string' }
	| { type: 'color' } // hex string
	| { type: 'select'; options: readonly (string | number)[] }

export interface TweakOptions {
	name?: string
	group?: string
	input?: TweakInput
}

export interface TweakEntry {
	id: string // `${posixFileRelativeToViteRoot}#${group ? group + '/' : ''}${name}`
	file: string // posix, relative to Vite root
	name: string
	group: string | null
	input: TweakInput // explicit, else inferred
	value: TweakValue | null // current SOURCE literal; null when the value arg isn't a literal
	writable: boolean
	reason?: string // why not writable
}

export interface PanelEntry extends TweakEntry {
	runtimeValue: TweakValue // value reported by the first mounting client
	override: TweakValue | null // what apps currently receive
	dirty: boolean // override !== null && override !== value
	mountedBy: string[] // clientIds
}

export type AppToServer =
	| { type: 'mount'; mounts: { id: string; value: TweakValue }[] }
	| { type: 'unmount'; ids: string[] }
	// Click-to-pick result: mounted style-site ids under the pointer,
	// innermost element first; [] = cancelled with Escape.
	| { type: 'picked'; ids: string[] }

export type ServerToApp =
	| {
			type: 'values'
			values: Record<string, TweakValue>
			styles?: ServerToAppStyles
	  }
	| { type: 'pick'; active: boolean }

export type PanelToServer =
	| { type: 'set'; id: string; value: TweakValue }
	| { type: 'styleSet'; id: string; path: string[]; value: StyleValue }
	| { type: 'styleDelete'; id: string; path: string[] }
	| { type: 'revert'; ids?: string[] } // omitted = all dirty
	| { type: 'save' }
	| { type: 'pick'; active: boolean }

export interface UnmountedDirtyEntry {
	id: string
	kind: 'tweak' | 'style'
	file: string
	name: string
	group: string | null
	override: TweakValue
	value: TweakValue | null
}

// -- Styles ----------------------------------------------------------------
export type StyleValue = string | number
export interface StyleProperty {
	path: string[]
	value: StyleValue | null
	editable: boolean
}
export interface StyleEntry {
	id: string
	kind: 'bamboo' | 'inline'
	file: string
	line: number
	label: string
	properties: StyleProperty[]
	writable: boolean
	reason?: string
}
export interface StyleDraft {
	set: Record<string, StyleValue>
	delete: string[] // keys = path.join('.')
}
export interface PanelStyleEntry extends StyleEntry {
	draft: StyleDraft
	dirty: boolean
	mountedBy: string[]
	preview: 'live' | 'unavailable'
}
export type ServerToAppStyles = Record<
	string,
	| { kind: 'inline'; set: Record<string, StyleValue>; delete: string[] }
	| { kind: 'bamboo'; className: string; css: string }
>

export type ServerToPanel =
	| {
			type: 'state'
			server: { name: string; root: string }
			clients: { clientId: string; label: string }[]
			entries: PanelEntry[] // ONLY entries with ≥1 mounting client
			// Dirty overrides whose component is currently unmounted — Save still
			// writes these, so panels must show them.
			unmountedDirty: UnmountedDirtyEntry[]
			// Mounted style sites only (bamboo + inline).
			styles: PanelStyleEntry[]
			// A click-to-pick is in progress on connected apps.
			picking: boolean
	  }
	| {
			type: 'saveResult'
			ok: boolean
			saved: string[]
			errors: { id?: string; file: string; message: string }[]
	  }
	| { type: 'picked'; clientId: string; ids: string[] }
