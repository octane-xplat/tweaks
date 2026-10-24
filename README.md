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

## iOS verification status

Verified on the iPhone simulator: the app client dials `globalThis.__NS_HTTP_ORIGIN__`
(the LAN origin NS publishes for its own HMR socket — also reachable from
physical devices) with the plugin-injected origin as fallback, mounts the
`tweaks` and inline style sites, re-renders on panel `set` (`[tweaks-render]`
in the device log), and restores on `revert`. `styleSet` is verified
server-side (draft accepted + broadcast to the app); on-device application of
inline style drafts is not separately asserted — the shared `__tw` merge path
is proven on web. Android and physical devices unverified.

Consumer requirements on iOS: the app must `import '@valor/nativescript-websockets'`
(already a template dependency) so `globalThis.WebSocket` exists, prepend
`tweaks()` to the resolved `xplatNative` plugin list (see
`fixtures/ios-app/vite.config.native.mts`), and tolerate
`NS_VENDOR_EXCLUDE=@octane-xplat/ui` until the framework vendors src-shipped
packages. Workspace-subdir apps (root-hoisted `node_modules`) do not boot —
see findings.

## Framework findings (gaps hit while building this)

- `vite:define` doesn't reach the dev client (worked around by transform injection).
- Bamboo's extractor can't parse `.tsrx` — static styles must live in `.ts` files.
- `@octane-xplat/macos-renderer` doesn't package `libxplatmason.dylib` (dev works via `XPLAT_MASON_LIB`; packaged apps lay out empty).
- `NSURLSessionWebSocketTask` bridged metadata missing in the JSC host (hand-rolled WS over `NWConnection`).
- `xplat dev macos` assumes isolated `app/node_modules` while the template uses `nodeLinker: hoisted` (`link-host-deps.mjs` postinstall).
- `Section` defaults to row direction on AppKit (use explicit `VStack`).
- `Badge` with raw string children throws `cannot contain text-only children` on AppKit (wrap in `<Text>`).
- `vx-view` default padding (16px) outranks Bamboo utility layers on web — `p_*`/`padding` utilities don't apply to vx-view elements.
- Published `create-octane-xplat@0.17.1` template fails `xplat dev` on iOS: the
  esbuild vendor bundle cannot resolve `@octane-xplat/ui`'s extensionless src/
  imports (160 errors, e.g. `Could not resolve "./useResizable"`), and
  `sourceOnlyDeps()` detection skips ui because its `exports` has a "." key.
  `NS_VENDOR_EXCLUDE=@octane-xplat/ui` (per-module serving) boots cleanly.
- Workspace-subdir apps in a hoisted pnpm workspace can't boot under `xplat
  dev`: `sourceOnlyDeps()` reads `join(cwd,'node_modules',...)` which doesn't
  exist under `apps/<app>`; per-module serving then reaches
  `__octaneUniversalPlan is not a function` at ui `View.tsrx` (the octane
  transform never covers those modules). Evidence: playground run vs stock
  control, `artifacts/ios/dev-session.log`.
- `xplat dev` does not accept `--device` — pass the device target id
  positionally (`xplat dev <UDID>`); `ns` boots simulators via `open
  <DEVELOPER_DIR>/Applications/Simulator.app` which fails when `xcode-select`
  points at a partial Xcode (no sudo → set `DEVELOPER_DIR` per-process and
  pre-boot with `xcrun simctl boot`); dead sessions leave `target_busy` —
  clear with `xplat session end <id>`.
