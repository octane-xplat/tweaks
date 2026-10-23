import fs from 'node:fs'
import path from 'node:path'
import { createFilter, type Plugin, type ViteDevServer } from 'vite'
import MagicString from 'magic-string'
import type { TweakEntry } from '@octane-xplat/tweaks/protocol'
import { extract, type ExtractedTweak } from './extract.ts'
import { extractStyles, type StyleSite } from './styles.ts'
import { compileBambooObject } from './bamboo.ts'
import { contentHash, newToken, removeRegistry, sweepRegistry, writeRegistry } from './registry.ts'
import { saveOverrides } from './save.ts'
import { TweaksServer } from './server.ts'

// Mirrors TWEAKS_PATH — see server.ts for why it is not imported at runtime.
const TWEAKS_PATH = '/__octane_tweaks'

const SOURCE_RE = /\.(ts|tsx|tsrx)$/

export interface TweaksPluginOptions {
	bambooCssModules?: RegExp
	/** Picomatch-style globs for files to instrument. Defaults to all .ts/.tsx/.tsrx under root. */
	include?: string[]
	exclude?: string[]
}

interface ManifestSlot {
	entry: TweakEntry
	tweak: ExtractedTweak
}

/**
 * Vite plugin for `@octane-xplat/tweaks`. Place it BEFORE the Octane plugins.
 *
 * - dev: injects each `useTweak` call's entry id as a hidden third argument,
 *   serves the `TWEAKS_PATH` websocket (role=app|panel, token-gated), and on
 *   panel `save` writes overrides back into source literals.
 * - production build: replaces `useTweak(a, ...)` with `(a)` and removes the
 *   import, so no tweaks code or metadata reaches the bundle.
 */
