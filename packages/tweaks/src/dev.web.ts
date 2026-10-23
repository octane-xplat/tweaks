// Web leaf: inline preview via useTweakStyles (shared impl) plus __twCss for
// bamboo css() sites. __twCss appends a marker class; a MutationObserver tracks
// marked elements as mounted sites and applies override {className, css}.
export { useTweakStyles } from './useTweakStyles'
import { client } from './client'

const MARKER_PREFIX = 'tw_'
const sites = new Map<string, { id: string; classes: string[] }>()
const seen = new Map<string, number>() // marker -> element count
let observer: MutationObserver | null = null

function hash(id: string): string {
	let h = 0x811c9dc5
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, '0')
}

function markerFor(id: string): string {
	return `${MARKER_PREFIX}${hash(id)}`
}

function siteForMarker(marker: string) {
	for (const s of sites.values()) if (markerFor(s.id) === marker) return s
	return null
}

function scan() {
	const now = new Map<string, number>()
	for (const el of document.querySelectorAll(`[class*="${MARKER_PREFIX}"]`)) {
		for (const cls of el.className.split(/\s+/)) {
			if (cls.startsWith(MARKER_PREFIX)) now.set(cls, (now.get(cls) ?? 0) + 1)
		}
	}
	for (const marker of now.keys()) {
		const site = siteForMarker(marker)
		if (site && !seen.has(marker)) client.mountStyle(site.id)
	}
	for (const marker of seen.keys()) {
		if (!now.has(marker)) {
			const site = siteForMarker(marker)
			if (site) client.unmountStyle(site.id)
		}
	}
	seen.clear()
	for (const [m, n] of now) seen.set(m, n)
}

function previewTag(): HTMLStyleElement {
	let el = document.getElementById('octane-tweaks-preview') as HTMLStyleElement | null
	if (!el) {
		el = document.createElement('style')
		el.id = 'octane-tweaks-preview'
		document.head.appendChild(el)
	}
	return el
}

// Guard against our own mutations re-triggering the observer forever.
let applying = false

function applyOverrides() {
	if (applying) return
	applying = true
	try {
		const css: string[] = []
		for (const site of sites.values()) {
			const raw = client.getStyleRaw(site.id)
			const marker = markerFor(site.id)
			for (const el of document.querySelectorAll(`.${marker}`)) {
				const tokens = el.className.split(/\s+/).filter(Boolean)
				if (raw && raw.kind === 'bamboo') {
					// Out: this site's original classes, except ones another tw site
					// on the same element contributes. In: override className tokens.
					const others = [...sites.values()].filter((s) => s.id !== site.id)
					const remove = new Set(
						site.classes.filter((c) => !others.some((s) => s.classes.includes(c))),
					)
					const next = [
						...new Set([
							...tokens.filter((c) => !remove.has(c)),
							...raw.className.split(/\s+/).filter(Boolean),
						]),
					]
					const text = next.join(' ')
					if (el.className !== text) el.className = text
					css.push(raw.css)
				} else {
					// Override gone (revert / dropped): restore missing originals.
					const missing = site.classes.filter((c) => !tokens.includes(c))
					if (missing.length) el.className = [...tokens, ...missing].join(' ')
				}
			}
		}
		const tag = previewTag()
		const text = css.join('\n')
		if (tag.textContent !== text) tag.textContent = text
	} finally {
		applying = false
	}
}

function ensureObserver() {
	if (observer || typeof document === 'undefined') return
	observer = new MutationObserver(() => {
		if (applying) return
		scan()
		applyOverrides()
	})
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['class'],
	})
	scan()
	applyOverrides()
	client.onStyles(() => applyOverrides())
}

export function __twCss(id: string, className: string): string {
	sites.set(id, { id, classes: className.split(/\s+/).filter(Boolean) })
	ensureObserver()
	// Mounting is the observer's job once the marker lands on an element.
	scan()
	return `${className} ${markerFor(id)}`
}
