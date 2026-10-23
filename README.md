# Octane Xplat Tweaks

`useTweak` marks a value in an Octane Xplat app as live-tweakable. In
development, a Vite plugin connects running apps to a desktop panel over a
websocket: the panel edits values, apps re-render instantly, and **Save**
writes the overrides back into your source files. Production builds strip the
calls to plain literals — the plugin is an optimization, never required for
correctness.

```tsx
import { useTweak } from '@octane-xplat/tweaks'

export function Card() {
	// panel shows a slider; Save rewrites this literal in the source file
	const radius = useTweak(12, { input: { type: 'number', min: 0, max: 40 } })
	const tint = useTweak('#4477ff', { input: { type: 'color' } })
	return <div style={{ borderRadius: radius, background: tint }} />
}
```

## Try it

```sh
pnpm install
pnpm --filter playground dev
```

The dev server writes a discovery file to
`~/.octane-xplat/tweaks/servers/<pid>.json` so a panel can find the websocket
URL and token. To point the framework packages at a local octane-xplat
checkout instead of the published release, see [links/README.md](links/README.md).

The desktop panel app lives in `apps/desktop` (see its README). It discovers running dev servers from `~/.octane-xplat/tweaks/servers/`, edits entries live, and writes source back only on Save.

## Styles (dev preview)

Static CSS in `css({…})` object literals (Bamboo `styled-system/css`) and JSX
`style={{…}}` object literals are extracted like tweaks: the panel's Styles
section edits literal properties live, and Save splices them back into source
with the same no-HMR transaction.

Supported shapes: string/number literals (incl. negative numbers), nested
condition objects for bamboo (`_hover`, `_web`, …). Read-only: dynamic values,
spreads, computed keys, methods, duplicate keys, `css()` with several args,
inline sites outside an uppercase component. Preview: inline sites work on any
renderer; bamboo preview is **web-only** (native leaf is inert — bamboo sites
don't mount there). When `@bamboocss/node` can't compile a draft the site
shows `Preview unavailable` — Save still works.

## Framework findings (gaps hit while building this)

- `vite:define` doesn't reach the dev client (worked around by transform injection).
- Bamboo's extractor can't parse `.tsrx` — static styles must live in `.ts` files.
- `@octane-xplat/macos-renderer` doesn't package `libxplatmason.dylib` (dev works via `XPLAT_MASON_LIB`; packaged apps lay out empty).
- `NSURLSessionWebSocketTask` bridged metadata missing in the JSC host (hand-rolled WS over `NWConnection`).
- `xplat dev macos` assumes isolated `app/node_modules` while the template uses `nodeLinker: hoisted` (`link-host-deps.mjs` postinstall).
- `Section` defaults to row direction on AppKit (use explicit `VStack`).
- `Badge` with raw string children throws `cannot contain text-only children` on AppKit (wrap in `<Text>`).
- `vx-view` default padding (16px) outranks Bamboo utility layers on web — `p_*`/`padding` utilities don't apply to vx-view elements.
