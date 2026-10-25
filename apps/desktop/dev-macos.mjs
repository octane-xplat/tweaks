// `pnpm dev` — runs `xplat dev macos`. Under a linked checkout (`pnpm
// dev:octane`) the renderer declares the dylib via xplat.macos.prebuiltLibraries
// and the CLI bootstrap dlopens it itself — XPLAT_MASON_LIB is unused. Published
// @octane-xplat/macos-renderer@0.17.1 does not ship the dylib, and its loader
// only checks XPLAT_MASON_LIB + monorepo cwd paths — so pass the checkout's
// prebuilt copy when it exists (dev only); without it masonview lays out
// nothing under published packages. See README → Upstream limitations.
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = dirname(fileURLToPath(import.meta.url))
const dylib = [
	// Current checkout layout.
	join(app, '..', '..', 'links', 'octane-xplat', 'packages', 'macos-renderer', 'platforms', 'macos', 'prebuilt', 'libxplatmason.dylib'),
	// Older checkouts kept the dylib under native/xplatmason.
	join(app, '..', '..', 'links', 'octane-xplat', 'packages', 'macos-renderer', 'native', 'xplatmason', 'libxplatmason.dylib'),
].find(existsSync)
const env = { ...process.env }
if (dylib) {
	env.XPLAT_MASON_LIB = dylib
	console.log(`[dev-macos] XPLAT_MASON_LIB=${dylib}`)
} else {
	console.warn('[dev-macos] libxplatmason.dylib not found — layout will be empty under published packages. Link the checkout at links/octane-xplat.')
}
const child = spawn('xplat', ['dev', 'macos'], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 1))
