// pnpm's hoisted linker puts dependencies in the workspace-root node_modules,
// but @octane-xplat/cli's macOS packaging resolves `app/node_modules/{vite,
// octane,@nativescript/macos-node-api}` literally (framework gap — the
// official consumer template mandates nodeLinker: hoisted). Materialize the
// three paths as symlinks so doctor/build/dev work on the supported layout.
import { existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = dirname(fileURLToPath(import.meta.url))
const names = ['vite', 'octane', '@nativescript/macos-node-api']
for (const name of names) {
	const target = join(app, '..', '..', 'node_modules', name)
	const link = join(app, 'node_modules', name)
	if (existsSync(link)) continue
	if (!existsSync(join(target, 'package.json'))) continue
	mkdirSync(dirname(link), { recursive: true })
	symlinkSync(target, link, 'dir')
}
// Ensure a readable package.json through the link (CLI stat checks).
for (const name of names) {
	try {
		readFileSync(join(app, 'node_modules', name, 'package.json'), 'utf8')
	} catch (e) {
		console.warn(`[link-host-deps] ${name} link unreadable: ${e.message}`)
	}
}