export function tweaks(options: TweaksPluginOptions = {}): Plugin {
	let root = process.cwd()
	let command: 'build' | 'serve' = 'serve'
	let isProduction = false
	let serverName = 'app'
	let fallbackOrigin = ''
	const token = newToken()
	// id → manifest slot. Ranges always refer to the file on disk.
	const manifest = new Map<string, ManifestSlot>()
	const styleManifest = new Map<string, StyleSite>()
	// absPath → sha256 of content the plugin itself wrote (HMR suppression).
	const writtenFiles = new Map<string, string>()
	let hub: TweaksServer | null = null
	let filter: (id: string) => boolean = () => true

	const toRel = (abs: string) => path.relative(root, abs).split(path.sep).join('/')

	function refreshManifestFromDisk(absFile: string): void {
		const file = toRel(absFile)
		for (const [id, slot] of manifest) {
			if (slot.entry.file === file) manifest.delete(id)
		}
		let code: string
		try {
			code = fs.readFileSync(absFile, 'utf8')
		} catch {
			return
		}
		for (const [id] of styleManifest) {
			if (styleManifest.get(id)?.entry.file === file) styleManifest.delete(id)
		}
		for (const site of extractStyles(code, file, { bambooCssModules: options.bambooCssModules }).sites) {
			styleManifest.set(site.entry.id, site)
		}
		for (const tweak of extract(code, file).tweaks) {
			const entry: TweakEntry = {
				id: tweak.id,
				file,
				name: tweak.name,
				group: tweak.group,
				input: tweak.input,
				value: tweak.value,
				writable: tweak.writable,
				reason: tweak.reason,
			}
			manifest.set(tweak.id, { entry, tweak })
		}
	}

	function isDirty(id: string): boolean {
		const override = hub?.overrides.get(id)
		return override !== undefined && override !== (manifest.get(id)?.entry.value ?? null)
	}

	function suppressWritten(file: string) {
		// Keep the record while the hash still matches: the same write can
		// surface as a hotUpdate in multiple environments, and only the first
		// must not consume the suppression. A real user edit produces a
		// different hash — clear the record and let HMR proceed normally.
		const expected = writtenFiles.get(file)
		if (expected === undefined) return
		try {
			if (contentHash(fs.readFileSync(file, 'utf8')) === expected) return []
		} catch {
			return
		}
		writtenFiles.delete(file)
	}

	async function save() {
		const result = await saveOverrides({
			root,
			manifest,
			styleManifest,
			overrides: hub?.overrides ?? new Map(),
			styleDrafts: hub?.styleDrafts ?? new Map(),
			isDirty,
			isStyleDirty: (id) => {
				const d = hub?.styleDrafts.get(id)
				if (!d) return false
				const source = new Map(
					(styleManifest.get(id)?.entry.properties ?? []).map((p) => [p.path.join('.'), p.value]),
				)
				for (const [k, v] of Object.entries(d.set)) {
					if (!source.has(k) || source.get(k) !== v) return true
				}
				for (const k of d.delete) if (source.has(k)) return true
				return false
			},
		})
		// Record what we wrote so the resulting file-change event does not HMR
		// (the running module still holds the old literal; a reload would lose
		// app state and revert the visible value).
		for (const [file, code] of result.writes) {
			writtenFiles.set(path.join(root, file), contentHash(code))
		}
		// Refresh the manifest from the new content: value = saved value, so
		// dirty recomputes to false while overrides stay in place.
		for (const file of result.writes.keys()) {
			refreshManifestFromDisk(path.join(root, file))
		}
		return { ok: result.ok, saved: result.saved, errors: result.errors }
	}

	return {
		name: 'octane-xplat-tweaks',
		enforce: 'pre',
		config(config, env) {
			command = env.command
			if (env.command !== 'serve') return
			// Dev-only connection define. fallbackOrigin is for non-DOM runtimes
			// (native leaves); the web client builds its URL from location.host.
			const port = config.server?.port ?? 5173
			fallbackOrigin = `http://127.0.0.1:${port}`
			return {
				define: {
					__OCTANE_TWEAKS__: JSON.stringify({
						token,
						path: TWEAKS_PATH,
						fallbackOrigin,
					}),
				},
			}
		},
		configResolved(config) {
			root = config.root
			isProduction = config.isProduction
			try {
				serverName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name
			} catch {
				serverName = path.basename(root)
			}
			filter = createFilter(
				options.include ?? ['**/*.{ts,tsx,tsrx}'],
				options.exclude ?? ['**/node_modules/**'],
				{ resolve: root },
			)
		},
		configureServer(server: ViteDevServer) {
			hub = new TweaksServer({
				token,
				root,
				name: serverName,
				getEntry: (id) => manifest.get(id)?.entry,
				getStyleEntry: (id) => styleManifest.get(id)?.entry,
				compileStyle: async (id, draft) => {
					const site = styleManifest.get(id)
					if (!site || site.entry.kind !== 'bamboo') return null
					return await compileBambooObject(root, { properties: site.entry.properties, draft })
				},
				save,
				log: (m) => server.config.logger.info(m),
			})
			server.httpServer?.on('upgrade', hub.handleUpgrade)
			server.httpServer?.once('listening', () => {
				const address = server.httpServer?.address()
				const port = typeof address === 'object' && address ? address.port : server.config.server.port
				// The config-time fallbackOrigin guessed the configured port; now
				// that the socket is real, use the actual one for later transforms.
				fallbackOrigin = `http://127.0.0.1:${port}`
				sweepRegistry()
				// Advertise what the socket actually bound: when it is loopback
				// (127.0.0.1 / ::1) or unspecified, 'localhost' covers whichever
				// address family the server took.
				const bound = address && typeof address === 'object' ? address.address : ''
				const registryHost = bound === '127.0.0.1' || bound === '::1' || bound === '::' || bound === '0.0.0.0' || !bound ? 'localhost' : bound
				writeRegistry({
					version: 1,
					pid: process.pid,
					url: `ws://${registryHost}:${port}${TWEAKS_PATH}`,
					token,
					name: serverName,
					root,
					startedAt: new Date().toISOString(),
				})
				const cleanup = () => {
					removeRegistry()
					hub?.close()
				}
				process.once('exit', cleanup)
				server.httpServer?.once('close', cleanup)
			})
		},
		transform(code, id) {
			const file = id.split('?')[0]
			if (!SOURCE_RE.test(file)) return null
			// Vite 8's dev client pipeline does not apply config.define to these
			// modules, and the package source may live outside root — substitute
			// the connection define directly wherever the marker appears.
			let replaced: string | null = null
			if (command === 'serve' && code.includes('__OCTANE_TWEAKS__')) {
				// Only bare-identifier reads are replaced — a `.`-prefixed
				// occurrence is a member access, where an object literal is a
				// syntax error.
				replaced = code.replace(
					/(^|[^\w$.])__OCTANE_TWEAKS__/g,
					`$1${JSON.stringify({ token, path: TWEAKS_PATH, fallbackOrigin })}`,
				)
			}
			// createFilter's `**` globs also match paths outside root — bound
			// instrumentation to files inside the Vite root explicitly.
			const inRoot = !path.relative(root, file).startsWith('..')
			if (!inRoot || !filter(file)) {
				return replaced === null
					? null
					: { code: replaced, map: null }
			}
			code = replaced ?? code
			const rel = toRel(file)
			const result = extract(code, rel)
			for (const warning of result.warnings) this.warn(warning)
			if (command === 'serve') {
				// Manifest is built from the file on DISK so Save writeback ranges
				// are true source offsets; ids are position-independent, so the
				// transform-time extraction and the disk extraction agree.
				// Refresh even for tweak-free files: removing the last tweak from
				// a file must not leave stale manifest entries behind.
				const hasManifestEntries = [...manifest.values()].some((s) => s.entry.file === rel) || [...styleManifest.values()].some((s) => s.entry.file === rel)
				if (hasManifestEntries || result.tweaks.length || extractStyles(code, rel).sites.length) refreshManifestFromDisk(file)
				const styles = extractStyles(code, rel, { bambooCssModules: options.bambooCssModules })
				if (
					!result.tweaks.length &&
					!result.imports.specifier &&
					!styles.sites.some(
						(x) =>
							(x.entry.kind === 'inline' && x.componentBody) ||
							(x.entry.kind === 'bamboo' && x.call),
					)
				)
					return null
				const s = new MagicString(code)
				for (const tweak of result.tweaks) {
					s.appendLeft(tweak.call.end - 1, `, ${JSON.stringify(tweak.id)}`)
				}
				const bambooWrap = styles.sites.filter((x) => x.entry.kind === 'bamboo' && x.call)
				for (const site of bambooWrap) {
					s.appendLeft(site.call!.start, `__twCss(${JSON.stringify(site.entry.id)}, `)
					s.prependRight(site.call!.end, `)`)
				}
				if (bambooWrap.length) s.prepend(`import { __twCss } from '@octane-xplat/tweaks/dev'\n`)
				const inline = styles.sites.filter((x) => x.entry.kind === 'inline' && x.componentBody)
				if (inline.length) {
					const bodies = new Set<number>()
					for (const site of inline) {
						const body = site.componentBody!
						// tsrx `@{` bodies start at '@' — anchor on the '{' itself.
						const brace = code.indexOf('{', body.start)
						if (!bodies.has(brace)) {
							bodies.add(brace)
							s.appendLeft(brace + 1, `\n\t\tconst __tw = useTweakStyles()`)
						}
						if (site.attribute) {
							s.appendLeft(site.attribute.start + 1, `__tw(${JSON.stringify(site.entry.id)}, `)
							s.prependRight(site.attribute.end - 1, `)`)
						}
					}
					s.prepend(`import { useTweakStyles } from '@octane-xplat/tweaks/dev'\n`)
				}
				return result.tweaks.length || inline.length || bambooWrap.length
					? { code: s.toString(), map: s.generateMap({ hires: true }) }
					: null
			}

			if (!result.tweaks.length && !result.imports.specifier) return null

			if (command === 'build' && isProduction) {
				// Production: strip calls to their literal passthrough and drop the
				// useTweak import — no tweaks code or metadata in the bundle.
				const s = new MagicString(code)
				for (const tweak of result.tweaks) {
					s.overwrite(tweak.call.start, tweak.call.end, `(${tweak.valueText})`)
				}
				const { declaration, specifier } = result.imports
				if (declaration && specifier) {
					const specifiers = (declaration.specifiers as { start: number; end: number }[]) ?? []
					if (specifiers.length <= 1) {
						s.remove(declaration.start, declaration.end)
					} else {
						// Remove the specifier plus one adjacent comma and any
						// whitespace it leaves behind.
						const after = code.indexOf(',', specifier.end)
						const closeBrace = code.indexOf('}', specifier.end)
						if (after !== -1 && (closeBrace === -1 || after < closeBrace)) {
							let end = after + 1
							while (end < code.length && (code[end] === ' ' || code[end] === '\t')) end++
							s.remove(specifier.start, end)
						} else {
							const before = code.lastIndexOf(',', specifier.start)
							s.remove(before === -1 ? specifier.start : before, specifier.end)
						}
					}
				}
				return { code: s.toString(), map: s.generateMap({ hires: true }) }
			}

			// Non-production builds without a dev server (watch builds): leave
			// calls uninstrumented; the runtime returns defaults.
			return null
		},
		// Vite 8 environment API (and handleHotUpdate below for older shapes):
		// files the plugin itself just wrote must not trigger HMR. Any other
		// change to the file (user edit) produces a different hash and updates
		// normally.
		hotUpdate({ file }) {
			return suppressWritten(file)
		},
		handleHotUpdate({ file }: { file: string }) {
			return suppressWritten(file)
		},
	}
}

export default tweaks
