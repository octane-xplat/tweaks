// `pnpm dev` — runs `xplat dev macos`, passing XPLAT_MASON_LIB at the checkout's
// prebuilt libxplatmason.dylib when it exists (dev only). Published
// @octane-xplat/macos-renderer@0.17.1 does not ship the dylib, and its loader
// only checks XPLAT_MASON_LIB + monorepo cwd paths — so without this, masonview
// lays out nothing. See README → Upstream limitations.
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = dirname(fileURLToPath(import.meta.url))
const dylib = join(app, '..', '..', 'links', 'octane-xplat', 'packages', 'macos-renderer', 'native', 'xplatmason', 'libxplatmason.dylib')
const env = { ...process.env }
if (existsSync(dylib)) {
	env.XPLAT_MASON_LIB = dylib
	console.log(`[dev-macos] XPLAT_MASON_LIB=${dylib}`)
} else {
	console.warn('[dev-macos] libxplatmason.dylib not found — layout will be empty. Link the checkout at links/octane-xplat.')
}
const child = spawn('xplat', ['dev', 'macos'], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 1))
