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

## Add it to your app

```sh
pnpm add -D @octane-xplat/tweaks
```

In your Vite config, put `tweaks()` before the Octane plugins:

```ts
import { tweaks } from '@octane-xplat/tweaks/vite'

export default defineConfig({
	plugins: [tweaks(), octane(), /* … */],
})
```

On **web** that's all — run your dev server, open the panel, tweak values, and
press Save when you're happy.

On **iOS/Android** three extra steps apply:

1. `import '@valor/nativescript-websockets'` once (already a template
   dependency) so `globalThis.WebSocket` exists.
2. Prepend `tweaks()` to the resolved `xplatNative` plugin list — see
   `fixtures/ios-app/vite.config.native.mts` for the exact wiring.
3. Until a framework release ships octane-xplat/octane-xplat@37d238d, run with
   `NS_VENDOR_EXCLUDE=@octane-xplat/ui` — the vendor bundle can't resolve ui's
   source imports.

Production builds replace each `useTweak` call with its literal and drop the
metadata, so nothing ships. Skipping the plugin is also safe — the hook just
returns the default.

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

## Click to pick (web)

The panel's `Pick` button toggles pick mode (`pick {active}` → apps; web only —
native/AppKit ignore it). While picking, the web app shows a crosshair cursor +
an outline over the nearest tagged ancestor of the pointer: bamboo sites via
their `tw_<hash>` marker class, inline sites via a `--tw-site` custom property
the tagged `useTweakStyles` adds. Clicking reports the mounted site ids
(`picked`) and the panel filters its Styles section; `[]` (Escape) cancels.
Picks swallow the click so app handlers don't fire. Limitation: an inline site
is pickable only when its component forwards the `style` object to a DOM
element.

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

Gaps hit while building this. Most are fixed upstream on `main` — marked with
the landing commit (octane-xplat/octane-xplat@SHA); workarounds stay until a
release ships them.

- `vite:define` doesn't reach the dev client (worked around by transform
  injection). Not a bug — dev-mode define delivery is upstream-defined
  behavior, recorded at octane-xplat/octane-xplat@933dc3739. Workaround stays.
- Bamboo's extractor can't parse `.tsrx` — static styles must live in `.ts`
  files. Upstream `@bamboocss` supports `.tsrx` in newer releases; the
  monorepo's pins are being updated.
- `@octane-xplat/macos-renderer` doesn't package `libxplatmason.dylib` (dev
  works via `XPLAT_MASON_LIB`; packaged apps lay out empty).
  Fixed: octane-xplat/octane-xplat@89befaa, octane-xplat/octane-xplat@39d0be0.
- `NSURLSessionWebSocketTask` bridged metadata missing in the JSC host
  (hand-rolled WS over `NWConnection`). Fixed: the host now provides
  `globalThis.WebSocket`, octane-xplat/octane-xplat@124e0ac; follow-up
  octane-xplat/octane-xplat@9dfb15f fixes the re-entrant
  `g_pointerCache` finalization crash exposed by the change.
- `xplat dev macos` assumes isolated `app/node_modules` while the template
  uses `nodeLinker: hoisted` (`link-host-deps.mjs` postinstall).
  Fixed: octane-xplat/octane-xplat@55ebbd6, octane-xplat/octane-xplat@cbc24a0.
- `Section` defaults to row direction on AppKit (use explicit `VStack`) and
  `Badge` with raw string children throws on AppKit (wrap in `<Text>`).
  Fixed: octane-xplat/octane-xplat@d50e8e7.
- Bamboo padding utilities are not overridden by a framework `.vx-view`
  padding rule. Chromium has no such rule; in the playground fixture,
  `card.box`'s own inline `style={{ padding }}` (`useTweak(16)`) wins the
  cascade.
- Published `create-octane-xplat@0.17.1` template fails `xplat dev` on iOS: the
  esbuild vendor bundle cannot resolve `@octane-xplat/ui`'s extensionless src/
  imports (160 errors, e.g. `Could not resolve "./useResizable"`), and
  `sourceOnlyDeps()` detection skips ui because its `exports` has a "." key.
  `NS_VENDOR_EXCLUDE=@octane-xplat/ui` (per-module serving) boots cleanly.
  Fixed: octane-xplat/octane-xplat@37d238d.
- Workspace-subdir apps in a hoisted pnpm workspace can't boot under `xplat
  dev`: `sourceOnlyDeps()` reads `join(cwd,'node_modules',...)` which doesn't
  exist under `apps/<app>`; per-module serving then reaches
  `__octaneUniversalPlan is not a function` at ui `View.tsrx` (the octane
  transform never covers those modules). Evidence: playground run vs stock
  control, `artifacts/ios/dev-session.log`.
  Fixed: octane-xplat/octane-xplat@55ebbd6.
- `xplat dev` does not accept `--device` — pass the device target id
  positionally (`xplat dev <UDID>`); `ns` boots simulators via `open
  <DEVELOPER_DIR>/Applications/Simulator.app` which fails when `xcode-select`
  points at a partial Xcode (no sudo → set `DEVELOPER_DIR` per-process and
  pre-boot with `xcrun simctl boot`); dead sessions leave `target_busy` —
  clear with `xplat session end <id>`.
  Fixed: octane-xplat/octane-xplat@f5fbd4b, octane-xplat/octane-xplat@c9a3dcc.
