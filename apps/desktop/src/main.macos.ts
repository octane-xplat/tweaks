// AppKit host entry: creates the panel window, mounts the shared App, and
// terminates when the last window closes. Modeled on the framework's
// apps/macos harness (app-owned startup/windowing).
import '@nativescript/macos-node-api'
import { createMacOSRoot } from '@octane-xplat/macos-renderer'
import {
	NSApplication,
	NSApplicationDelegate,
	NSObject,
	NSWindow,
	NSWindowDelegate,
	NativeClass,
} from '@octane-xplat/platform/macos'

import { writeFileSync } from 'node:fs'
import { App, model } from './App.tsrx'
import { bindWindow } from './window'

class PanelDelegate extends NSObject {
	static ObjCProtocols = [NSApplicationDelegate, NSWindowDelegate]

	static {
		NativeClass(this)
	}

	root: { unmount(): void } | null = null

	applicationShouldTerminateAfterLastWindowClosed() {
		return true
	}

	windowWillClose() {
		try {
			this.root?.unmount()
		} catch (error) {
			console.error('[tweaks-panel] unmount failed', error)
		}
		this.root = null
	}
}

const app = NSApplication.sharedApplication
const delegate = PanelDelegate.new()
app.delegate = delegate

const styleMask =
	(1 << 0) | // titled
	(1 << 1) | // closable
	(1 << 2) | // miniaturizable
	(1 << 3) // resizable

const window = NSWindow.alloc().initWithContentRectStyleMaskBackingDefer(
	{ origin: { x: 200, y: 200 }, size: { width: 380, height: 720 } },
	styleMask,
	2, // NSBackingStoreBuffered
	false,
)

window.title = 'Octane Tweaks'
window.contentMinSize = { width: 380, height: 360 }
window.delegate = delegate
bindWindow(window)

const contentView = window.contentView
const root = createMacOSRoot(contentView)
delegate.root = root
root.render(App as never, {})

window.makeKeyAndOrderFront(app)
app.activateIgnoringOtherApps(true)

// Dev-only self-test: after the first `state`, send a `set` for the first
// number entry through the real transport and log. Once entries are rendered,
// walk the window's NSView tree and dump JSON (class/frame/hidden/text) to a
// file so layout can be asserted without screenshots. Gated by env var.
if (process.env.TWEAKS_PANEL_SELFTEST === '1') {
	const dumpFile = process.env.TWEAKS_PANEL_VIEWDUMP ?? '/tmp/tweaks-desktop-viewtree.json'

	function viewTree(v: any): Record<string, unknown> {
		const f = v.frame ?? { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } }
		const node: Record<string, unknown> = {
			class: String(v.className ?? 'NSView'),
			x: f.origin?.x ?? 0,
			y: f.origin?.y ?? 0,
			w: f.size?.width ?? 0,
			h: f.size?.height ?? 0,
			hidden: Boolean(v.isHidden?.() ?? v.hidden ?? false),
		}
		if (node.class === 'NSScrollView') {
			const document = v.documentView
			const clip = v.contentView
			const range = Math.max(
				0,
				Number(document.frame.size.height) - Number(clip.bounds.size.height),
			)

			const flipped =
				typeof document.isFlipped === 'function' ? document.isFlipped() : document.isFlipped

			node.scroll = {
				range,
				offset: flipped ? Number(clip.bounds.origin.y) : range - Number(clip.bounds.origin.y),
			}
		}
		for (const prop of ['stringValue', 'title', 'label', 'string', 'placeholderString']) {
			try {
				const raw = v[prop]
				const t = typeof raw === 'function' ? raw.call(v) : raw
				if (typeof t === 'string' && t.length) {
					node.text = t
				} else if (t && typeof t === 'object') {
					node.text = String(t)
				}
			} catch {}
		}
		const subs = v.subviews
		if (subs && typeof subs.count === 'number' && subs.count > 0) {
			node.children = []
			for (let i = 0; i < subs.count; i++) {
				try {
					;(node.children as unknown[]).push(viewTree(subs.objectAtIndex(i)))
				} catch {}
			}
		}
		return node
	}

	function dumpViews() {
		try {
			contentView.layoutSubtreeIfNeeded()
			const tree = viewTree(contentView)
			// Optional renderer automation reports actual CSS classes, colors and
			// frames without screenshots. Keep it inside the self-test gate.
			const debug = (
				globalThis as typeof globalThis & { __xplatMacOSDebug?: { inspect(id: string): unknown } }
			).__xplatMacOSDebug

			if (debug) {
				tree.panelStyles = Object.fromEntries(
					[
						'tweaks-panel',
						'panel-scroll',
						'panel-content',
						'control-src/App.tsrx#radius',
						'style-input-src/App.tsrx#style:Details/Text:1-paddingTop',
					].map((id) => {
						try {
							return [id, debug.inspect(id)]
						} catch {
							return [id, null]
						}
					}),
				)
			}

			const json = JSON.stringify(tree)
			writeFileSync(dumpFile, json)
			console.log(`[selftest] viewtree written ${dumpFile} bytes=${json.length}`)
		} catch (e) {
			console.error('[selftest] viewtree dump failed', e)
		}
	}

	let fired = false
	model.subscribe(() => {
		console.log(`[selftest] state: entries=${model.entries.length} dirty=${model.dirtyCount()}`)
		if (!model.entries.length) {
			return
		}
		// Dump once entries are on screen; give the renderer a beat to lay out.
		setTimeout(dumpViews, 1500)
		if (fired) {
			return
		}
		const entry = model.entries.find((e) => e.input.type === 'number')
		if (!entry || entry.input.type !== 'number') {
			return
		}
		fired = true
		const { min, max } = entry.input
		const target = min !== undefined && max !== undefined ? Math.min(max, (min + max) / 2) : 42
		console.log(`[selftest] set ${entry.id} = ${target}`)
		const ok = model.set(entry.id, target)
		console.log(`[selftest] set sent ok=${ok}`)
		// C3: one styleSet for an inline site through the same transport.
		const style = model.styles.find(
			(x) => x.kind === 'inline' && x.properties.some((p) => p.editable),
		)
		if (style) {
			const prop = style.properties.find((p) => p.editable)!
			const v = typeof prop.value === 'number' ? prop.value + 4 : String(prop.value) + 'x'
			console.log(`[selftest] styleSet ${style.id} ${prop.path.join('.')} = ${v}`)
			console.log(`[selftest] styleSet sent ok=${model.styleSet(style.id, prop.path, String(v))}`)
		} else {
			console.log('[selftest] no mounted inline style site to edit')
		}
	})
}
