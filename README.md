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
